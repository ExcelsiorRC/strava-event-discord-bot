import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "./helpers.ts";
import {
  refreshStravaToken,
  fetchEventIds,
  fetchEvents,
  fetchEventDetail,
  safeParseIds,
  filterRecentEvents,
} from "../src/strava.ts";
import { Temporal } from "@js-temporal/polyfill";

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
    const text = `[{"id":1111,"resource_state":2,"club":{"id":5555,"name":"Club"},"route":{"id":9999},"title":"Test"}]`;
    const ids = safeParseIds(text);
    // Should only get the top-level event ID
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "1111");
  });

  it("handles descriptions containing unbalanced braces without losing events", () => {
    // Real-world failure: a hand-rolled brace counter that doesn't skip string
    // literals loses sync the moment a description contains an unbalanced { or }.
    // Strava descriptions regularly have these (markdown, code snippets, emoji
    // brackets like {kingsalmon}). After that point every subsequent event ID
    // is silently dropped.
    const text = JSON.stringify([
      { id: 100, title: "First" },
      { id: 200, title: "Pep talk", description: "Meet at the {SF State track" },
      { id: 300, title: "Third" },
      { id: 400, title: "Fourth", description: "Run } finish line" },
      { id: 500, title: "Fifth" },
    ]);
    assert.deepEqual(safeParseIds(text), ["100", "200", "300", "400", "500"]);
  });

  it("handles a mix of normal and 19-digit IDs in the same response", () => {
    const text = JSON.stringify([
      { id: 100, title: "Short" },
      { id: "3482146135682753450", title: "Long" }, // already-quoted in fixture
      { id: 200, title: "Short again" },
    ]);
    // Note: real Strava sends the 19-digit ID unquoted as a number; we test
    // both shapes work via JSON.parse path
    assert.deepEqual(safeParseIds(text), ["100", "3482146135682753450", "200"]);
  });

  it("handles unquoted 19-digit IDs from real Strava responses", () => {
    const text = `[{"id":100,"title":"A"},{"id":3482146135682753450,"title":"B"},{"id":200,"title":"C"}]`;
    assert.deepEqual(safeParseIds(text), ["100", "3482146135682753450", "200"]);
  });
});

describe("fetchEvents", () => {
  afterEach(() => restoreFetch());

  it("returns id + upcoming_occurrences for each list item", async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify([
          { id: 100, title: "A", upcoming_occurrences: ["2026-05-01T10:00:00Z"] },
          { id: 200, title: "B", upcoming_occurrences: [] },
          { id: 300, title: "C", upcoming_occurrences: ["2022-01-01T10:00:00Z", "2022-01-08T10:00:00Z"] },
        ]),
        { status: 200 },
      );
    });

    const events = await fetchEvents("token", "5555");
    assert.equal(events.length, 3);
    assert.equal(events[0].id, "100");
    assert.deepEqual(events[0].upcoming_occurrences, ["2026-05-01T10:00:00Z"]);
    assert.deepEqual(events[1].upcoming_occurrences, []);
  });
});

describe("filterRecentEvents", () => {
  const now = Temporal.Instant.from("2026-04-26T00:00:00Z");

  it("keeps events with any occurrence within the window", () => {
    const events = [
      { id: "1", upcoming_occurrences: ["2026-05-01T10:00:00Z"] }, // future
      { id: "2", upcoming_occurrences: ["2026-04-01T10:00:00Z"] }, // last month
      { id: "3", upcoming_occurrences: ["2025-11-01T10:00:00Z"] }, // ~6mo back, in window
    ];
    const ids = filterRecentEvents(events, now, 6).map((e) => e.id);
    assert.deepEqual(ids, ["1", "2", "3"]);
  });

  it("drops events whose latest occurrence is older than the window", () => {
    const events = [
      { id: "old", upcoming_occurrences: ["2022-06-05T15:00:00Z"] },
      { id: "very-old", upcoming_occurrences: ["2023-04-12T14:00:00Z"] },
      { id: "recent", upcoming_occurrences: ["2026-03-01T10:00:00Z"] },
    ];
    const ids = filterRecentEvents(events, now, 6).map((e) => e.id);
    assert.deepEqual(ids, ["recent"]);
  });

  it("drops events with no upcoming_occurrences (no signal of recency)", () => {
    const events = [
      { id: "empty", upcoming_occurrences: [] },
      { id: "active", upcoming_occurrences: ["2026-04-20T10:00:00Z"] },
    ];
    const ids = filterRecentEvents(events, now, 6).map((e) => e.id);
    assert.deepEqual(ids, ["active"]);
  });

  it("uses the latest occurrence when there are multiple", () => {
    const events = [
      { id: "mixed", upcoming_occurrences: ["2022-01-01T10:00:00Z", "2026-04-25T10:00:00Z"] },
    ];
    const ids = filterRecentEvents(events, now, 6).map((e) => e.id);
    assert.deepEqual(ids, ["mixed"]);
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

    const ids = await fetchEventIds("token123", "5555");
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
