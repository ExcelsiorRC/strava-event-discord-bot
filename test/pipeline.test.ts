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
    PACER_KV: kv as unknown as KVNamespace,
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

  it("posts to Discord for an occurrence in the 25h window", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
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

    // Monday 2026-04-27 06:00 LA = 2026-04-27T13:00:00Z
    const result = await runPipeline(env, {
      nowOverride: "2026-04-27T13:00:00Z",
    });

    assert.equal(result.would_post.length, 1);
    assert.equal(result.skipped_already_posted.length, 0);
    assert.equal(discordCalls.length, 1);
    assert.equal(discordCalls[0].url, "https://discord.test/events");

    // Verify posted key was written
    const posted = await kv.get(
      "posted:test:100:2026-04-28T12:45:00Z",
    );
    assert.equal(posted, "1");
  });

  it("does not re-post for already-posted occurrences", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "initial_refresh");
    // Pre-mark as posted
    await kv.put("posted:test:100:2026-04-28T12:45:00Z", "1");
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

  it("dry run mode does not post or write KV", async () => {
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

    assert.equal(result.would_post.length, 1);
    assert.equal(discordCalls.length, 0);
    // Posted key WAS written
    const posted = await kv.get(
      "posted:test:100:2026-04-28T12:45:00Z",
    );
    assert.equal(posted, "1");
  });
});
