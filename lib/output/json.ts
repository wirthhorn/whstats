import type { DayStats, StatsData } from "./types.js";
import type { TimeEntry } from "../redmine.js";
import { VERSION } from "../version.js";

interface JsonEntry {
  id: number;
  project: { id: number; name: string };
  issue?: { id: number };
  hours: number;
  comments: string;
}

interface JsonDay {
  date: string;
  dayName: string;
  grossBooked: number;
  netBooked: number;
  clocked: number;
  excludedFromNet: boolean;
  entries: JsonEntry[];
}

interface JsonSummary {
  workdays: number;
  targetHoursPerDay: number;
  targetTotal: number;
  hasPartialCurrentDayTarget: boolean;
  partialCurrentDayTarget: number;
  booked: { total: number; past: number; today: number };
  clocked: { total: number; past: number; today: number };
  discrepancies: { booked: number; clocked: number };
  percentages: { booked: number; clocked: number; efficiency: number };
  currentDate: string;
  isClockRunningToday: boolean;
}

interface JsonMeta {
  version: string;
  generatedAt: string;
  dateRange: { from: string; to: string };
}

interface JsonOutput {
  meta: JsonMeta;
  summary?: JsonSummary;
  days: JsonDay[];
}

function transformEntry(entry: TimeEntry): JsonEntry {
  return {
    id: entry.id,
    project: {
      id: entry.project.id,
      name: entry.project.name,
    },
    issue: entry.issue ? { id: entry.issue.id } : undefined,
    hours: entry.hours,
    comments: entry.comments ?? "(no comment)",
  };
}

function transformDay(day: DayStats, brief = false): JsonDay {
  return {
    date: day.date,
    dayName: day.dayName,
    grossBooked: day.grossBooked,
    netBooked: day.netBooked,
    clocked: day.clocked,
    excludedFromNet: day.excludedFromNet,
    entries: brief ? [] : day.entries.map(transformEntry),
  };
}

export function render(
  statsData: StatsData,
  fromDate: string,
  toDate: string,
  brief = false,
): string {
  const output: JsonOutput = {
    meta: {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      dateRange: {
        from: fromDate,
        to: toDate,
      },
    },
    days: statsData.days.map((day) => transformDay(day, brief)),
    summary: {
      workdays: statsData.summary.workdays,
      targetHoursPerDay: statsData.summary.targetHoursPerDay,
      targetTotal: statsData.summary.targetTotal,
      hasPartialCurrentDayTarget: statsData.summary.hasPartialCurrentDayTarget,
      partialCurrentDayTarget: statsData.summary.partialCurrentDayTarget,
      booked: statsData.summary.booked,
      clocked: statsData.summary.clocked,
      discrepancies: statsData.summary.discrepancies,
      percentages: statsData.summary.percentages,
      currentDate: statsData.summary.currentDate,
      isClockRunningToday: statsData.summary.isClockRunningToday,
    },
  };

  return JSON.stringify(output, null, 2);
}
