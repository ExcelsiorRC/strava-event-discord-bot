import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeIcsText,
  foldIcsLine,
  clubEventVEvents,
  buildVCalendar,
} from "../src/calendar.ts";
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
});
