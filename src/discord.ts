import type { EventDetail } from "./types.ts";
import type { Occurrence } from "./recurrence.ts";

const COLOR_GENERAL = 0x5865f2; // Discord blurple
const COLOR_WOMEN = 0xff7f50; // Coral
const MAX_DESC_LEN = 400;
const BOT_USERNAME = "Event Bot";

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
  footer: { text: string };
  author: { name: string; url: string };
}

export function buildEmbed(
  event: EventDetail,
  occurrence: Occurrence,
  clubUrl: string,
): DiscordEmbed {
  const unix = Math.floor(occurrence.instant.epochSeconds);

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
    fields.push({ name: "Where", value: event.address });
  }

  const footer = event.organizing_athlete
    ? `${event.organizing_athlete.firstname} ${event.organizing_athlete.lastname}`
    : "";

  return {
    title: event.title,
    url: `${clubUrl}/group_events/${event.id}`,
    description,
    color: event.women_only ? COLOR_WOMEN : COLOR_GENERAL,
    fields,
    footer: { text: footer },
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
