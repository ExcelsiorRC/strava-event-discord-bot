import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeIcsText,
  foldIcsLine,
  clubEventVEvents,
  buildVCalendar,
  calendarName,
  persistClubSnapshot,
  readClubSnapshot,
  CLUB_SNAPSHOT_KEY,
} from "../src/calendar.ts";
import { MemoryKV } from "./helpers.ts";
import type { EventDetail } from "../src/types.ts";
import {
  weeklyTueFri,
  biweeklyMonday,
  noFrequency,
  womenOnlyWeekly,
} from "./fixtures.ts";

const FIXED_NOW = "20260426T120000Z";
const CLUB_URL = "https://www.strava.com/clubs/test-club";

function findLine(block: string, prefix: string): string | undefined {
  return block.split("\r\n").find((l) => l.startsWith(prefix));
}

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma, newline per RFC5545", () => {
    assert.equal(escapeIcsText("a\\b"), "a\\\\b");
    assert.equal(escapeIcsText("a;b"), "a\\;b");
    assert.equal(escapeIcsText("a,b"), "a\\,b");
    assert.equal(escapeIcsText("a\nb"), "a\\nb");
  });

  it("escapes backslash before other escapes (order matters)", () => {
    assert.equal(escapeIcsText("\\,"), "\\\\\\,");
  });

  it("preserves plain text untouched", () => {
    assert.equal(escapeIcsText("hello world"), "hello world");
  });
});

describe("foldIcsLine", () => {
  it("returns short lines unchanged", () => {
    assert.equal(foldIcsLine("SUMMARY:short"), "SUMMARY:short");
  });

  it("folds long lines at 75 octets with CRLF + space", () => {
    const long = "DESCRIPTION:" + "x".repeat(100);
    const folded = foldIcsLine(long);
    const segments = folded.split("\r\n");
    assert.ok(segments.length >= 2, "should split into multiple segments");
    assert.equal(segments[0].length, 75);
    for (let i = 1; i < segments.length; i++) {
      assert.ok(segments[i].startsWith(" "), "continuation lines start with space");
    }
    // Unfolding (remove CRLF + leading space) gives original
    assert.equal(folded.replace(/\r\n /g, ""), long);
  });
});

describe("clubEventVEvents — weekly events", () => {
  it("emits one VEVENT with RRULE for a weekly event", () => {
    const blocks = clubEventVEvents(weeklyTueFri, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(blocks.length, 1);
    const v = blocks[0];
    assert.match(v, /^BEGIN:VEVENT\r\n/);
    assert.match(v, /\r\nEND:VEVENT$/);
    assert.equal(findLine(v, "UID:"), "UID:club-9990001@strava");
    assert.equal(findLine(v, "DTSTAMP:"), "DTSTAMP:20260426T120000Z");
    assert.equal(
      findLine(v, "DTSTART"),
      "DTSTART;TZID=America/Los_Angeles:20250624T054500",
    );
    assert.equal(
      findLine(v, "DTEND"),
      "DTEND;TZID=America/Los_Angeles:20250624T064500",
    );
    assert.equal(findLine(v, "RRULE:"), "RRULE:FREQ=WEEKLY;BYDAY=TU,FR");
    assert.equal(findLine(v, "SUMMARY:"), "SUMMARY:Morning Group Run");
    assert.equal(findLine(v, "CATEGORIES:"), "CATEGORIES:club");
    assert.equal(
      findLine(v, "URL:"),
      "URL:https://www.strava.com/clubs/test-club/group_events/9990001",
    );
  });

  it("includes INTERVAL=N when weekly_interval > 1", () => {
    const blocks = clubEventVEvents(biweeklyMonday, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(
      findLine(blocks[0], "RRULE:"),
      "RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=2",
    );
  });

  it("escapes special chars in LOCATION (comma)", () => {
    const blocks = clubEventVEvents(weeklyTueFri, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(findLine(blocks[0], "LOCATION:"), "LOCATION:(37.77\\, -122.46)");
  });

  it("women_only weekly events still tagged CATEGORIES:club", () => {
    const blocks = clubEventVEvents(womenOnlyWeekly, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(findLine(blocks[0], "CATEGORIES:"), "CATEGORIES:club");
  });

  it("prefixes women_only event titles with a marker so they're visible everywhere", () => {
    const blocks = clubEventVEvents(womenOnlyWeekly, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(findLine(blocks[0], "SUMMARY:"), "SUMMARY:🚺 Women's Run");
  });

  it("does not prefix non-women-only events", () => {
    const blocks = clubEventVEvents(weeklyTueFri, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(findLine(blocks[0], "SUMMARY:"), "SUMMARY:Morning Group Run");
  });
});

describe("clubEventVEvents — recency filter", () => {
  it("always renders weekly events even with ancient start_datetime", () => {
    // Dawn Patrol case: weekly recurring, created in 2025, snapshot still in
    // 2026 should emit the RRULE. The filter should NEVER drop a recurring
    // event because of how old its start_datetime is.
    const dawnPatrol = {
      ...weeklyTueFri,
      start_datetime: "2025-06-24T05:45",
    };
    const blocks = clubEventVEvents(dawnPatrol, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /^RRULE:/m);
  });

  it("drops one-off occurrences older than 6 months", () => {
    // FIXED_NOW is 2026-04-26. 6mo back = 2025-10-26.
    const oldOneOff = {
      ...noFrequency,
      upcoming_occurrences: [
        "2022-01-01T17:00:00Z", // 4 years ago — drop
        "2025-04-01T17:00:00Z", // ~1 year ago — drop
        "2025-08-01T17:00:00Z", // ~8 months ago — drop
      ],
    };
    const blocks = clubEventVEvents(oldOneOff, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(blocks.length, 0);
  });

  it("keeps one-off occurrences in the last 6 months and future", () => {
    const mixed = {
      ...noFrequency,
      upcoming_occurrences: [
        "2022-01-01T17:00:00Z", // ancient — drop
        "2025-12-01T17:00:00Z", // ~5 months ago — keep
        "2026-04-20T17:00:00Z", // last week — keep
        "2026-05-15T17:00:00Z", // future — keep
      ],
    };
    const blocks = clubEventVEvents(mixed, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(blocks.length, 3);
  });
});

describe("clubEventVEvents — one-off events", () => {
  it("emits one VEVENT per upcoming_occurrence with UTC times", () => {
    const blocks = clubEventVEvents(noFrequency, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.equal(blocks.length, 2);
    assert.equal(
      findLine(blocks[0], "UID:"),
      "UID:club-9990003-1777309200@strava",
    );
    assert.equal(findLine(blocks[0], "DTSTART:"), "DTSTART:20260427T170000Z");
    assert.equal(findLine(blocks[0], "DTEND:"), "DTEND:20260427T180000Z");
    assert.equal(findLine(blocks[1], "DTSTART:"), "DTSTART:20260515T170000Z");
    assert.equal(
      findLine(blocks[0], "URL:"),
      "URL:https://www.strava.com/clubs/test-club/group_events/9990003",
    );
  });

  it("returns empty array for an event with no upcoming_occurrences and no recurrence", () => {
    const empty = { ...noFrequency, upcoming_occurrences: [] };
    const blocks = clubEventVEvents(empty, {
      clubUrl: CLUB_URL,
      nowUtc: FIXED_NOW,
    });
    assert.deepEqual(blocks, []);
  });
});

describe("buildVCalendar", () => {
  it("wraps vevents with VCALENDAR header/footer and uses CRLF", () => {
    const ics = buildVCalendar({
      vevents: ["BEGIN:VEVENT\r\nUID:test@x\r\nEND:VEVENT"],
    });
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /VERSION:2\.0\r\n/);
    assert.match(ics, /PRODID:/);
    assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
    assert.ok(ics.includes("BEGIN:VEVENT\r\nUID:test@x\r\nEND:VEVENT\r\n"));
  });

  it("includes pass-through vtimezones before vevents", () => {
    const ics = buildVCalendar({
      vtimezones: "BEGIN:VTIMEZONE\r\nTZID:America/Los_Angeles\r\nEND:VTIMEZONE",
      vevents: ["BEGIN:VEVENT\r\nUID:e@x\r\nEND:VEVENT"],
    });
    const tzIdx = ics.indexOf("BEGIN:VTIMEZONE");
    const veIdx = ics.indexOf("BEGIN:VEVENT");
    assert.ok(tzIdx > 0 && veIdx > tzIdx, "VTIMEZONE comes before VEVENT");
  });

  it("emits empty calendar with just header/footer when no events", () => {
    const ics = buildVCalendar({ vevents: [] });
    assert.ok(ics.includes("BEGIN:VCALENDAR\r\n"));
    assert.ok(ics.includes("END:VCALENDAR\r\n"));
    assert.ok(!ics.includes("BEGIN:VEVENT"));
  });

  it("emits a default X-WR-CALNAME when no name is passed", () => {
    const ics = buildVCalendar({ vevents: [] });
    assert.ok(ics.includes("\r\nX-WR-CALNAME:ERC\r\n"));
  });

  it("emits the supplied X-WR-CALNAME", () => {
    const ics = buildVCalendar({ vevents: [], name: "ERC + PA Races" });
    assert.ok(ics.includes("\r\nX-WR-CALNAME:ERC + PA Races\r\n"));
  });

  it("emits X-WR-TIMEZONE for America/Los_Angeles by default", () => {
    const ics = buildVCalendar({ vevents: [] });
    assert.ok(ics.includes("\r\nX-WR-TIMEZONE:America/Los_Angeles\r\n"));
  });

  it("emits both X-APPLE-CALENDAR-COLOR and COLOR with the pale-yellow hex", () => {
    const ics = buildVCalendar({ vevents: [] });
    assert.ok(ics.includes("\r\nX-APPLE-CALENDAR-COLOR:#FDFAD2\r\n"));
    assert.ok(ics.includes("\r\nCOLOR:#FDFAD2\r\n"));
  });
});

describe("calendarName", () => {
  const set = (...xs: string[]) => new Set(xs);

  it("default (no include param) → ERC", () => {
    assert.equal(calendarName(null), "ERC");
  });

  it("club only → ERC", () => {
    assert.equal(calendarName(set("club")), "ERC");
  });

  it("all 3 PA races (no club) → ERC PA Races", () => {
    assert.equal(calendarName(set("road", "mut", "xc")), "ERC PA Races");
  });

  it("single race tokens get full PA prefix", () => {
    assert.equal(calendarName(set("road")), "ERC PA Road");
    assert.equal(calendarName(set("mut")), "ERC PA MUT");
    assert.equal(calendarName(set("xc")), "ERC PA XC");
  });

  it("two races (no club) drop the PA prefix on the second", () => {
    assert.equal(calendarName(set("road", "mut")), "ERC PA Road + MUT");
    assert.equal(calendarName(set("road", "xc")), "ERC PA Road + XC");
    assert.equal(calendarName(set("mut", "xc")), "ERC PA MUT + XC");
  });

  it("club + all 3 races → ERC + PA Races", () => {
    assert.equal(
      calendarName(set("club", "road", "mut", "xc")),
      "ERC + PA Races",
    );
  });

  it("club + one race → ERC + PA <Race>", () => {
    assert.equal(calendarName(set("club", "road")), "ERC + PA Road");
    assert.equal(calendarName(set("club", "mut")), "ERC + PA MUT");
    assert.equal(calendarName(set("club", "xc")), "ERC + PA XC");
  });

  it("club + two races → ERC + PA Road + MUT", () => {
    assert.equal(
      calendarName(set("club", "road", "mut")),
      "ERC + PA Road + MUT",
    );
  });
});

describe("persistClubSnapshot — sticky merge with deletion detection", () => {
  function ev(id: string, title: string): EventDetail {
    return {
      id,
      title,
      description: "",
      women_only: false,
      private: false,
      zone: "America/Los_Angeles",
      address: "",
      upcoming_occurrences: [],
    };
  }
  const ids = (...xs: string[]) => new Set(xs);

  it("first write seeds the snapshot", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const changed = await persistClubSnapshot(
      kv,
      [ev("1", "A"), ev("2", "B")],
      ids("1", "2"),
    );
    assert.equal(changed, true);
    const snap = await readClubSnapshot(kv);
    assert.deepEqual(snap.map((e) => e.id).sort(), ["1", "2"]);
  });

  it("keeps aged-out events that are still on Strava", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await persistClubSnapshot(kv, [ev("1", "A"), ev("2", "B")], ids("1", "2"));
    // Next cron: only event 3 was freshly fetched (1 and 2 aged out of filter)
    // BUT all three are still on Strava
    const changed = await persistClubSnapshot(kv, [ev("3", "C")], ids("1", "2", "3"));
    assert.equal(changed, true);
    const snap = await readClubSnapshot(kv);
    assert.deepEqual(snap.map((e) => e.id).sort(), ["1", "2", "3"]);
  });

  it("removes events that were deleted on Strava", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await persistClubSnapshot(
      kv,
      [ev("1", "A"), ev("2", "B"), ev("3", "C")],
      ids("1", "2", "3"),
    );
    // Cron runs again; event 2 was deleted on Strava (not in current id set)
    const changed = await persistClubSnapshot(kv, [], ids("1", "3"));
    assert.equal(changed, true);
    const snap = await readClubSnapshot(kv);
    assert.deepEqual(snap.map((e) => e.id).sort(), ["1", "3"]);
  });

  it("refreshes existing entries when re-fetched", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await persistClubSnapshot(kv, [ev("1", "Old Title")], ids("1"));
    await persistClubSnapshot(kv, [ev("1", "New Title")], ids("1"));
    const snap = await readClubSnapshot(kv);
    assert.equal(snap.length, 1);
    assert.equal(snap[0].title, "New Title");
  });

  it("returns false (no bump) when merge produces identical content", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await persistClubSnapshot(kv, [ev("1", "A"), ev("2", "B")], ids("1", "2"));
    const changed = await persistClubSnapshot(
      kv,
      [ev("1", "A"), ev("2", "B")],
      ids("1", "2"),
    );
    assert.equal(changed, false);
  });

  it("returns false when new fetched set is a subset (sticky no-op)", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await persistClubSnapshot(kv, [ev("1", "A"), ev("2", "B")], ids("1", "2"));
    const changed = await persistClubSnapshot(kv, [ev("1", "A")], ids("1", "2"));
    assert.equal(changed, false);
  });
});
