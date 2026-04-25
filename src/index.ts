import { Temporal } from "@js-temporal/polyfill";
import { refreshStravaToken, fetchEventIds, fetchEventDetail } from "./strava.ts";
import { expandOccurrences, type Occurrence } from "./recurrence.ts";
import { buildEmbed, postToDiscord, getWebhookUrl } from "./discord.ts";
import { isAlreadyPosted, markPosted } from "./state.ts";
import type { EventDetail } from "./types.ts";

export interface Env {
  PACER_KV: KVNamespace;
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
    env.PACER_KV,
    env.STRAVA_CLIENT_ID,
    env.STRAVA_CLIENT_SECRET,
  );

  // 2. Discover event IDs
  const eventIds = await fetchEventIds(accessToken, env.STRAVA_CLUB_ID);

  // 3. Fetch details (with caching and rate-limit delay)
  const details: EventDetail[] = [];
  for (const id of eventIds) {
    const detail = await fetchEventDetail(env.PACER_KV, accessToken, id);
    details.push(detail);
    // Small delay between uncached API calls to respect rate limits
    if (!options.dryRun) {
      await sleep(FETCH_DELAY_MS);
    }
  }

  // 4. Expand occurrences and categorize
  const wouldPost: OccurrenceInfo[] = [];
  const skippedAlreadyPosted: OccurrenceInfo[] = [];

  for (const detail of details) {
    const occurrences = expandOccurrences(detail, now);
    for (const occ of occurrences) {
      const info: OccurrenceInfo = { event: detail, occurrence: occ };
      const alreadyPosted = await isAlreadyPosted(
        env.PACER_KV,
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

  // 5. Post to Discord (unless dry run)
  if (!options.dryRun) {
    for (const { event, occurrence } of wouldPost) {
      if (!options.seedMode) {
        const webhookUrl = getWebhookUrl(env, event, mode);
        const embed = buildEmbed(event, occurrence, env.STRAVA_CLUB_URL);
        await postToDiscord(webhookUrl, embed);
      }
      await markPosted(env.PACER_KV, mode, occurrence.eventId, occurrence.isoKey);
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
      const result = await runPipeline(env, { dryRun: true });
      return Response.json({
        would_post: result.would_post.map(summarize),
        skipped_already_posted: result.skipped_already_posted.map(summarize),
        skipped_outside_window: [],
      });
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

function summarize(info: OccurrenceInfo) {
  return {
    eventId: info.occurrence.eventId,
    title: info.event.title,
    when: info.occurrence.isoKey,
  };
}
