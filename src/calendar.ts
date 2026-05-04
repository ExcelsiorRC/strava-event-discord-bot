import { Temporal } from "@js-temporal/polyfill";
import type { EventDetail } from "./types.ts";

const PRODID = "-//Excelsior Running Club//Strava Event Bot//EN";
const DEFAULT_DURATION_MIN = 60;
const FOLD_LIMIT = 75;

const DAY_TO_BYDAY: Record<string, string> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};

export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

export function foldIcsLine(line: string): string {
  if (line.length <= FOLD_LIMIT) return line;
  const out: string[] = [line.slice(0, FOLD_LIMIT)];
  let i = FOLD_LIMIT;
  while (i < line.length) {
    out.push(" " + line.slice(i, i + FOLD_LIMIT - 1));
    i += FOLD_LIMIT - 1;
  }
  return out.join("\r\n");
}

function compactLocal(iso: string): string {
  // "2025-06-24T05:45" -> "20250624T054500"
  // Accepts "T05:45" or "T05:45:30"
  const [date, time = "00:00"] = iso.split("T");
  const [y, m, d] = date.split("-");
  const parts = time.split(":");
  const hh = parts[0] ?? "00";
  const mm = parts[1] ?? "00";
  const ss = parts[2] ?? "00";
  return `${y}${m}${d}T${hh}${mm}${ss}`;
}

function compactUtc(instant: Temporal.Instant): string {
  // ISO instant -> "YYYYMMDDTHHMMSSZ"
  const iso = instant.toString({ smallestUnit: "second" });
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function formatNowUtc(): string {
  return compactUtc(Temporal.Now.instant());
}

export interface ClubEventOpts {
  clubUrl: string;
  /** Numeric Strava club ID, used for /group_events/ deep links — Strava 404s
   *  the slug form for those, only the numeric form lands on the event. */
  clubId: string;
  /** UTC timestamp string in "YYYYMMDDTHHMMSSZ" form, used for DTSTAMP */
  nowUtc: string;
}

function clubSummary(event: EventDetail): string {
  return event.women_only ? `🚺 ${event.title}` : event.title;
}

const COORD_ONLY = /^\(\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\)$/;

/**
 * Strava clubs that don't pin a real address fall back to a "(lat, lon)"
 * string. Calendar clients don't auto-link that form, so rewrite it as a
 * Google Maps URL — most clients render URLs in LOCATION as clickable.
 * Real address strings pass through unchanged so geocoding/map previews
 * still work.
 */
export function formatLocation(address: string): string {
  const m = address.match(COORD_ONLY);
  if (!m) return address;
  return `https://www.google.com/maps?q=${m[1]},${m[2]}`;
}

// Drop one-off VEVENTs whose occurrence is more than this far in the past so
// the calendar feed isn't cluttered with years-old workouts. Recurring events
// are unaffected — they emit a single RRULE that calendar clients expand.
const ONE_OFF_LOOKBACK_MONTHS = 6;

function parseCompactUtc(s: string): Temporal.Instant {
  // "YYYYMMDDTHHMMSSZ" → ISO instant
  const iso =
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` +
    `T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  return Temporal.Instant.from(iso);
}

export function clubEventVEvents(
  event: EventDetail,
  opts: ClubEventOpts,
): string[] {
  if (
    event.frequency === "weekly" &&
    event.days_of_week?.length &&
    event.start_datetime
  ) {
    return [renderWeekly(event, opts)];
  }
  const cutoff = parseCompactUtc(opts.nowUtc).subtract({
    hours: 24 * 30 * ONE_OFF_LOOKBACK_MONTHS,
  });
  return event.upcoming_occurrences
    .filter((occ) => {
      try {
        return (
          Temporal.Instant.compare(Temporal.Instant.from(occ), cutoff) >= 0
        );
      } catch {
        return false;
      }
    })
    .map((occ) => renderOneOff(event, occ, opts));
}

function renderWeekly(event: EventDetail, opts: ClubEventOpts): string {
  const startCompact = compactLocal(event.start_datetime!);
  const endZdt = Temporal.PlainDateTime.from(event.start_datetime!).add({
    minutes: DEFAULT_DURATION_MIN,
  });
  const endCompact = compactLocal(endZdt.toString({ smallestUnit: "minute" }));

  const byday = event
    .days_of_week!.map((d) => DAY_TO_BYDAY[d.toLowerCase()])
    .filter(Boolean)
    .join(",");
  const interval = event.weekly_interval ?? 1;
  const rrule =
    `FREQ=WEEKLY;BYDAY=${byday}` + (interval > 1 ? `;INTERVAL=${interval}` : "");

  return renderVEvent({
    uid: `club-${event.id}@strava`,
    dtstamp: opts.nowUtc,
    dtstart: `DTSTART;TZID=${event.zone}:${startCompact}`,
    dtend: `DTEND;TZID=${event.zone}:${endCompact}`,
    rrule,
    summary: clubSummary(event),
    location: formatLocation(event.address),
    description: event.description,
    url: `https://www.strava.com/clubs/${opts.clubId}/group_events/${event.id}`,
    categories: "club",
  });
}

function renderOneOff(
  event: EventDetail,
  occurrenceIso: string,
  opts: ClubEventOpts,
): string {
  const start = Temporal.Instant.from(occurrenceIso);
  const end = start.add({ minutes: DEFAULT_DURATION_MIN });
  return renderVEvent({
    uid: `club-${event.id}-${Math.floor(start.epochMilliseconds / 1000)}@strava`,
    dtstamp: opts.nowUtc,
    dtstart: `DTSTART:${compactUtc(start)}`,
    dtend: `DTEND:${compactUtc(end)}`,
    summary: clubSummary(event),
    location: formatLocation(event.address),
    description: event.description,
    url: `https://www.strava.com/clubs/${opts.clubId}/group_events/${event.id}`,
    categories: "club",
  });
}

interface VEventFields {
  uid: string;
  dtstamp: string;
  dtstart: string; // full line, including property name
  dtend: string;
  rrule?: string; // value only (no "RRULE:" prefix)
  summary: string;
  location: string;
  description: string;
  url: string;
  categories: string;
}

function renderVEvent(f: VEventFields): string {
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${f.uid}`,
    `DTSTAMP:${f.dtstamp}`,
    f.dtstart,
    f.dtend,
  ];
  if (f.rrule) lines.push(`RRULE:${f.rrule}`);
  lines.push(`SUMMARY:${escapeIcsText(f.summary)}`);
  if (f.location) lines.push(`LOCATION:${escapeIcsText(f.location)}`);
  if (f.description) lines.push(`DESCRIPTION:${escapeIcsText(f.description)}`);
  lines.push(`URL:${f.url}`);
  lines.push(`CATEGORIES:${f.categories}`);
  lines.push("END:VEVENT");
  return lines.map(foldIcsLine).join("\r\n");
}

export interface VCalendarParts {
  vtimezones?: string;
  vevents: string[];
  /** Display name shown by calendar clients on subscribe. Defaults to "ERC". */
  name?: string;
}

export const CLUB_SNAPSHOT_KEY = "calendar:club:snapshot";
export const CALENDAR_VERSION_KEY = "calendar:version";

export async function writeClubSnapshot(
  kv: KVNamespace,
  events: EventDetail[],
): Promise<void> {
  await kv.put(CLUB_SNAPSHOT_KEY, JSON.stringify(events));
}

/**
 * Sticky merge with deletion detection: keep existing snapshot entries that
 * are still on Strava (so events aged out of the recency filter persist with
 * their last-known data), overwrite with freshly-fetched details, and drop
 * anything not in the current Strava list (a deleted event should disappear
 * from members' calendars too).
 *
 * Returns true iff the merged snapshot differs from what's already in KV
 * (and was therefore written + version bumped). Sorted by id for a
 * deterministic comparison regardless of Strava's response order.
 */
export async function persistClubSnapshot(
  kv: KVNamespace,
  fetchedDetails: EventDetail[],
  currentStravaIds: Set<string>,
): Promise<boolean> {
  const existing = await readClubSnapshot(kv);
  const map = new Map<string, EventDetail>();
  for (const e of existing) {
    if (currentStravaIds.has(e.id)) map.set(e.id, e);
  }
  for (const e of fetchedDetails) {
    map.set(e.id, e);
  }
  const merged = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  const newJson = JSON.stringify(merged);
  const oldJson = await kv.get(CLUB_SNAPSHOT_KEY);
  if (newJson === oldJson) return false;
  await kv.put(CLUB_SNAPSHOT_KEY, newJson);
  await bumpCalendarVersion(kv);
  return true;
}

export async function readClubSnapshot(
  kv: KVNamespace,
): Promise<EventDetail[]> {
  const raw = await kv.get(CLUB_SNAPSHOT_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as EventDetail[];
}

export async function bumpCalendarVersion(kv: KVNamespace): Promise<void> {
  await kv.put(
    CALENDAR_VERSION_KEY,
    String(Temporal.Now.instant().epochMilliseconds),
  );
}

export async function getCalendarVersion(kv: KVNamespace): Promise<string> {
  return (await kv.get(CALENDAR_VERSION_KEY)) ?? "0";
}

const CAL_COLOR = "#FDFAD2"; // pale yellow
const CAL_TIMEZONE = "America/Los_Angeles";

/**
 * Self-contained VTIMEZONE for America/Los_Angeles. Strict ICS parsers
 * (notably Google Calendar) want the timezone defined inline rather than
 * relying on their own tzdb lookup of the bare TZID. Encodes the post-2007
 * US DST schedule, which is what every club event in 2025+ runs under.
 */
export const LA_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Los_Angeles",
  "BEGIN:DAYLIGHT",
  "DTSTART:20070311T020000",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZNAME:PDT",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:20071104T020000",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZNAME:PST",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

export function buildVCalendar(parts: VCalendarParts): string {
  const name = parts.name ?? "ERC";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    `X-WR-TIMEZONE:${CAL_TIMEZONE}`,
    `X-APPLE-CALENDAR-COLOR:${CAL_COLOR}`,
    `COLOR:${CAL_COLOR}`,
  ];
  const body: string[] = [];
  if (parts.vtimezones) body.push(parts.vtimezones);
  for (const v of parts.vevents) body.push(v);
  body.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n" + body.join("\r\n") + "\r\n";
}

const RACE_LABELS: Record<string, string> = {
  road: "Road",
  mut: "MUT",
  xc: "XC",
};
const RACE_TOKENS = ["road", "mut", "xc"] as const;

/**
 * Calendar display name derived from the `?include=` filter. Null means the
 * caller didn't pass `include` at all — short "ERC" is friendlier as the
 * default subscribe experience than spelling out every token.
 */
export function calendarName(includes: ReadonlySet<string> | null): string {
  if (!includes) return "ERC";
  const races = RACE_TOKENS.filter((t) => includes.has(t));
  if (races.length === 0) return "ERC";
  const racePart =
    races.length === RACE_TOKENS.length
      ? "PA Races"
      : `PA ${races.map((t) => RACE_LABELS[t]).join(" + ")}`;
  return includes.has("club") ? `ERC + ${racePart}` : `ERC ${racePart}`;
}
