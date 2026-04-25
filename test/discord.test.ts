import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { weeklyTueFri, womenOnlyWeekly, noFrequency } from "./fixtures.ts";
import { buildEmbed, buildAnnouncementEmbed, getWebhookUrl } from "../src/discord.ts";
import type { Occurrence } from "../src/recurrence.ts";

function makeOccurrence(
  eventId: string,
  isoKey: string,
): Occurrence {
  return {
    eventId,
    instant: Temporal.Instant.from(isoKey),
    isoKey,
  };
}

const TEST_CLUB_URL = "https://www.strava.com/clubs/test-club";

describe("buildEmbed", () => {
  it("builds correct embed for a general event", () => {
    const occ = makeOccurrence("9990001", "2026-04-28T12:45:00Z");
    const embed = buildEmbed(weeklyTueFri, occ, TEST_CLUB_URL);

    assert.equal(embed.title, "Morning Group Run");
    assert.match(embed.url, /test-club\/group_events\/9990001/);
    assert.equal(embed.description, "Easy pace around the park loop.");
    assert.equal(embed.color, 0x5865f2); // blurple
    assert.equal(embed.footer.text, "Jane Doe");

    const whenField = embed.fields.find(
      (f: { name: string }) => f.name === "When",
    );
    assert.ok(whenField);
    const unix = Math.floor(occ.instant.epochSeconds);
    assert.match(whenField.value, new RegExp(`<t:${unix}:F>`));
    assert.match(whenField.value, new RegExp(`<t:${unix}:R>`));
  });

  it("uses coral color for women-only events", () => {
    const occ = makeOccurrence("9990005", "2026-04-29T13:00:00Z");
    const embed = buildEmbed(womenOnlyWeekly, occ, TEST_CLUB_URL);
    assert.equal(embed.color, 0xff7f50);
  });

  it("truncates long descriptions with [...]", () => {
    const longEvent = {
      ...weeklyTueFri,
      description: "A".repeat(500),
    };
    const occ = makeOccurrence("9990001", "2026-04-28T12:45:00Z");
    const embed = buildEmbed(longEvent, occ, TEST_CLUB_URL);
    assert.ok(embed.description.length <= 410);
    assert.ok(embed.description.endsWith("[...]"));
  });

  it("preserves newlines in descriptions", () => {
    const nlEvent = {
      ...weeklyTueFri,
      description: "Line one\nLine two\nLine three",
    };
    const occ = makeOccurrence("9990001", "2026-04-28T12:45:00Z");
    const embed = buildEmbed(nlEvent, occ, TEST_CLUB_URL);
    assert.ok(embed.description.includes("\n"));
  });

  it("omits Where field when address is empty", () => {
    const noAddr = { ...weeklyTueFri, address: "" };
    const occ = makeOccurrence("9990001", "2026-04-28T12:45:00Z");
    const embed = buildEmbed(noAddr, occ, TEST_CLUB_URL);
    const whereField = embed.fields.find(
      (f: { name: string }) => f.name === "Where",
    );
    assert.equal(whereField, undefined);
  });

  it("includes Where field when address is present", () => {
    const occ = makeOccurrence("9990001", "2026-04-28T12:45:00Z");
    const embed = buildEmbed(weeklyTueFri, occ, TEST_CLUB_URL);
    const whereField = embed.fields.find(
      (f: { name: string }) => f.name === "Where",
    );
    assert.ok(whereField);
    assert.equal(whereField.value, "(37.77, -122.46)");
  });
});

describe("buildAnnouncementEmbed", () => {
  it("builds announcement for a weekly recurring event", () => {
    const embed = buildAnnouncementEmbed(weeklyTueFri, TEST_CLUB_URL);
    assert.equal(embed.title, "New Event: Morning Group Run");
    assert.match(embed.url, /test-club\/group_events\/9990001/);
    assert.equal(embed.color, 0x57f287); // green
    const scheduleField = embed.fields.find(
      (f: { name: string }) => f.name === "Schedule",
    );
    assert.ok(scheduleField);
    assert.match(scheduleField.value, /tuesday/i);
    assert.match(scheduleField.value, /friday/i);
  });

  it("builds announcement for a non-recurring event", () => {
    const embed = buildAnnouncementEmbed(noFrequency, TEST_CLUB_URL);
    assert.equal(embed.title, "New Event: One-Off Trail Run");
    const scheduleField = embed.fields.find(
      (f: { name: string }) => f.name === "Schedule",
    );
    assert.equal(scheduleField, undefined);
  });

  it("uses coral for women-only announcement", () => {
    const embed = buildAnnouncementEmbed(womenOnlyWeekly, TEST_CLUB_URL);
    assert.equal(embed.color, 0xff7f50);
  });

  it("includes Where field when address is present", () => {
    const embed = buildAnnouncementEmbed(weeklyTueFri, TEST_CLUB_URL);
    const whereField = embed.fields.find(
      (f: { name: string }) => f.name === "Where",
    );
    assert.ok(whereField);
  });
});

describe("getWebhookUrl", () => {
  const env = {
    DISCORD_WEBHOOK_EVENTS_TEST: "https://events-test",
    DISCORD_WEBHOOK_LADIES_TEST: "https://ladies-test",
    DISCORD_WEBHOOK_EVENTS_LIVE: "https://events-live",
    DISCORD_WEBHOOK_LADIES_LIVE: "https://ladies-live",
  };

  it("routes women_only to ladies webhook in test mode", () => {
    assert.equal(
      getWebhookUrl(env, womenOnlyWeekly, "test"),
      "https://ladies-test",
    );
  });

  it("routes women_only to ladies webhook in live mode", () => {
    assert.equal(
      getWebhookUrl(env, womenOnlyWeekly, "live"),
      "https://ladies-live",
    );
  });

  it("routes general events to events webhook in test mode", () => {
    assert.equal(
      getWebhookUrl(env, weeklyTueFri, "test"),
      "https://events-test",
    );
  });

  it("routes general events to events webhook in live mode", () => {
    assert.equal(
      getWebhookUrl(env, weeklyTueFri, "live"),
      "https://events-live",
    );
  });
});
