import { colors as c, stripAnsi } from "../colors.js";
import type { TimeEntry } from "../redmine.js";
import { formatHours, truncateComment, truncateProject } from "../utils.js";
import type { DayStats, SummaryData } from "./types.js";
import { TableBuilder } from "./table.js";

function colorizePercentageValue(value: number): string {
  const text = `${value}%`;
  if (value > 95) {
    return c.success(text);
  }
  if (value >= 90) {
    return c.warning(text);
  }
  return c.danger(text);
}

export function renderDayHeader(stats: DayStats): string[] {
  const clockedStr = stats.clocked > 0 ? formatHours(stats.clocked) : "-";
  const dayLine = `${stats.date} [${stats.dayName}]: ${formatHours(stats.rawBooked)} booked / ${clockedStr} clocked`;

  const line = stats.excludedFromTarget
    ? c.dim(dayLine)
    : `${c.info(stats.date)} ${c.dim(`[${stats.dayName}]`)}: ${formatHours(stats.rawBooked)} booked / ${stats.clocked > 0 ? c.highlight(clockedStr) : clockedStr} clocked`;

  return [c.line(line)];
}

export function renderEntries(entries: TimeEntry[], ignoredIds: ReadonlySet<number>): string[] {
  const lines: string[] = [];

  const isIgnored = (entry: TimeEntry): boolean => {
    const issueId = entry.issue?.id;
    return issueId !== undefined && ignoredIds.has(issueId);
  };

  for (const entry of entries) {
    const ignored = isIgnored(entry);
    const issueRef = entry.issue ? `#${entry.issue.id}` : "#N/A";
    const project = truncateProject(entry.project?.name || "N/A");
    const hours = formatHours(entry.hours).padStart(5, " ");
    const comment = truncateComment(entry.comments || "(no comment)");

    if (ignored) {
      lines.push(c.line(c.dim(`    ${hours} ${project} ${issueRef} ${comment}`)));
    } else {
      const renderedHours = c.highlight(hours);
      lines.push(
        c.line(
          `    ${renderedHours} ${c.warning(project)} ${c.danger(issueRef)} ${c.dim(comment)}`,
        ),
      );
    }
  }

  return lines;
}

function buildSummaryTable(data: SummaryData): { lines: string[]; maxWidth: number } {
  const table = new TableBuilder();
  const bookedSign = data.discrepancies.booked > 0 ? "+" : "";
  const clockedSign = data.discrepancies.clocked > 0 ? "+" : "";

  table
    .column({ align: "left", minWidth: 12 }) // label
    .column({ align: "right" }) // past
    .column({ align: "center", width: 1 }) // +
    .column({ align: "right" }) // today
    .column({ align: "center", width: 1 }) // =
    .column({ align: "right" }) // %
    .column({ align: "left" }); // note

  const pastDaysTarget = data.targetTotal - data.adjustedCurrentDayTarget;

  table.addRow([
    "    Target:",
    c.highlight(formatHours(pastDaysTarget)),
    "+",
    c.highlight(formatHours(data.adjustedCurrentDayTarget)),
    "",
    "",
    "",
  ]);

  table.addRow([
    "    Booked:",
    c.highlight(formatHours(data.booked.past)),
    "+",
    c.highlight(formatHours(data.booked.today)),
    "=",
    colorizePercentageValue(data.percentages.booked),
    c.dim(`(${bookedSign}${formatHours(data.discrepancies.booked)})`),
  ]);

  table.addRow([
    "    Clocked:",
    c.highlight(formatHours(data.clocked.past)),
    "+",
    c.highlight(formatHours(data.clocked.today)),
    "=",
    colorizePercentageValue(data.percentages.clocked),
    c.dim(`(${clockedSign}${formatHours(data.discrepancies.clocked)})`),
  ]);

  table.addRow([
    "    Efficiency:",
    "",
    "",
    "",
    "",
    colorizePercentageValue(data.percentages.efficiency),
    c.dim("(booked/clocked ratio)"),
  ]);

  const lines = table.render();
  const maxWidth = Math.max(...lines.map((line) => stripAnsi(line).length));

  return { lines, maxWidth };
}

export function renderSummary(data: SummaryData): string[] {
  const { lines, maxWidth } = buildSummaryTable(data);

  const header = `Summary (${data.workdays} days)`;
  const separatorWidth = Math.max(maxWidth, header.length);
  const separator = c.line("─".repeat(separatorWidth));

  const result: string[] = [];
  result.push(separator);
  result.push(c.line(`Summary ${c.dim(`(${data.workdays} days)`)}`));
  result.push(...lines);

  return result;
}
