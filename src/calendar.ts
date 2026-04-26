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
  /** UTC timestamp string in "YYYYMMDDTHHMMSSZ" form, used for DTSTAMP */
  nowUtc: string;
}

function clubSummary(event: EventDetail): string {
  return event.women_only ? `🚺 ${event.title}` : event.title;
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
  return event.upcoming_occurrences.map((occ) => renderOneOff(event, occ, opts));
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
    location: event.address,
    description: event.description,
    url: `${opts.clubUrl}/group_events/${event.id}`,
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
    location: event.address,
    description: event.description,
    url: `${opts.clubUrl}/group_events/${event.id}`,
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
 * Write the snapshot only when its serialized form differs from what's
 * currently in KV. Returns true if it changed (and was written + version
 * bumped), false if it was a no-op. Sorting by id makes the comparison
 * deterministic regardless of the order Strava returns events in.
 */
export async function persistClubSnapshot(
  kv: KVNamespace,
  events: EventDetail[],
): Promise<boolean> {
  const sorted = [...events].sort((a, b) => a.id.localeCompare(b.id));
  const newJson = JSON.stringify(sorted);
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

export function buildVCalendar(parts: VCalendarParts): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
  ];
  const body: string[] = [];
  if (parts.vtimezones) body.push(parts.vtimezones);
  for (const v of parts.vevents) body.push(v);
  body.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n" + body.join("\r\n") + "\r\n";
}
