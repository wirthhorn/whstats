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
  hasAdjustedCurrentDayTarget: boolean;
  adjustedCurrentDayTarget: number;
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

function transformDay(day: DayStats): JsonDay {
  return {
    date: day.date,
    dayName: day.dayName,
    grossBooked: day.grossBooked,
    netBooked: day.netBooked,
    clocked: day.clocked,
    excludedFromNet: day.excludedFromNet,
    entries: day.entries.map(transformEntry),
  };
}

export function render(
  statsData: StatsData,
  fromDate: string,
  toDate: string,
  brief = false,
  showSummary = true,
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
    days: brief ? [] : statsData.days.map(transformDay),
  };

  if (showSummary) {
    output.summary = {
      workdays: statsData.summary.workdays,
      targetHoursPerDay: statsData.summary.targetHoursPerDay,
      targetTotal: statsData.summary.targetTotal,
      hasAdjustedCurrentDayTarget: statsData.summary.hasAdjustedCurrentDayTarget,
      adjustedCurrentDayTarget: statsData.summary.adjustedCurrentDayTarget,
      booked: statsData.summary.booked,
      clocked: statsData.summary.clocked,
      discrepancies: statsData.summary.discrepancies,
      percentages: statsData.summary.percentages,
      currentDate: statsData.summary.currentDate,
      isClockRunningToday: statsData.summary.isClockRunningToday,
    };
  }

  return JSON.stringify(output, null, 2);
}
