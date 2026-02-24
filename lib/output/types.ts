import type { TimeEntry } from "../redmine.js";

export interface DayStats {
  date: string;
  dayName: string;
  rawBooked: number;
  effectiveBooked: number;
  clocked: number;
  excludedFromTarget: boolean;
  entries: TimeEntry[];
}

export interface SummaryData {
  workdays: number;
  targetHoursPerDay: number;
  targetTotal: number;
  hasAdjustedCurrentDayTarget: boolean;
  adjustedCurrentDayTarget: number;
  booked: { total: number; past: number; today: number };
  clocked: { total: number; past: number; today: number };
  discrepancies: { booked: number; clocked: number };
  percentages: { booked: number; clocked: number; efficiency: number };
  currentDate: string;
  isClockRunningToday: boolean;
}

export interface StatsData {
  days: DayStats[];
  summary: SummaryData;
}
