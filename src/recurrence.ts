import { Temporal } from "@js-temporal/polyfill";
import type { EventDetail } from "./types.ts";

export interface Occurrence {
  eventId: string;
  instant: Temporal.Instant;
  isoKey: string; // UTC ISO string for KV dedup key
}

const WINDOW_HOURS = 25;

const DAY_MAP: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export function expandOccurrences(
  event: EventDetail,
  now: Temporal.Instant,
): Occurrence[] {
  if (
    event.frequency === "weekly" &&
    event.days_of_week &&
    event.days_of_week.length > 0 &&
    event.start_datetime
  ) {
    return expandWeekly(event, now);
  }
  return expandFromUpcoming(event, now);
}

function expandWeekly(
  event: EventDetail,
  now: Temporal.Instant,
): Occurrence[] {
  const zone = event.zone;
  const startPDT = Temporal.PlainDateTime.from(event.start_datetime!);
  const startZDT = startPDT.toZonedDateTime(zone);
  const startInstant = startZDT.toInstant();
  const startDate = startPDT.toPlainDate();
  const timeOfDay = startPDT.toPlainTime();

  const windowStart = now;
  const windowEnd = now.add({ hours: WINDOW_HOURS });

  // If the event hasn't started yet and starts beyond our window, nothing to do
  if (Temporal.Instant.compare(startInstant, windowEnd) > 0) {
    return [];
  }

  const targetDays = new Set(
    event.days_of_week!.map((d) => DAY_MAP[d.toLowerCase()]),
  );
  const interval = event.weekly_interval ?? 1;

  // Convert window to local dates for iteration
  const localStart = now.toZonedDateTimeISO(zone).toPlainDate();
  const localEnd = windowEnd.toZonedDateTimeISO(zone).toPlainDate();

  // Iterate from day before windowStart to day after windowEnd (to catch timezone edge cases)
  const iterStart = localStart.subtract({ days: 1 });
  const iterEnd = localEnd.add({ days: 1 });

  // Compute start date's Monday for week alignment
  const startMonday = startDate.subtract({
    days: startDate.dayOfWeek - 1,
  });

  const results: Occurrence[] = [];
  let current = iterStart;

  while (Temporal.PlainDate.compare(current, iterEnd) <= 0) {
    if (targetDays.has(current.dayOfWeek)) {
      // Check weekly interval
      const candidateMonday = current.subtract({
        days: current.dayOfWeek - 1,
      });
      const daysBetween = candidateMonday.since(startMonday, {
        largestUnit: "days",
      }).days;
      const weeksBetween = daysBetween / 7;

      if (weeksBetween >= 0 && weeksBetween % interval === 0) {
        // Construct the ZonedDateTime for this candidate
        const candidateZDT = current
          .toPlainDateTime(timeOfDay)
          .toZonedDateTime(zone, { disambiguation: "compatible" });
        const candidateInstant = candidateZDT.toInstant();

        // Must be >= start and within [now, now+25h]
        if (
          Temporal.Instant.compare(candidateInstant, startInstant) >= 0 &&
          Temporal.Instant.compare(candidateInstant, windowStart) >= 0 &&
          Temporal.Instant.compare(candidateInstant, windowEnd) <= 0
        ) {
          results.push({
            eventId: event.id,
            instant: candidateInstant,
            isoKey: candidateInstant.toString(),
          });
        }
      }
    }
    current = current.add({ days: 1 });
  }

  return results;
}

function expandFromUpcoming(
  event: EventDetail,
  now: Temporal.Instant,
): Occurrence[] {
  const windowEnd = now.add({ hours: WINDOW_HOURS });
  const results: Occurrence[] = [];

  for (const occ of event.upcoming_occurrences) {
    const inst = Temporal.Instant.from(occ);
    if (
      Temporal.Instant.compare(inst, now) >= 0 &&
      Temporal.Instant.compare(inst, windowEnd) <= 0
    ) {
      results.push({
        eventId: event.id,
        instant: inst,
        isoKey: inst.toString(),
      });
    }
  }

  return results;
}
