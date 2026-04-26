import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "./helpers.ts";
import { runPipeline } from "../src/index.ts";
import type { Env } from "../src/index.ts";

let originalFetch: typeof globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
}

function createEnv(kv: MemoryKV): Env {
  return {
    EVENT_BOT_STATE: kv as unknown as KVNamespace,
    STRAVA_CLIENT_ID: "test_client",
    STRAVA_CLIENT_SECRET: "test_secret",
    STRAVA_CLUB_ID: "9999",
    STRAVA_CLUB_URL: "https://www.strava.com/clubs/test-club",
    MODE: "test",
    SEED_SECRET: "seed123",
    DISCORD_WEBHOOK_EVENTS_TEST: "https://discord.test/events",
    DISCORD_WEBHOOK_LADIES_TEST: "https://discord.test/ladies",
    DISCORD_WEBHOOK_EVENTS_LIVE: "https://discord.live/events",
    DISCORD_WEBHOOK_LADIES_LIVE: "https://discord.live/ladies",
  };
}

// Build a mock Strava API that returns one weekly event happening ~24h from "now"
// "Now" for pipeline tests: we use a fixed Temporal instant via the nowOverride option
// The event: weekly Tuesday at 05:45 LA, starting 2025-06-24
// Test "now": Monday 2026-04-27 06:00 LA = 2026-04-27T13:00:00Z
// Expected occurrence: Tuesday 2026-04-28 05:45 LA = 2026-04-28T12:45:00Z

const LIST_RESPONSE = JSON.stringify([
  { id: 100, resource_state: 2, title: "Weekly Run" },
]);

const DETAIL_RESPONSE = JSON.stringify({
  id: 100,
  resource_state: 3,
  title: "Weekly Run",
  description: "Easy morning run.",
  women_only: false,
  private: false,
  zone: "America/Los_Angeles",
  address: "Park Entrance",
  frequency: "weekly",
  days_of_week: ["tuesday"],
  weekly_interval: 1,
  start_datetime: "2025-06-24T05:45",
  upcoming_occurrences: [],
  organizing_athlete: { firstname: "Jane", lastname: "Doe" },
});

const TOKEN_RESPONSE = JSON.stringify({
  access_token: "test_access",
  refresh_token: "rotated_refresh",
});

describe("runPipeline", () => {
  afterEach(() => restoreFetch());

  it("posts reminder for a known event with occurrence in window", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    await kv.put("seen:test:100", "1"); // already seen
    const env = createEnv(kv);
    const discordCalls: { url: string; body: string }[] = [];

    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      if (url.includes("discord.test")) {
        discordCalls.push({ url, body: init?.body as string });
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runPipeline(env, {
      nowOverride: "2026-04-27T13:00:00Z",
    });

    assert.equal(result.would_post.length, 1);
    assert.equal(discordCalls.length, 1);
    // Should be a reminder, not an announcement
    const body = JSON.parse(discordCalls[0].body);
    assert.ok(!body.embeds[0].title.startsWith("New Event:"));

    const posted = await kv.get("posted:test:100:2026-04-28T12:45:00Z");
    assert.equal(posted, "1");
  });

  it("posts announcement for a newly discovered event", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    // NOT marking as seen — this is a new event
    const env = createEnv(kv);
    const discordCalls: { url: string; body: string }[] = [];

    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      if (url.includes("discord.test")) {
        discordCalls.push({ url, body: init?.body as string });
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runPipeline(env, {
      nowOverride: "2026-04-27T13:00:00Z",
    });

    // Only 1 Discord call: announcement (no separate reminder since just announced)
    assert.equal(discordCalls.length, 1);
    const body = JSON.parse(discordCalls[0].body);
    assert.ok(body.embeds[0].title.startsWith("New Event:"));

    // Event should now be marked as seen
    const seen = await kv.get("seen:test:100");
    assert.equal(seen, "1");

    // Occurrences should be marked as posted (so next run doesn't re-remind)
    const posted = await kv.get("posted:test:100:2026-04-28T12:45:00Z");
    assert.equal(posted, "1");
  });

  it("does not re-post for already-posted occurrences", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    await kv.put("seen:test:100", "1"); // already seen
    await kv.put("posted:test:100:2026-04-28T12:45:00Z", "1"); // already posted
    const env = createEnv(kv);
    const discordCalls: string[] = [];

    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      if (url.includes("discord.test")) {
        discordCalls.push(url);
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runPipeline(env, {
      nowOverride: "2026-04-27T13:00:00Z",
    });

    assert.equal(result.would_post.length, 0);
    assert.equal(result.skipped_already_posted.length, 1);
    assert.equal(discordCalls.length, 0);
  });

  it("caps detail fetches per run; snapshot still written with partial set", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    for (let i = 1; i <= 100; i++) await kv.put(`seen:test:${i}`, "1");
    const env = createEnv(kv);

    let detailFetches = 0;
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const listResponse = JSON.stringify(
      ids.map((id) => ({ id, resource_state: 2, title: `Event ${id}` })),
    );

    mockFetch(async (url: string) => {
      if (url.includes("/oauth/token")) return new Response(TOKEN_RESPONSE, { status: 200 });
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(listResponse, { status: 200 });
      }
      const m = url.match(/group_events\/(\d+)/);
      if (m) {
        detailFetches++;
        return new Response(
          JSON.stringify({
            id: Number(m[1]),
            title: `Event ${m[1]}`,
            description: "",
            women_only: false,
            private: false,
            zone: "America/Los_Angeles",
            address: "",
            upcoming_occurrences: [],
            resource_state: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    await runPipeline(env, { nowOverride: "2026-04-27T13:00:00Z" });

    assert.ok(detailFetches > 0, "should fetch some details");
    assert.ok(
      detailFetches <= 50,
      `expected fetches capped <= 50, got ${detailFetches}`,
    );

    const snapshot = await kv.get("calendar:club:snapshot");
    assert.ok(snapshot, "snapshot must be written even when budget caps fetches");
    const snap = JSON.parse(snapshot!) as { id: string }[];
    assert.equal(snap.length, detailFetches);
  });

  it("uses cached details past the fetch budget without API calls", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    for (let i = 1; i <= 80; i++) {
      await kv.put(`seen:test:${i}`, "1");
      await kv.put(
        `cache:detail:${i}`,
        JSON.stringify({
          id: String(i),
          title: `Cached ${i}`,
          description: "",
          women_only: false,
          private: false,
          zone: "America/Los_Angeles",
          address: "",
          upcoming_occurrences: [],
        }),
      );
    }
    for (let i = 81; i <= 100; i++) await kv.put(`seen:test:${i}`, "1");
    const env = createEnv(kv);

    let detailFetches = 0;
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const listResponse = JSON.stringify(
      ids.map((id) => ({ id, resource_state: 2, title: `E${id}` })),
    );

    mockFetch(async (url: string) => {
      if (url.includes("/oauth/token")) return new Response(TOKEN_RESPONSE, { status: 200 });
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(listResponse, { status: 200 });
      }
      const m = url.match(/group_events\/(\d+)/);
      if (m) {
        detailFetches++;
        return new Response(
          JSON.stringify({
            id: Number(m[1]),
            title: `Fresh ${m[1]}`,
            description: "",
            women_only: false,
            private: false,
            zone: "America/Los_Angeles",
            address: "",
            upcoming_occurrences: [],
            resource_state: 3,
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    await runPipeline(env, { nowOverride: "2026-04-27T13:00:00Z" });

    assert.equal(detailFetches, 20);
    const snap = JSON.parse((await kv.get("calendar:club:snapshot"))!) as unknown[];
    assert.equal(snap.length, 100);
  });

  it("dry run mode does not post or write KV", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    await kv.put("seen:test:100", "1"); // already seen
    const env = createEnv(kv);
    const discordCalls: string[] = [];

    mockFetch(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      if (url.includes("discord.test")) {
        discordCalls.push(url);
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runPipeline(env, {
      dryRun: true,
      nowOverride: "2026-04-27T13:00:00Z",
    });

    assert.equal(result.would_post.length, 1);
    assert.equal(discordCalls.length, 0);
    // No posted key written
    const posted = await kv.get(
      "posted:test:100:2026-04-28T12:45:00Z",
    );
    assert.equal(posted, null);
  });

  it("seed mode writes KV but does not post to Discord", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    const env = createEnv(kv);
    const discordCalls: string[] = [];

    mockFetch(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      if (url.includes("discord.test")) {
        discordCalls.push(url);
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runPipeline(env, {
      seedMode: true,
      nowOverride: "2026-04-27T13:00:00Z",
    });

    assert.equal(discordCalls.length, 0);
    // Posted key WAS written (via justAnnounced path)
    const posted = await kv.get(
      "posted:test:100:2026-04-28T12:45:00Z",
    );
    assert.equal(posted, "1");
    // Event marked as seen
    const seen = await kv.get("seen:test:100");
    assert.equal(seen, "1");
  });

  it("writes a club snapshot to KV after fetching event details", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    await kv.put("seen:test:100", "1");
    const env = createEnv(kv);

    mockFetch(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      if (url.includes("discord.test")) {
        return new Response(null, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    await runPipeline(env, { nowOverride: "2026-04-27T13:00:00Z" });

    const snapshot = await kv.get("calendar:club:snapshot");
    assert.ok(snapshot, "expected snapshot to be written");
    const events = JSON.parse(snapshot!) as { id: string; title: string }[];
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "100");
    assert.equal(events[0].title, "Weekly Run");
  });

  it("dry run does not write snapshot", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    await kv.put("seen:test:100", "1");
    const env = createEnv(kv);

    mockFetch(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return new Response(TOKEN_RESPONSE, { status: 200 });
      }
      if (url.includes("/clubs/") && url.includes("/group_events")) {
        return new Response(LIST_RESPONSE, { status: 200 });
      }
      if (url.includes("/group_events/100")) {
        return new Response(DETAIL_RESPONSE, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    await runPipeline(env, {
      dryRun: true,
      nowOverride: "2026-04-27T13:00:00Z",
    });

    const snapshot = await kv.get("calendar:club:snapshot");
    assert.equal(snapshot, null);
  });
});
