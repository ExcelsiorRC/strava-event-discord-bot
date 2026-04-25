export interface EventDetail {
  id: string;
  title: string;
  description: string;
  women_only: boolean;
  private: boolean;
  zone: string;
  address: string;
  frequency?: string;
  days_of_week?: string[];
  weekly_interval?: number;
  start_datetime?: string;
  upcoming_occurrences: string[];
  organizing_athlete?: { firstname: string; lastname: string };
}
