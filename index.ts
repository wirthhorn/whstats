#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  getConfigOrExit,
  promptForConfig,
  loadConfig,
  deleteConfig,
  getConfigPath,
  configExists,
} from "./lib/config.js";
import { fetchCurrentUser, fetchTimeEntries, type TimeEntry } from "./lib/redmine.js";
import { fetchClockedHours } from "./lib/mssql.js";
import {
  getDateRange,
  getYearToDateRange,
  getYearRange,
  formatHours,
  groupByDate,
  calculateNetBookedHours,
  calculateGrossBookedHours,
} from "./lib/utils.js";
import { colors as c } from "./lib/colors.js";
import { VERSION } from "./lib/version.js";
import type { DayStats, SummaryData, StatsData } from "./lib/output/types.js";
import { renderDayHeader, renderEntries, renderSummary } from "./lib/output/human.js";
import { render as renderJson } from "./lib/output/json.js";

// ============================================================================
// Unified Command & Modifier Registry
// ============================================================================

type CommandType = "action" | "range-days" | "range-fn";

interface ModifierDef {
  name: string;
  short?: string;
  description: string;
}

interface CommandDef {
  name: string;
  short?: string;
  aliases?: string[];
  description: string;
  type: CommandType;
  handler: ((ctx: RunContext) => void | Promise<void>) | number | (() => { from: string; to: string });
  exampleArg: string;
}

interface RunContext {
  brief: boolean;
  json: boolean;
}

// Modifier flags that can combine with any range command
const MODIFIERS: readonly ModifierDef[] = [
  { name: "brief", short: "b", description: "Show concise output (daily totals only)" },
  { name: "json", short: "j", description: "Output results as JSON" },
];

const COMMANDS: readonly CommandDef[] = [
  {
    name: "week",
    short: "w",
    description: "Show time statistics for the last 7 days",
    type: "range-days",
    handler: 7,
    exampleArg: "--week",
  },
  {
    name: "month",
    short: "m",
    description: "Show time statistics for the last 30 days",
    type: "range-days",
    handler: 30,
    exampleArg: "--month",
  },
  {
    name: "year",
    short: "y",
    description: "Show time statistics for the past 365 days",
    type: "range-fn",
    handler: getYearRange,
    exampleArg: "--year",
  },
  {
    name: "year-to-date",
    short: "Y",
    description: "Show time statistics from Jan 1 to today",
    type: "range-fn",
    handler: getYearToDateRange,
    exampleArg: "--year-to-date",
  },
  {
    name: "config",
    aliases: ["setup"],
    description: "Configure credentials (interactive)",
    type: "action",
    handler: async () => handleSetup(),
    exampleArg: "--config",
  },
  {
    name: "show-config",
    description: "Show config file location and current settings",
    type: "action",
    handler: async () => showConfig(),
    exampleArg: "--show-config",
  },
  {
    name: "reset",
    description: "Delete saved configuration",
    type: "action",
    handler: async () => handleReset(),
    exampleArg: "--reset",
  },
  {
    name: "help",
    short: "h",
    description: "Show this help message",
    type: "action",
    handler: async () => showHelp(),
    exampleArg: "--help",
  },
  {
    name: "version",
    short: "v",
    description: "Show version",
    type: "action",
    handler: async () => showVersion(),
    exampleArg: "--version",
  },
];

// Build parseArgs options from both commands and modifiers
function buildParseArgsOptions(): Record<string, { type: "boolean"; short?: string }> {
  const options: Record<string, { type: "boolean"; short?: string }> = {};
  for (const cmd of COMMANDS) {
    if (cmd.short) {
      options[cmd.name] = { type: "boolean", short: cmd.short };
    } else {
      options[cmd.name] = { type: "boolean" };
    }
  }
  for (const mod of MODIFIERS) {
    if (mod.short) {
      options[mod.name] = { type: "boolean", short: mod.short };
    } else {
      options[mod.name] = { type: "boolean" };
    }
  }
  return options;
}

// Build help text from registry
function buildHelpLines(): string {
  const MAX_FLAG_WIDTH = 23;
  const lines: string[] = [];

  // Default command
  lines.push(helpLine("whstats", "Show time statistics for the last 7 days (default)", MAX_FLAG_WIDTH));

  // Commands from registry
  for (const cmd of COMMANDS) {
    const aliasText = cmd.aliases?.length ? ` (alias: ${cmd.aliases.join(", ")})` : "";
    const shortText = cmd.short ? ` (-${cmd.short})` : "";
    const fullDesc = `${cmd.description}${aliasText}${shortText}`;
    lines.push(helpLine(`whstats ${cmd.exampleArg}`, fullDesc, MAX_FLAG_WIDTH));
  }

  // Modifier flags from registry
  for (const mod of MODIFIERS) {
    const shortText = mod.short ? ` (-${mod.short})` : "";
    lines.push(helpLine(`whstats --${mod.name}`, `${mod.description}${shortText}`, MAX_FLAG_WIDTH));
  }

  return lines.join("\n");
}

// Find command definition by resolved name
function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find(
    (cmd) => cmd.name === name || cmd.short === name || cmd.aliases?.includes(name),
  );
}

// Resolve which command to run based on parsed values and positionals
function resolveCommand(
  values: Record<string, boolean | undefined>,
  positionals: string[],
): string | null {
  for (const cmd of COMMANDS) {
    if (values[cmd.name]) return cmd.name;
  }
  return positionals[0] ?? null;
}

// Build RunContext from parsed values
function buildRunContext(values: Record<string, boolean | undefined>): RunContext {
  return {
    brief: values.brief ?? false,
    json: values.json ?? false,
  };
}

// ============================================================================
// End of Unified Registry
// ============================================================================

function helpLine(flag: string, desc: string, width = 23): string {
  const padded = flag.padEnd(width, " ");
  return `    ${c.highlight(padded)} ${c.dim(desc)}`;
}

function showHelp(): void {
  console.log(
    c.line(`
  ${c.info(`WH Stats`)} ${c.dim(`v${VERSION}`)}

  Compare booked hours (Redmine) vs clocked hours (timelogger).

  ${c.info("Usage:")}
    A) Run ${c.highlight(`"npx whstats"`)} to execute without installing globally.
    B) Alternatively, install with ${c.highlight(`'npm install -g whstats'`)} and run ${c.highlight(`'whstats'`)}.
       Update with ${c.highlight(`'npm update -g whstats --latest'`)}.

${buildHelpLines()}

  ${c.info("Configuration:")}
    Run ${c.highlight("'whstats --config'")} to configure your credentials interactively.
    Credentials are stored in: ${c.dim("~/.config/whstats/config.json")}
`),
  );
}

function showVersion(): void {
  console.log(c.line(`whstats v${VERSION}`));
}

function maskSecret(_value: string): string {
  return "**********";
}

function showConfig(): void {
  const configPath = getConfigPath();
  const exists = configExists();

  console.log(c.line(`\n  Config file: ${configPath}`));
  console.log(
    c.line(`  Status: ${exists ? c.success("configured") : c.warning("not configured")}\n`),
  );

  if (exists) {
    const config = loadConfig();
    if (config) {
      console.log(c.line("  Current settings:"));
      console.log(c.line(`    Redmine URL:       ${c.highlight(config.redmineUrl)}`));
      console.log(
        c.line(`    Redmine API Key:   ${c.highlight(maskSecret(config.redmineApiKey))}`),
      );
      console.log(c.line(`    MSSQL Server:      ${c.highlight(config.mssqlServer)}`));
      console.log(c.line(`    MSSQL Database:    ${c.highlight(config.mssqlDatabase)}`));
      console.log(c.line(`    MSSQL User:        ${c.highlight(config.mssqlUser)}`));
      console.log(
        c.line(`    MSSQL Password:    ${c.highlight(maskSecret(config.mssqlPassword))}`),
      );
      console.log(c.line(`    Slack User ID:     ${c.highlight(maskSecret(config.slackUserId))}`));
      console.log(
        c.line(`    Target hours/day:  ${c.highlight(`${config.targetHoursPerDay ?? 8}h`)}`),
      );
      const ignored = config.ignoredRedmineTicketIds ?? [];
      const ignoredLabel = ignored.length > 0 ? ignored.join(", ") : "(none)";
      console.log(c.line(`    Ignored tickets:   ${c.highlight(ignoredLabel)}`));
      console.log("");
    }
  }
}

async function handleSetup(): Promise<void> {
  const existing = loadConfig();
  await promptForConfig(existing);
}

function handleReset(): void {
  if (deleteConfig()) {
    console.log(c.line(`\n  ${c.success("Configuration deleted.")}\n`));
  } else {
    console.log(c.line(`\n  ${c.warning("No configuration file found.")}\n`));
  }
}

function prepareStatsData(
  entries: TimeEntry[],
  clockedHours: Map<string, number>,
  currentDate: string,
  isCurrentDayClockRunning: boolean,
  targetHoursPerDay: number,
  ignoredTicketIds: ReadonlySet<number>,
): StatsData {
  const isIgnored = (entry: TimeEntry): boolean => {
    const issueId = entry.issue?.id;
    return issueId !== undefined && ignoredTicketIds.has(issueId);
  };

  const grouped = groupByDate(entries);

  // Combine all dates from both sources
  const allDates = new Set([...grouped.keys(), ...clockedHours.keys()]);
  const sortedDates = Array.from(allDates).sort();

  const dayStats: DayStats[] = sortedDates.map((date) => {
    const dayEntries = grouped.get(date) || [];
    const grossBooked = calculateGrossBookedHours(dayEntries);
    const netBooked = calculateNetBookedHours(dayEntries, ignoredTicketIds);
    const clocked = clockedHours.get(date) || 0;
    const excludedFromNet =
      dayEntries.length > 0 && dayEntries.every((entry) => isIgnored(entry)) && clocked === 0;

    return {
      date,
      dayName: new Date(date).toLocaleDateString("en-US", { weekday: "short" }),
      grossBooked,
      netBooked,
      clocked,
      excludedFromNet,
      entries: dayEntries,
    };
  });

  // Calculate totals
  let totalBooked = 0;
  let totalClocked = 0;
  for (const stats of dayStats) {
    totalBooked += stats.netBooked;
    totalClocked += stats.clocked;
  }

  const eligibleDayStats = dayStats.filter((stats) => !stats.excludedFromNet);
  const workdays = eligibleDayStats.length;
  const currentDayStats = dayStats.find((stats) => stats.date === currentDate);
  const hasCurrentDateInRange = currentDayStats !== undefined;

  let targetTotal = 0;
  let hasPartialCurrentDayTarget = false;
  let partialCurrentDayTarget = 0;

  for (const stats of eligibleDayStats) {
    let dayTarget = targetHoursPerDay;
    if (isCurrentDayClockRunning && stats.date === currentDate) {
      const clockedToday = stats.clocked;
      dayTarget = Math.min(clockedToday, targetHoursPerDay);
      hasPartialCurrentDayTarget = dayTarget !== targetHoursPerDay;
      partialCurrentDayTarget = dayTarget;
    }
    targetTotal += dayTarget;
  }

  const bookedToday = currentDayStats?.netBooked ?? 0;
  const bookedPastDays = totalBooked - bookedToday;
  const clockedToday = hasCurrentDateInRange ? currentDayStats?.clocked || 0 : 0;
  const clockedPastDays = totalClocked - clockedToday;

  const bookedDiscrepancy = totalBooked - targetTotal;
  const clockedDiscrepancy = totalClocked - targetTotal;
  const bookedPct = targetTotal > 0 ? Math.round((totalBooked / targetTotal) * 100) : 0;
  const clockedPct = targetTotal > 0 ? Math.round((totalClocked / targetTotal) * 100) : 0;
  const efficiency = totalClocked > 0 ? Math.round((totalBooked / totalClocked) * 100) : 0;

  const summary: SummaryData = {
    workdays,
    targetHoursPerDay,
    targetTotal,
    hasPartialCurrentDayTarget,
    partialCurrentDayTarget,
    booked: {
      total: totalBooked,
      past: bookedPastDays,
      today: bookedToday,
    },
    clocked: {
      total: totalClocked,
      past: clockedPastDays,
      today: clockedToday,
    },
    discrepancies: {
      booked: bookedDiscrepancy,
      clocked: clockedDiscrepancy,
    },
    percentages: {
      booked: bookedPct,
      clocked: clockedPct,
      efficiency,
    },
    currentDate,
    isClockRunningToday: isCurrentDayClockRunning,
  };

  return { days: dayStats, summary };
}

function displayResults(
  entries: TimeEntry[],
  clockedHours: Map<string, number>,
  currentDate: string,
  isCurrentDayClockRunning: boolean,
  brief = false,
  targetHoursPerDay = 8,
  ignoredTicketIds: ReadonlySet<number> = new Set<number>(),
  json = false,
  fromDate = "",
  toDate = "",
): void {
  const statsData = prepareStatsData(
    entries,
    clockedHours,
    currentDate,
    isCurrentDayClockRunning,
    targetHoursPerDay,
    ignoredTicketIds,
  );

  if (json) {
    console.log(renderJson(statsData, fromDate, toDate, brief));
    return;
  }

  console.log("");

  for (const day of statsData.days) {
    for (const line of renderDayHeader(day)) {
      console.log(line);
    }

    if (!brief) {
      for (const line of renderEntries(day.entries, ignoredTicketIds)) {
        console.log(line);
      }
      console.log("");
    }
  }

  for (const line of renderSummary(statsData.summary)) {
    console.log(line);
  }
  console.log("");
}

async function runStats(
  days: number,
  ctx: RunContext,
): Promise<void> {
  const { from, to } = getDateRange(days);
  await runStatsForRange(from, to, ctx);
}

async function runStatsForRange(
  from: string,
  to: string,
  ctx: RunContext,
): Promise<void> {
  const config = getConfigOrExit();
  const ignoredTicketIds = new Set(config.ignoredRedmineTicketIds ?? []);

  try {
    const user = await fetchCurrentUser(config);
    if (!ctx.brief && !ctx.json) {
      console.log(
        c.line(`\n${c.info(`Fetching time entries for ${user.firstname} ${user.lastname}...`)}`),
      );
    }

    const [entries, clockedData] = await Promise.all([
      fetchTimeEntries(config, user.id, from, to),
      fetchClockedHours(config, from, to),
    ]);

    const targetHours = config.targetHoursPerDay ?? 8;
    displayResults(
      entries,
      clockedData.hoursByDate,
      clockedData.today,
      clockedData.isClockRunningToday,
      ctx.brief,
      targetHours,
      ignoredTicketIds,
      ctx.json,
      from,
      to,
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(c.line(`\n  ${c.danger(`Error: ${error.message}`)}\n`));
    } else {
      console.error(c.line(`\n  ${c.danger("An unexpected error occurred.")}\n`));
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: buildParseArgsOptions(),
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unknown option")) {
      const unknownFlag = error.message.match(/'([^']+)'/)?.[1] ?? "unknown";
      console.error(c.line(`\n  ${c.warning(`Unknown flag: ${unknownFlag}`)}`));
      console.error(c.line(`  ${c.dim("Run 'whstats --help' for usage.")}\n`));
      process.exit(1);
    }
    throw error;
  }

  const { values, positionals } = parsed;
  const ctx = buildRunContext(values);

  // Resolve and execute command
  const commandName = resolveCommand(values, positionals);

  // Default case: no command specified
  if (commandName === null) {
    await runStats(7, ctx);
    return;
  }

  // Find command definition
  const commandDef = findCommand(commandName);

  if (!commandDef) {
    console.error(c.line(`\n  ${c.warning(`Unknown command: ${commandName}`)}`));
    console.error(c.line(`  ${c.dim("Run 'whstats --help' for usage.")}\n`));
    process.exit(1);
  }

  // Execute based on command type
  switch (commandDef.type) {
    case "action": {
      const handler = commandDef.handler as (ctx: RunContext) => void | Promise<void>;
      await handler(ctx);
      break;
    }

    case "range-days": {
      const days = commandDef.handler as number;
      await runStats(days, ctx);
      break;
    }

    case "range-fn": {
      const rangeFn = commandDef.handler as () => { from: string; to: string };
      const { from, to } = rangeFn();
      await runStatsForRange(from, to, ctx);
      break;
    }
  }
}

main();
