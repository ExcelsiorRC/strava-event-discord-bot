import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "./helpers.ts";
import {
  refreshStravaToken,
  fetchEventIds,
  fetchEventDetail,
  safeParseIds,
} from "../src/strava.ts";

// Save/restore global fetch
let originalFetch: typeof globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
}

describe("refreshStravaToken", () => {
  afterEach(() => restoreFetch());

  it("returns access token and persists new refresh token", async () => {
    const kv = new MemoryKV();
    await kv.put("strava:refresh_token", "old_refresh");

    mockFetch(async (url: string, init?: RequestInit) => {
      assert.match(url, /strava\.com\/oauth\/token/);
      return new Response(
        JSON.stringify({
          access_token: "new_access_123",
          refresh_token: "rotated_refresh_456",
        }),
        { status: 200 },
      );
    });

    const token = await refreshStravaToken(
      kv as unknown as KVNamespace,
      "client_id",
      "client_secret",
    );
    assert.equal(token, "new_access_123");
    assert.equal(await kv.get("strava:refresh_token"), "rotated_refresh_456");
  });
});

describe("safeParseIds", () => {
  it("extracts normal-sized IDs correctly", () => {
    const text = '[{"id":1546960,"title":"Run"},{"id":1184595,"title":"Hike"}]';
    const ids = safeParseIds(text);
    assert.deepEqual(ids, ["1546960", "1184595"]);
  });

  it("extracts IDs exceeding 2^53 as correct strings", () => {
    // This ID exceeds Number.MAX_SAFE_INTEGER (9007199254740991)
    const bigId = "3482146135682753450";
    const text = `[{"id":${bigId},"resource_state":2,"title":"Big ID Event"}]`;
    const ids = safeParseIds(text);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], bigId);
  });

  it("does not include nested object IDs (club, route, athlete)", () => {
    const text = `[{"id":1111,"resource_state":2,"club":{"id":2328,"name":"Club"},"route":{"id":9999},"title":"Test"}]`;
    const ids = safeParseIds(text);
    // Should only get the top-level event ID
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "1111");
  });
});

describe("fetchEventIds", () => {
  afterEach(() => restoreFetch());

  it("fetches and extracts event IDs as strings", async () => {
    mockFetch(async () => {
      return new Response(
        '[{"id":100,"resource_state":2,"title":"A"},{"id":200,"resource_state":2,"title":"B"}]',
        { status: 200 },
      );
    });

    const ids = await fetchEventIds("token123", "2328");
    assert.deepEqual(ids, ["100", "200"]);
  });
});

describe("fetchEventDetail", () => {
  afterEach(() => restoreFetch());

  it("fetches from API on cache miss and caches result", async () => {
    const kv = new MemoryKV();
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          id: 1546960,
          title: "Morning Run",
          description: "Easy loop",
          women_only: false,
          private: false,
          zone: "America/Los_Angeles",
          address: "Park",
          frequency: "weekly",
          days_of_week: ["tuesday"],
          weekly_interval: 1,
          start_datetime: "2025-06-24T05:45",
          upcoming_occurrences: [],
          organizing_athlete: { firstname: "Jane", lastname: "Doe" },
        }),
        { status: 200 },
      );
    });

    const detail = await fetchEventDetail(
      kv as unknown as KVNamespace,
      "token123",
      "1546960",
    );
    assert.equal(detail.title, "Morning Run");
    assert.equal(detail.id, "1546960");
    assert.equal(fetchCount, 1);

    // Second call should hit cache
    const detail2 = await fetchEventDetail(
      kv as unknown as KVNamespace,
      "token123",
      "1546960",
    );
    assert.equal(detail2.title, "Morning Run");
    assert.equal(fetchCount, 1); // No additional fetch
  });

  it("preserves large event IDs as strings", async () => {
    const kv = new MemoryKV();
    const bigId = "3482146135682753450";

    mockFetch(async () => {
      // Return raw JSON with the large ID as a number (as Strava does)
      return new Response(
        `{"id":${bigId},"title":"Big","description":"","women_only":false,"private":false,"zone":"America/Los_Angeles","address":"","upcoming_occurrences":[],"resource_state":3}`,
        { status: 200 },
      );
    });

    const detail = await fetchEventDetail(
      kv as unknown as KVNamespace,
      "token123",
      bigId,
    );
    assert.equal(detail.id, bigId);
  });
});
