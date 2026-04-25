/** Sanitized event fixtures for testing — all data is fictional */

export type { EventDetail } from "../src/types.ts";

/** Weekly Tue/Fri at 05:45 LA time, interval 1 */
export const weeklyTueFri: EventDetail = {
  id: "9990001",
  title: "Morning Group Run",
  description: "Easy pace around the park loop.",
  women_only: false,
  private: false,
  zone: "America/Los_Angeles",
  address: "(37.77, -122.46)",
  frequency: "weekly",
  days_of_week: ["tuesday", "friday"],
  weekly_interval: 1,
  start_datetime: "2025-06-24T05:45",
  upcoming_occurrences: ["2026-04-28T12:45:00Z"],
  organizing_athlete: { firstname: "Jane", lastname: "Doe" },
};

/** Biweekly Monday at 18:00 LA time — every other week starting 2025-06-23 (a Monday) */
export const biweeklyMonday: EventDetail = {
  id: "9990002",
  title: "Track Session",
  description: "Track workout every other Monday.",
  women_only: false,
  private: false,
  zone: "America/Los_Angeles",
  address: "City Stadium",
  frequency: "weekly",
  days_of_week: ["monday"],
  weekly_interval: 2,
  start_datetime: "2025-06-23T18:00",
  upcoming_occurrences: [],
  organizing_athlete: { firstname: "John", lastname: "Smith" },
};

/** No frequency — relies on upcoming_occurrences from detail */
export const noFrequency: EventDetail = {
  id: "9990003",
  title: "One-Off Trail Run",
  description: "Special group trail run.",
  women_only: false,
  private: false,
  zone: "America/Los_Angeles",
  address: "Trailhead Parking",
  frequency: undefined,
  days_of_week: undefined,
  weekly_interval: undefined,
  start_datetime: undefined,
  upcoming_occurrences: [
    "2026-04-27T17:00:00Z",
    "2026-05-15T17:00:00Z",
  ],
  organizing_athlete: { firstname: "Alex", lastname: "Johnson" },
};

/** Monthly frequency — falls through to upcoming_occurrences */
export const monthlyEvent: EventDetail = {
  id: "9990004",
  title: "Monthly Social",
  description: "Monthly gathering.",
  women_only: false,
  private: false,
  zone: "America/Los_Angeles",
  address: "Park Pavilion",
  frequency: "monthly",
  days_of_week: undefined,
  weekly_interval: undefined,
  start_datetime: "2025-07-01T10:00",
  upcoming_occurrences: ["2026-04-27T17:00:00Z"],
  organizing_athlete: { firstname: "Pat", lastname: "Lee" },
};

/** Women-only weekly Wednesday at 06:00 LA */
export const womenOnlyWeekly: EventDetail = {
  id: "9990005",
  title: "Women's Run",
  description: "Women-only group run.",
  women_only: true,
  private: false,
  zone: "America/Los_Angeles",
  address: "North Park",
  frequency: "weekly",
  days_of_week: ["wednesday"],
  weekly_interval: 1,
  start_datetime: "2025-07-02T06:00",
  upcoming_occurrences: [],
  organizing_athlete: { firstname: "Sam", lastname: "Chen" },
};
