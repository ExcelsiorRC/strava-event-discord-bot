import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  transformExternalIcs,
  fetchExternalIcs,
  externalCacheKey,
} from "../src/external.ts";
import { MemoryKV } from "./helpers.ts";

const SAMPLE_ICS =
  "BEGIN:VCALENDAR\r\n" +
  "VERSION:2.0\r\n" +
  "PRODID:-//Test//EN\r\n" +
  "BEGIN:VTIMEZONE\r\n" +
  "TZID:America/Los_Angeles\r\n" +
  "BEGIN:STANDARD\r\n" +
  "DTSTART:19700101T020000\r\n" +
  "TZOFFSETFROM:-0700\r\n" +
  "TZOFFSETTO:-0800\r\n" +
  "END:STANDARD\r\n" +
  "END:VTIMEZONE\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:race-2026-04-26@pausatf.org\r\n" +
  "DTSTAMP:20260101T000000Z\r\n" +
  "DTSTART;TZID=America/Los_Angeles:20260426T080000\r\n" +
  "SUMMARY:Big Sur Marathon\r\n" +
  "LOCATION:Carmel\\, CA\r\n" +
  "END:VEVENT\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:race-2026-05-10@pausatf.org\r\n" +
  "DTSTAMP:20260101T000000Z\r\n" +
  "DTSTART;TZID=America/Los_Angeles:20260510T080000\r\n" +
  "SUMMARY:Bay To Breakers\r\n" +
  "CATEGORIES:Existing,Other\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

describe("transformExternalIcs", () => {
  it("extracts VTIMEZONE block as a string", () => {
    const slice = transformExternalIcs(SAMPLE_ICS, "road");
    assert.ok(slice.vtimezones.includes("BEGIN:VTIMEZONE"));
    assert.ok(slice.vtimezones.includes("TZID:America/Los_Angeles"));
    assert.ok(slice.vtimezones.includes("END:VTIMEZONE"));
    // vtimezones must NOT include VEVENT or VCALENDAR markers
    assert.ok(!slice.vtimezones.includes("BEGIN:VEVENT"));
    assert.ok(!slice.vtimezones.includes("BEGIN:VCALENDAR"));
  });

  it("extracts each VEVENT with token-prefixed UID", () => {
    const slice = transformExternalIcs(SAMPLE_ICS, "road");
    assert.equal(slice.vevents.length, 2);
    assert.ok(slice.vevents[0].includes("UID:road-race-2026-04-26@pausatf.org"));
    assert.ok(slice.vevents[1].includes("UID:road-race-2026-05-10@pausatf.org"));
  });

  it("injects CATEGORIES:<token> into each VEVENT", () => {
    const slice = transformExternalIcs(SAMPLE_ICS, "road");
    for (const v of slice.vevents) {
      assert.ok(v.includes("CATEGORIES:road"), `expected CATEGORIES:road in:\n${v}`);
    }
  });

  it("replaces existing CATEGORIES rather than duplicating", () => {
    const slice = transformExternalIcs(SAMPLE_ICS, "road");
    const second = slice.vevents[1];
    const matches = second.match(/^CATEGORIES:/gm) ?? [];
    assert.equal(matches.length, 1, `expected exactly one CATEGORIES line, got:\n${second}`);
    assert.ok(!second.includes("Existing"));
  });

  it("preserves other VEVENT properties unchanged", () => {
    const slice = transformExternalIcs(SAMPLE_ICS, "road");
    assert.ok(slice.vevents[0].includes("SUMMARY:Big Sur Marathon"));
    assert.ok(slice.vevents[0].includes("DTSTART;TZID=America/Los_Angeles:20260426T080000"));
    assert.ok(slice.vevents[0].includes("LOCATION:Carmel\\, CA"));
  });

  it("handles folded UID lines by un-folding before prefixing", () => {
    const folded =
      "BEGIN:VCALENDAR\r\n" +
      "BEGIN:VEVENT\r\n" +
      "UID:very-long-uid-tha\r\n" +
      " t-was-folded@example.com\r\n" +
      "SUMMARY:Test\r\n" +
      "END:VEVENT\r\n" +
      "END:VCALENDAR\r\n";
    const slice = transformExternalIcs(folded, "xc");
    assert.ok(
      slice.vevents[0].includes("UID:xc-very-long-uid-that-was-folded@example.com"),
      `got: ${slice.vevents[0]}`,
    );
  });

  it("returns empty slice for ICS with no VEVENTs", () => {
    const empty = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
    const slice = transformExternalIcs(empty, "mut");
    assert.deepEqual(slice.vevents, []);
    assert.equal(slice.vtimezones, "");
  });
});

describe("fetchExternalIcs", () => {
  let kv: MemoryKV;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: number;

  beforeEach(() => {
    kv = new MemoryKV();
    fetchCalls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(SAMPLE_ICS, {
        status: 200,
        headers: { "content-type": "text/calendar" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches over network on cache miss and caches result", async () => {
    const text = await fetchExternalIcs(kv as unknown as KVNamespace, "https://example.com/cal.ics");
    assert.equal(fetchCalls, 1);
    assert.ok(text.includes("BEGIN:VCALENDAR"));
    assert.equal(
      await kv.get(externalCacheKey("https://example.com/cal.ics")),
      text,
    );
  });

  it("returns cached value on cache hit without network call", async () => {
    await kv.put(externalCacheKey("https://example.com/cal.ics"), "CACHED-ICS");
    const text = await fetchExternalIcs(kv as unknown as KVNamespace, "https://example.com/cal.ics");
    assert.equal(fetchCalls, 0);
    assert.equal(text, "CACHED-ICS");
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof globalThis.fetch;
    await assert.rejects(
      () => fetchExternalIcs(kv as unknown as KVNamespace, "https://example.com/x.ics"),
      /500/,
    );
  });
});
