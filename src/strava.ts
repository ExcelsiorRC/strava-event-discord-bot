import type { EventDetail } from "./types.ts";
import { cacheDetailKey } from "./state.ts";

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";
const CACHE_TTL = 86400; // 24 hours

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
 * Extract top-level event IDs from the list response raw text.
 * Handles IDs that exceed Number.MAX_SAFE_INTEGER by extracting them as strings
 * directly from the JSON text before parsing.
 *
 * Strategy: Each event in the array starts with {"id":DIGITS. We extract
 * by finding array-level object boundaries. Since the list response is a
 * flat array of event objects, we look for the pattern where "id" is the
 * first key after an object-open brace that follows [ or ,
 */
export function safeParseIds(text: string): string[] {
  const ids: string[] = [];
  // Match the top-level array elements: objects that start right after [ or ,
  // Each starts with {"id": or { "id":
  // We need to avoid nested {"id": inside club/route/athlete objects
  // Strategy: track brace depth. At depth 1 (inside the top-level array),
  // the first "id" we see is the event id.

  let depth = 0;
  let i = 0;
  let justEnteredObject = false;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "[" || ch === "{") {
      depth++;
      if (ch === "{" && depth === 2) {
        justEnteredObject = true;
      }
      i++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      i++;
    } else if (justEnteredObject && ch === '"') {
      // Look for "id" key at start of depth-2 object
      if (text.startsWith('"id"', i)) {
        // Find the colon, then the number
        let j = i + 4;
        while (j < text.length && text[j] !== ":") j++;
        j++; // skip colon
        while (j < text.length && text[j] === " ") j++; // skip spaces
        // Extract the number as a string
        let numStart = j;
        while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
        if (j > numStart) {
          ids.push(text.slice(numStart, j));
        }
        justEnteredObject = false;
      } else {
        justEnteredObject = false;
      }
      i++;
    } else {
      if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t" && ch !== ",") {
        justEnteredObject = false;
      }
      i++;
    }
  }

  return ids;
}

export async function fetchEventIds(
  accessToken: string,
  clubId: string,
): Promise<string[]> {
  const response = await fetch(
    `${STRAVA_API}/clubs/${clubId}/group_events`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Strava list events failed (${response.status}): ${body}`,
    );
  }

  const text = await response.text();
  return safeParseIds(text);
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
