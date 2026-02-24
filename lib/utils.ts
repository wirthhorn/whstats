import type { TimeEntry } from "./redmine.js";

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDateRange(days: number = 7): { from: string; to: string } {
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - days);
  return { from: formatDate(fromDate), to: formatDate(today) };
}

export function getYearToDateRange(): { from: string; to: string } {
  const today = new Date();
  const fromDate = new Date(today.getFullYear(), 0, 1);
  return { from: formatDate(fromDate), to: formatDate(today) };
}

export function formatHours(hours: number): string {
  if (hours % 1 === 0) {
    return `${hours}h`;
  }
  return `${hours.toFixed(2)}h`;
}

export function truncateComment(comment: string, maxLength: number = 50): string {
  if (comment.length <= maxLength) return comment;
  return comment.substring(0, maxLength - 3) + "...";
}

export function truncateProject(name: string, maxLength: number = 5): string {
  name = name.replace(/[\s\.\-#&]/g, "");
  if (name.length <= maxLength) return name.padEnd(maxLength, " ");
  return name.substring(0, maxLength);
}

export function getDayName(dateStr: string): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[new Date(dateStr).getDay()]!;
}

export function groupByDate(entries: TimeEntry[]): Map<string, TimeEntry[]> {
  const grouped = new Map<string, TimeEntry[]>();

  for (const entry of entries) {
    const date = entry.spent_on;
    if (!grouped.has(date)) {
      grouped.set(date, []);
    }
    grouped.get(date)!.push(entry);
  }

  return grouped;
}

export function isIgnoredEntry(entry: TimeEntry, ignoredTicketIds: ReadonlySet<number>): boolean {
  const issueId = entry.issue?.id;
  return issueId !== undefined && ignoredTicketIds.has(issueId);
}

export function calculateEffectiveBookedHours(
  entries: TimeEntry[],
  ignoredTicketIds: ReadonlySet<number>,
): number {
  return entries.reduce((sum, entry) => {
    return isIgnoredEntry(entry, ignoredTicketIds) ? sum : sum + entry.hours;
  }, 0);
}

export function calculateRawBookedHours(entries: TimeEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.hours, 0);
}
