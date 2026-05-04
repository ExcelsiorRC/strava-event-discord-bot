import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { MemoryKV } from "./helpers.ts";
import { weeklyTueFri, noFrequency } from "./fixtures.ts";

const PA_ROAD_URL = "https://example.com/road.ics";
const PA_MUT_URL = "https://example.com/mut.ics";

const ROAD_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "VERSION:2.0\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:road-event-1@example.com\r\n" +
  "DTSTAMP:20260101T000000Z\r\n" +
  "DTSTART:20260601T140000Z\r\n" +
  "SUMMARY:Pacific Road Race\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

const MUT_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "VERSION:2.0\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:mut-event-1@example.com\r\n" +
  "DTSTAMP:20260101T000000Z\r\n" +
  "DTSTART:20260710T140000Z\r\n" +
  "SUMMARY:Mountain Trail Run\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

function createEnv(kv: MemoryKV, calendarKey = "cal-secret-xyz"): Env {
  return {
    EVENT_BOT_STATE: kv as unknown as KVNamespace,
    STRAVA_CLIENT_ID: "test",
    STRAVA_CLIENT_SECRET: "test",
    STRAVA_CLUB_ID: "9999",
    STRAVA_CLUB_URL: "https://www.strava.com/clubs/test-club",
    MODE: "test",
    SEED_SECRET: "seed123",
    CALENDAR_KEY: calendarKey,
    DISCORD_WEBHOOK_EVENTS_TEST: "https://discord.test/events",
    DISCORD_WEBHOOK_LADIES_TEST: "https://discord.test/ladies",
    DISCORD_WEBHOOK_EVENTS_LIVE: "https://discord.live/events",
    DISCORD_WEBHOOK_LADIES_LIVE: "https://discord.live/ladies",
    EXTERNAL_CALENDARS: [
      { token: "road", name: "PA Road", url: PA_ROAD_URL },
      { token: "mut", name: "PA MUT", url: PA_MUT_URL },
    ],
  };
}

const KEY = "cal-secret-xyz";

let originalFetch: typeof globalThis.fetch;
function mockFetch(handler: (url: string) => Promise<Response>) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => handler(url)) as typeof globalThis.fetch;
}
function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
}

async function seedSnapshot(kv: MemoryKV) {
  await kv.put(
    "calendar:club:snapshot",
    JSON.stringify([weeklyTueFri, noFrequency]),
  );
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("GET /calendar.ics", () => {
  beforeEach(() => {
    mockFetch(async (url: string) => {
      if (url === PA_ROAD_URL) return new Response(ROAD_ICS, { status: 200 });
      if (url === PA_MUT_URL) return new Response(MUT_ICS, { status: 200 });
      return new Response("not found", { status: 404 });
    });
  });
  afterEach(() => restoreFetch());

  it("returns text/calendar with VCALENDAR wrapper", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz"),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/calendar/);
    const body = await res.text();
    assert.ok(body.startsWith("BEGIN:VCALENDAR"));
    assert.ok(body.trimEnd().endsWith("END:VCALENDAR"));
  });

  it("default include = club + all external tokens", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz"),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(body.includes("CATEGORIES:club"));
    assert.ok(body.includes("CATEGORIES:road"));
    assert.ok(body.includes("CATEGORIES:mut"));
    assert.ok(body.includes("Pacific Road Race"));
    assert.ok(body.includes("Mountain Trail Run"));
    assert.ok(body.includes("Morning Group Run"));
  });

  it("?include=club returns only club events", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=club"),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(body.includes("CATEGORIES:club"));
    assert.ok(!body.includes("CATEGORIES:road"));
    assert.ok(!body.includes("CATEGORIES:mut"));
  });

  it("?include=road returns only that external", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=road"),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(!body.includes("CATEGORIES:club"));
    assert.ok(body.includes("CATEGORIES:road"));
    assert.ok(!body.includes("CATEGORIES:mut"));
  });

  it("returns 400 on unknown token", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=bogus"),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  it("works when snapshot is missing (no club events)", async () => {
    const kv = new MemoryKV();
    // no snapshot seeded
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=club"),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("BEGIN:VCALENDAR"));
    assert.ok(!body.includes("BEGIN:VEVENT"));
  });

  it("uses KV cache for external feeds on subsequent requests", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    let externalCalls = 0;
    mockFetch(async (url: string) => {
      if (url === PA_ROAD_URL) {
        externalCalls++;
        return new Response(ROAD_ICS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=road"),
      createEnv(kv),
      ctx,
    );
    await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=road"),
      createEnv(kv),
      ctx,
    );
    assert.equal(externalCalls, 1);
  });

  it("HEAD request returns 200 + headers but empty body", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz", { method: "HEAD" }),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/calendar/);
    const body = await res.text();
    assert.equal(body, "", "HEAD response must have an empty body");
  });

  it("HEAD request validates include tokens (400 on bogus)", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=bogus", { method: "HEAD" }),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 400);
  });

  it("returns 403 when key query param is missing", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics"),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 403);
  });

  it("returns 403 when key is wrong", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=wrong"),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 403);
  });

  it("HEAD request also requires the key", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics", { method: "HEAD" }),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 403);
  });

  it("includes a VTIMEZONE block for America/Los_Angeles when club events are present", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz&include=club"),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(body.includes("BEGIN:VTIMEZONE"));
    assert.ok(body.includes("TZID:America/Los_Angeles"));
    // VTIMEZONE must precede VEVENT (RFC 5545)
    const tzIdx = body.indexOf("BEGIN:VTIMEZONE");
    const veIdx = body.indexOf("BEGIN:VEVENT");
    assert.ok(tzIdx > 0 && tzIdx < veIdx);
  });

  it("omits the club VTIMEZONE when only race feeds are requested", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request(
        "https://x/calendar.ics?key=cal-secret-xyz&include=road,mut",
      ),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(!body.includes("TZID:America/Los_Angeles"));
  });

  it("default feed gets the short ERC name", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz"),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(body.includes("\r\nX-WR-CALNAME:ERC\r\n"));
  });

  it("?include=road,mut produces the derived name", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request(
        "https://x/calendar.ics?key=cal-secret-xyz&include=road,mut",
      ),
      createEnv(kv),
      ctx,
    );
    const body = await res.text();
    assert.ok(body.includes("\r\nX-WR-CALNAME:ERC PA Road + MUT\r\n"));
  });

  it("sets a Cache-Control header for client/CDN caching", async () => {
    const kv = new MemoryKV();
    await seedSnapshot(kv);
    const res = await worker.fetch(
      new Request("https://x/calendar.ics?key=cal-secret-xyz"),
      createEnv(kv),
      ctx,
    );
    const cc = res.headers.get("cache-control") ?? "";
    assert.match(cc, /max-age=/);
  });
});

describe("POST /run", () => {
  it("returns 403 when key is missing", async () => {
    const kv = new MemoryKV();
    const res = await worker.fetch(
      new Request("https://x/run", { method: "POST" }),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 403);
  });

  it("returns 403 when key is wrong", async () => {
    const kv = new MemoryKV();
    const res = await worker.fetch(
      new Request("https://x/run?key=nope", { method: "POST" }),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 403);
  });

  it("rejects GET (only POST is allowed)", async () => {
    const kv = new MemoryKV();
    const res = await worker.fetch(
      new Request("https://x/run?key=seed123"),
      createEnv(kv),
      ctx,
    );
    assert.equal(res.status, 404);
  });
});
