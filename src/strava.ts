import type { EventDetail } from "./types.ts";
import { cacheDetailKey } from "./state.ts";

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";
const CACHE_TTL = 86400; // 24 hours

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

export async function refreshStravaToken(
  kv: KVNamespace,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const refreshToken = await kv.get("strava:refresh_token");
  if (!refreshToken) {
    throw new Error("No refresh_token in KV — run OAuth bootstrap first");
  }

  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Strava token refresh failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };

  // Persist rotated refresh token BEFORE any other work
  await kv.put("strava:refresh_token", data.refresh_token);

  return data.access_token;
}

/**
 * Extract top-level event IDs from the list response.
 *
 * Strava IDs can exceed Number.MAX_SAFE_INTEGER (newer ones are 19 digits).
 * Quote any 15+digit "id" before JSON.parse so precision is preserved, then
 * read e.id from each top-level array element. This avoids hand-rolling a
 * brace counter, which mishandles `{` and `}` inside string literals (e.g.
 * descriptions with unbalanced braces) and silently drops events.
 */
export function safeParseIds(text: string): string[] {
  const safe = text.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"');
  const arr = JSON.parse(safe) as Array<{ id?: string | number }>;
  return arr.filter((e) => e.id !== undefined).map((e) => String(e.id));
}

const PER_PAGE = 200;
const MAX_PAGES = 10;

export async function fetchEventIds(
  accessToken: string,
  clubId: string,
): Promise<string[]> {
  const all: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(
      `${STRAVA_API}/clubs/${clubId}/group_events?per_page=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Strava list events failed (${response.status}): ${body}`,
      );
    }
    const text = await response.text();
    const ids = safeParseIds(text);
    all.push(...ids);
    if (ids.length < PER_PAGE) break;
  }
  return all;
}

export async function fetchEventDetail(
  kv: KVNamespace,
  accessToken: string,
  eventId: string,
): Promise<EventDetail> {
  const key = cacheDetailKey(eventId);

  // Check cache first
  const cached = await kv.get(key);
  if (cached) {
    return JSON.parse(cached) as EventDetail;
  }

  const response = await fetch(
    `${STRAVA_API}/group_events/${eventId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (response.status === 429) {
    throw new RateLimitedError(`Strava rate limit hit while fetching ${eventId}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Strava detail fetch failed for ${eventId} (${response.status}): ${body}`,
    );
  }

  const text = await response.text();

  // Quote large IDs before JSON.parse to prevent precision loss
  const safeText = text.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"');
  const data = JSON.parse(safeText) as Record<string, unknown>;

  // Ensure top-level id is a string
  const detail: EventDetail = {
    id: String(data.id),
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    women_only: Boolean(data.women_only),
    private: Boolean(data.private),
    zone: String(data.zone ?? ""),
    address: String(data.address ?? ""),
    frequency: data.frequency ? String(data.frequency) : undefined,
    days_of_week: data.days_of_week as string[] | undefined,
    weekly_interval: data.weekly_interval as number | undefined,
    start_datetime: data.start_datetime
      ? String(data.start_datetime)
      : undefined,
    upcoming_occurrences: (data.upcoming_occurrences as string[]) ?? [],
    organizing_athlete: data.organizing_athlete as
      | { firstname: string; lastname: string }
      | undefined,
  };

  // Cache with 24h TTL — store the normalized detail, not raw
  await kv.put(key, JSON.stringify(detail), { expirationTtl: CACHE_TTL });

  return detail;
}
