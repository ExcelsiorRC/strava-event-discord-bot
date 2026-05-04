import type { EventDetail } from "./types.ts";
import type { Occurrence } from "./recurrence.ts";
import { formatLocation } from "./calendar.ts";

const COLOR_GENERAL = 0x5865f2; // Discord blurple
const COLOR_WOMEN = 0xff7f50; // Coral
const COLOR_NEW = 0x57f287; // Green
const MAX_DESC_LEN = 400;
const BOT_USERNAME = "Event Bot";

function formatWhere(address: string): string {
  const url = formatLocation(address);
  return url === address ? address : `[${address}](${url})`;
}

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  color: number;
  fields: DiscordField[];
  author: { name: string; url: string };
}

export function buildEmbed(
  event: EventDetail,
  occurrence: Occurrence,
  clubUrl: string,
  clubId: string,
): DiscordEmbed {
  const unix = Math.floor(occurrence.instant.epochMilliseconds / 1000);

  let description = event.description ?? "";
  if (description.length > MAX_DESC_LEN) {
    description = description.slice(0, MAX_DESC_LEN) + "[...]";
  }

  const fields: DiscordField[] = [
    {
      name: "When",
      value: `<t:${unix}:F> (<t:${unix}:R>)`,
    },
  ];

  if (event.address) {
    fields.push({ name: "Where", value: formatWhere(event.address) });
  }

  if (event.organizing_athlete) {
    fields.push({
      name: "Organizer",
      value: `${event.organizing_athlete.firstname} ${event.organizing_athlete.lastname}`,
    });
  }

  return {
    title: event.title,
    url: `https://www.strava.com/clubs/${clubId}/group_events/${event.id}`,
    description,
    color: event.women_only ? COLOR_WOMEN : COLOR_GENERAL,
    fields,
    author: { name: "Strava Club Events", url: clubUrl },
  };
}

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function formatSchedule(event: EventDetail): string | null {
  if (event.frequency !== "weekly" || !event.days_of_week?.length) return null;
  const days = event.days_of_week
    .slice()
    .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1));
  const time = event.start_datetime?.split("T")[1] ?? "";
  const interval = event.weekly_interval && event.weekly_interval > 1
    ? `Every ${event.weekly_interval} weeks on `
    : "Weekly on ";
  return `${interval}${days.join(", ")}${time ? ` at ${time}` : ""}`;
}

export function buildAnnouncementEmbed(
  event: EventDetail,
  clubUrl: string,
  clubId: string,
): DiscordEmbed {
  let description = event.description ?? "";
  if (description.length > MAX_DESC_LEN) {
    description = description.slice(0, MAX_DESC_LEN) + "[...]";
  }

  const fields: DiscordField[] = [];

  const nextOccurrence = event.upcoming_occurrences[0];
  if (nextOccurrence) {
    const unix = Math.floor(new Date(nextOccurrence).getTime() / 1000);
    if (Number.isFinite(unix)) {
      fields.push({
        name: "When",
        value: `<t:${unix}:F> (<t:${unix}:R>)`,
      });
    }
  }

  const schedule = formatSchedule(event);
  if (schedule) {
    fields.push({ name: "Schedule", value: schedule });
  }

  if (event.address) {
    fields.push({ name: "Where", value: formatWhere(event.address) });
  }

  if (event.organizing_athlete) {
    fields.push({
      name: "Organizer",
      value: `${event.organizing_athlete.firstname} ${event.organizing_athlete.lastname}`,
    });
  }

  return {
    title: `New Event: ${event.title}`,
    url: `https://www.strava.com/clubs/${clubId}/group_events/${event.id}`,
    description,
    color: event.women_only ? COLOR_WOMEN : COLOR_NEW,
    fields,
    author: { name: "Strava Club Events", url: clubUrl },
  };
}

export async function postToDiscord(
  webhookUrl: string,
  embed: DiscordEmbed,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: BOT_USERNAME,
      embeds: [embed],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Discord webhook failed with status ${response.status}: ${body}`,
    );
  }
}

interface WebhookEnv {
  DISCORD_WEBHOOK_EVENTS_TEST: string;
  DISCORD_WEBHOOK_LADIES_TEST: string;
  DISCORD_WEBHOOK_EVENTS_LIVE: string;
  DISCORD_WEBHOOK_LADIES_LIVE: string;
}

export function getWebhookUrl(
  env: WebhookEnv,
  event: EventDetail,
  mode: string,
): string {
  if (event.women_only) {
    return mode === "test"
      ? env.DISCORD_WEBHOOK_LADIES_TEST
      : env.DISCORD_WEBHOOK_LADIES_LIVE;
  }
  return mode === "test"
    ? env.DISCORD_WEBHOOK_EVENTS_TEST
    : env.DISCORD_WEBHOOK_EVENTS_LIVE;
}
