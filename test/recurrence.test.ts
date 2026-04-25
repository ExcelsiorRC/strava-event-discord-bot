import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import {
  weeklyTueFri,
  biweeklyMonday,
  noFrequency,
  monthlyEvent,
} from "./fixtures.ts";
import type { EventDetail } from "../src/types.ts";
import { expandOccurrences } from "../src/recurrence.ts";

function instant(iso: string): Temporal.Instant {
  return Temporal.Instant.from(iso);
}

function laToInstant(dateStr: string, timeStr: string): Temporal.Instant {
  return Temporal.PlainDateTime.from(`${dateStr}T${timeStr}`)
    .toZonedDateTime("America/Los_Angeles")
    .toInstant();
}

describe("expandOccurrences — weekly recurrence", () => {
  it("finds Tuesday occurrence when now is Monday 06:00 LA", () => {
    // Monday 2026-04-27 06:00 LA → Tuesday 2026-04-28 05:45 LA is ~23.75h away
    const now = laToInstant("2026-04-27", "06:00");
    const result = expandOccurrences(weeklyTueFri, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].eventId, "9990001");
    // Tuesday 05:45 LA = 12:45 UTC (PDT, UTC-7)
    assert.equal(result[0].isoKey, "2026-04-28T12:45:00Z");
  });

  it("returns empty when now is Tuesday 06:00 LA (next is Friday, >25h)", () => {
    // Tuesday 2026-04-28 06:00 LA → Friday 2026-05-01 05:45 LA is ~72h away
    const now = laToInstant("2026-04-28", "06:00");
    const result = expandOccurrences(weeklyTueFri, now);
    assert.equal(result.length, 0);
  });

  it("finds Friday occurrence when now is Thursday 06:00 LA", () => {
    // Thursday 2026-04-30 06:00 LA → Friday 2026-05-01 05:45 LA is ~23.75h away
    const now = laToInstant("2026-04-30", "06:00");
    const result = expandOccurrences(weeklyTueFri, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].isoKey, "2026-05-01T12:45:00Z");
  });

  it("finds both occurrences when window spans two matching days", () => {
    // If now is Monday 05:00 LA, window is Mon 05:00 → Tue 06:00 LA
    // Tuesday 05:45 is in range. Friday is not.
    // But if we set now to just before the first occurrence on a day with two events nearby...
    // weeklyTueFri has Tue+Fri. Let's test a narrow window that only catches one.
    const now = laToInstant("2026-04-27", "05:50");
    const result = expandOccurrences(weeklyTueFri, now);
    // Tue 2026-04-28 05:45 LA is ~23h55m away — within 25h window
    assert.equal(result.length, 1);
  });
});

describe("expandOccurrences — biweekly interval", () => {
  // biweeklyMonday: start 2025-06-23 (Monday), interval 2, days_of_week ["monday"]
  // Week 0: 2025-06-23 (on)
  // Week 2: 2025-07-07 (on)
  // ...pattern: on-weeks are even-numbered weeks from start

  it("matches on an 'on' week", () => {
    // 2025-06-23 is week 0 (on). Each on-week is +14 days.
    // 2026-04-27 is a Monday. Days from 2025-06-23 = 308 days. 308/7 = 44 weeks. 44 % 2 = 0. On!
    const now = laToInstant("2026-04-26", "18:30"); // Sunday 18:30 → Monday 18:00 is ~23.5h
    const result = expandOccurrences(biweeklyMonday, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].eventId, "9990002");
  });

  it("skips an 'off' week", () => {
    // 2026-05-04 is the next Monday after 04-27. Weeks from start: 45. 45 % 2 = 1. Off.
    const now = laToInstant("2026-05-03", "18:30"); // Sunday before off Monday
    const result = expandOccurrences(biweeklyMonday, now);
    assert.equal(result.length, 0);
  });
});

describe("expandOccurrences — DST transitions", () => {
  it("handles spring forward (March 2026)", () => {
    // March 8, 2026 — DST springs forward at 02:00 → 03:00
    // Event at 02:30 on Sundays would hit a non-existent time
    const springEvent: EventDetail = {
      id: "9990010",
      title: "DST Test",
      description: "",
      women_only: false,
      private: false,
      zone: "America/Los_Angeles",
      address: "",
      frequency: "weekly",
      days_of_week: ["sunday"],
      weekly_interval: 1,
      start_datetime: "2026-03-01T02:30",
      upcoming_occurrences: [],
    };
    // Saturday March 7, 2026 03:00 LA → Sunday March 8 02:30 doesn't exist
    // Temporal with 'compatible' should resolve to 03:30
    const now = laToInstant("2026-03-07", "03:00");
    const result = expandOccurrences(springEvent, now);
    assert.equal(result.length, 1);
    // 03:30 PDT = 10:30 UTC (PDT = UTC-7)
    assert.equal(result[0].isoKey, "2026-03-08T10:30:00Z");
  });

  it("handles fall back (November 2026)", () => {
    // November 1, 2026 — DST falls back at 02:00 → 01:00
    // Event at 01:30 on Sundays — ambiguous time
    const fallEvent: EventDetail = {
      id: "9990011",
      title: "DST Fall Test",
      description: "",
      women_only: false,
      private: false,
      zone: "America/Los_Angeles",
      address: "",
      frequency: "weekly",
      days_of_week: ["sunday"],
      weekly_interval: 1,
      start_datetime: "2026-03-01T01:30",
      upcoming_occurrences: [],
    };
    // Saturday Oct 31 02:00 LA → Sunday Nov 1 01:30 is ambiguous
    // 'compatible' picks first (still PDT) = 01:30 PDT = 08:30 UTC
    const now = laToInstant("2026-10-31", "02:00");
    const result = expandOccurrences(fallEvent, now);
    assert.equal(result.length, 1);
    // First 01:30 (still PDT, UTC-7) = 08:30 UTC
    assert.equal(result[0].isoKey, "2026-11-01T08:30:00Z");
  });
});

describe("expandOccurrences — edge cases", () => {
  it("returns empty when event has not started yet", () => {
    const futureEvent: EventDetail = {
      id: "9990020",
      title: "Future Event",
      description: "",
      women_only: false,
      private: false,
      zone: "America/Los_Angeles",
      address: "",
      frequency: "weekly",
      days_of_week: ["monday"],
      weekly_interval: 1,
      start_datetime: "2027-01-05T08:00", // Far future
      upcoming_occurrences: [],
    };
    const now = laToInstant("2026-04-27", "06:00");
    const result = expandOccurrences(futureEvent, now);
    assert.equal(result.length, 0);
  });

  it("returns empty when days_of_week is empty array", () => {
    const emptyDays: EventDetail = {
      id: "9990021",
      title: "Empty Days",
      description: "",
      women_only: false,
      private: false,
      zone: "America/Los_Angeles",
      address: "",
      frequency: "weekly",
      days_of_week: [],
      weekly_interval: 1,
      start_datetime: "2025-06-24T05:45",
      upcoming_occurrences: [],
    };
    const now = laToInstant("2026-04-27", "06:00");
    const result = expandOccurrences(emptyDays, now);
    assert.equal(result.length, 0);
  });
});

describe("expandOccurrences — non-weekly fallback", () => {
  it("uses upcoming_occurrences for events without frequency", () => {
    // noFrequency has occurrences: 2026-04-27T17:00:00Z, 2026-05-15T17:00:00Z
    // Set now just before the first one
    const now = instant("2026-04-27T10:00:00Z"); // 7h before first occurrence
    const result = expandOccurrences(noFrequency, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].isoKey, "2026-04-27T17:00:00Z");
  });

  it("uses upcoming_occurrences for monthly frequency", () => {
    // monthlyEvent has occurrence: 2026-04-27T17:00:00Z
    const now = instant("2026-04-27T10:00:00Z");
    const result = expandOccurrences(monthlyEvent, now);
    assert.equal(result.length, 1);
    assert.equal(result[0].isoKey, "2026-04-27T17:00:00Z");
  });

  it("filters out occurrences outside 25h window", () => {
    const now = instant("2026-04-25T10:00:00Z"); // 2+ days before
    const result = expandOccurrences(noFrequency, now);
    assert.equal(result.length, 0);
  });

  it("filters out occurrences in the past", () => {
    const now = instant("2026-04-27T18:00:00Z"); // 1h after first occurrence
    const result = expandOccurrences(noFrequency, now);
    // Second occurrence is 2026-05-15, way beyond 25h
    assert.equal(result.length, 0);
  });
});
