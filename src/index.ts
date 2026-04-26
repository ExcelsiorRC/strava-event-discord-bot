import { Temporal } from "@js-temporal/polyfill";
import {
  refreshStravaToken,
  fetchEventIds,
  fetchEventDetail,
  RateLimitedError,
} from "./strava.ts";
import { expandOccurrences, type Occurrence } from "./recurrence.ts";
import { buildEmbed, buildAnnouncementEmbed, postToDiscord, getWebhookUrl } from "./discord.ts";
import {
  isAlreadyPosted,
  markPosted,
  isEventSeen,
  markEventSeen,
  cacheDetailKey,
} from "./state.ts";
import {
  writeClubSnapshot,
  readClubSnapshot,
  clubEventVEvents,
  buildVCalendar,
  formatNowUtc,
} from "./calendar.ts";
import { fetchExternalIcs, transformExternalIcs } from "./external.ts";
import type { EventDetail } from "./types.ts";

export interface ExternalCalendar {
  token: string;
  name: string;
  url: string;
}

export interface Env {
  EVENT_BOT_STATE: KVNamespace;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_CLUB_ID: string;
  STRAVA_CLUB_URL: string;
  MODE: string;
  SEED_SECRET: string;
  DISCORD_WEBHOOK_EVENTS_TEST: string;
  DISCORD_WEBHOOK_LADIES_TEST: string;
  DISCORD_WEBHOOK_EVENTS_LIVE: string;
  DISCORD_WEBHOOK_LADIES_LIVE: string;
  EXTERNAL_CALENDARS?: ExternalCalendar[];
  CALENDAR_KEY?: string;
}

interface OccurrenceInfo {
  event: EventDetail;
  occurrence: Occurrence;
}

export interface PipelineResult {
  would_post: OccurrenceInfo[];
  skipped_already_posted: OccurrenceInfo[];
  skipped_outside_window: never[]; // kept for API compatibility
}

interface PipelineOptions {
  dryRun?: boolean;
  seedMode?: boolean;
  nowOverride?: string; // ISO instant for testing
}

const FETCH_DELAY_MS = 50;
// Cap API calls per run so each cron tick completes within Worker time limits.
// Cache hits don't count. With this cap the cache fully warms over a few cycles.
const MAX_API_CALLS_PER_RUN = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPipeline(
  env: Env,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const now = options.nowOverride
    ? Temporal.Instant.from(options.nowOverride)
    : Temporal.Now.instant();
  const mode = env.MODE ?? "live";

  // 1. Refresh Strava token
  const accessToken = await refreshStravaToken(
    env.EVENT_BOT_STATE,
    env.STRAVA_CLIENT_ID,
    env.STRAVA_CLIENT_SECRET,
  );

  // 2. Discover event IDs
  const eventIds = await fetchEventIds(accessToken, env.STRAVA_CLUB_ID);

  // 3. Fetch details. Read all cache entries in parallel (sequential KV.gets
  // for hundreds of events can blow the Worker wall-time limit on their own).
  // Then sequentially fetch the uncached ones, capped by the per-run budget so
  // each cron tick finishes. On 429, break with the partial set we have.
  const cachedRaws = await Promise.all(
    eventIds.map((id) => env.EVENT_BOT_STATE.get(cacheDetailKey(id))),
  );
  const details: EventDetail[] = [];
  let apiCalls = 0;
  for (let i = 0; i < eventIds.length; i++) {
    const id = eventIds[i];
    const cached = cachedRaws[i];
    if (cached) {
      details.push(JSON.parse(cached) as EventDetail);
      continue;
    }
    if (apiCalls >= MAX_API_CALLS_PER_RUN) continue;
    let detail: EventDetail;
    try {
      detail = await fetchEventDetail(env.EVENT_BOT_STATE, accessToken, id);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        console.warn(
          `Rate limited at event ${id}, processed ${details.length}/${eventIds.length} so far`,
        );
        break;
      }
      throw e;
    }
    details.push(detail);
    apiCalls++;
    if (!options.dryRun) {
      await sleep(FETCH_DELAY_MS);
    }
  }

  // 3b. Persist snapshot for the calendar feed (skip on dry run)
  if (!options.dryRun) {
    await writeClubSnapshot(env.EVENT_BOT_STATE, details);
  }

  // 4. Announce new events + expand occurrences
  const wouldPost: OccurrenceInfo[] = [];
  const skippedAlreadyPosted: OccurrenceInfo[] = [];

  for (const detail of details) {
    // Check if this is a newly discovered event
    const seen = await isEventSeen(env.EVENT_BOT_STATE, mode, detail.id);
    let justAnnounced = false;

    if (!seen && !options.dryRun) {
      if (!options.seedMode) {
        const webhookUrl = getWebhookUrl(env, detail, mode);
        const embed = buildAnnouncementEmbed(detail, env.STRAVA_CLUB_URL);
        await postToDiscord(webhookUrl, embed);
      }
      await markEventSeen(env.EVENT_BOT_STATE, mode, detail.id);
      justAnnounced = true;
    }

    // Expand occurrences for 24h reminders
    const occurrences = expandOccurrences(detail, now);
    for (const occ of occurrences) {
      const info: OccurrenceInfo = { event: detail, occurrence: occ };

      if (justAnnounced) {
        // Just announced — skip the reminder but mark as posted
        // so the next cron run doesn't re-remind
        await markPosted(env.EVENT_BOT_STATE, mode, occ.eventId, occ.isoKey);
        continue;
      }

      const alreadyPosted = await isAlreadyPosted(
        env.EVENT_BOT_STATE,
        mode,
        occ.eventId,
        occ.isoKey,
      );

      if (alreadyPosted) {
        skippedAlreadyPosted.push(info);
      } else {
        wouldPost.push(info);
      }
    }
  }

  // 5. Post reminders to Discord (unless dry run)
  if (!options.dryRun) {
    for (const { event, occurrence } of wouldPost) {
      if (!options.seedMode) {
        const webhookUrl = getWebhookUrl(env, event, mode);
        const embed = buildEmbed(event, occurrence, env.STRAVA_CLUB_URL);
        await postToDiscord(webhookUrl, embed);
      }
      await markPosted(env.EVENT_BOT_STATE, mode, occurrence.eventId, occurrence.isoKey);
    }
  }

  return {
    would_post: wouldPost,
    skipped_already_posted: skippedAlreadyPosted,
    skipped_outside_window: [],
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/preview") {
      const key = url.searchParams.get("key");
      if (key !== env.SEED_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const result = await runPipeline(env, { dryRun: true });
      return Response.json({
        would_post: result.would_post.map(summarize),
        skipped_already_posted: result.skipped_already_posted.map(summarize),
        skipped_outside_window: [],
      });
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/calendar.ics"
    ) {
      if (
        !env.CALENDAR_KEY ||
        url.searchParams.get("key") !== env.CALENDAR_KEY
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const res = await handleCalendar(env, url);
      return request.method === "HEAD"
        ? new Response(null, { status: res.status, headers: res.headers })
        : res;
    }

    if (request.method === "POST" && url.pathname === "/seed") {
      const key = url.searchParams.get("key");
      if (key !== env.SEED_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const result = await runPipeline(env, { seedMode: true });
      return Response.json({
        seeded: result.would_post.map(summarize),
        already_posted: result.skipped_already_posted.map(summarize),
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
};

async function handleCalendar(env: Env, url: URL): Promise<Response> {
  const externals = env.EXTERNAL_CALENDARS ?? [];
  const allowed = new Set(["club", ...externals.map((e) => e.token)]);

  const raw = url.searchParams.get("include");
  const requested = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...allowed];

  for (const t of requested) {
    if (!allowed.has(t)) {
      return new Response(`unknown include token: ${t}`, { status: 400 });
    }
  }
  const include = new Set(requested);

  const nowUtc = formatNowUtc();
  const veventChunks: string[] = [];
  const vtzChunks: string[] = [];

  if (include.has("club")) {
    const events = await readClubSnapshot(env.EVENT_BOT_STATE);
    for (const event of events) {
      veventChunks.push(
        ...clubEventVEvents(event, { clubUrl: env.STRAVA_CLUB_URL, nowUtc }),
      );
    }
  }

  const externalsToFetch = externals.filter((e) => include.has(e.token));
  const slices = await Promise.all(
    externalsToFetch.map(async (ext) => {
      const text = await fetchExternalIcs(env.EVENT_BOT_STATE, ext.url);
      return transformExternalIcs(text, ext.token);
    }),
  );

  for (const slice of slices) {
    if (slice.vtimezones) vtzChunks.push(slice.vtimezones);
    veventChunks.push(...slice.vevents);
  }

  const body = buildVCalendar({
    vtimezones: vtzChunks.join("\r\n"),
    vevents: veventChunks,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "public, max-age=900",
    },
  });
}

function summarize(info: OccurrenceInfo) {
  return {
    eventId: info.occurrence.eventId,
    title: info.event.title,
    when: info.occurrence.isoKey,
  };
}
