#!/usr/bin/env node

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

function helpLine(flag: string, desc: string): string {
  return `    ${c.highlight(flag)} ${c.dim(desc)}`;
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

${helpLine("whstats                ", "Show time statistics for the last 7 days (default)")}
${helpLine("whstats --week         ", "Show time statistics for the last 7 days (week)")}
${helpLine("whstats --month        ", "Show time statistics for the last 30 days (month)")}
${helpLine("whstats --year-to-date ", "Show time statistics from Jan 1 to today (-ytd)")}
${helpLine("whstats --brief        ", "Show concise output (daily totals only)")}
${helpLine("whstats --no-summary   ", "Show without aggregate summary (-n)")}
${helpLine("whstats --json         ", "Output results as JSON (-j)")}
${helpLine("whstats --setup        ", "Configure credentials (interactive)")}
${helpLine("whstats --config       ", "Show config file location")}
${helpLine("whstats --reset        ", "Delete saved configuration")}
${helpLine("whstats --help         ", "Show this help message")}
${helpLine("whstats --version      ", "Show version")}

  ${c.info("Configuration:")}
    Run ${c.highlight("'whstats --setup'")} to configure your credentials interactively.
    Credentials are stored in: ${c.dim("~/.config/whstats/config.json")}
`),
  );
}

function showVersion(): void {
  console.log(c.line(`whstats v${VERSION}`));
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
        c.line(`    Redmine API:       ${c.highlight(config.redmineApiKey.slice(0, 8))}...`),
      );
      console.log(c.line(`    MSSQL Server:      ${c.highlight(config.mssqlServer)}`));
      console.log(c.line(`    MSSQL Database:    ${c.highlight(config.mssqlDatabase)}`));
      console.log(c.line(`    MSSQL User:        ${c.highlight(config.mssqlUser)}`));
      console.log(c.line(`    User ID:           ${c.highlight(config.slackUserId)}`));
      console.log(
        c.line(`    Target hours/day:  ${c.highlight(`${config.targetHoursPerDay ?? 8}h`)}`),
      );
      const ignored = config.ignoredRedmineTicketIds ?? [];
      const ignoredLabel = ignored.length > 0 ? ignored.join(", ") : "(none)";
      console.log(c.line(`    Ignored tickets:   ${c.highlight(ignoredLabel)}\n`));
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
  showAggregates = true,
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
    console.log(renderJson(statsData, fromDate, toDate, brief, showAggregates));
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

  if (showAggregates) {
    for (const line of renderSummary(statsData.summary)) {
      console.log(line);
    }
    console.log("");
  }
}

async function runStats(
  days: number = 7,
  brief = false,
  showAggregates = true,
  json = false,
): Promise<void> {
  const { from, to } = getDateRange(days);
  await runStatsForRange(from, to, brief, showAggregates, json);
}

async function runStatsForRange(
  from: string,
  to: string,
  brief = false,
  showAggregates = true,
  json = false,
): Promise<void> {
  const config = getConfigOrExit();
  const ignoredTicketIds = new Set(config.ignoredRedmineTicketIds ?? []);

  try {
    const user = await fetchCurrentUser(config);
    if (!brief && !json) {
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
      brief,
      showAggregates,
      targetHours,
      ignoredTicketIds,
      json,
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

const COMMAND_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--setup",
  "-s",
  "--config",
  "-c",
  "--reset",
  "-r",
  "--week",
  "-w",
  "--month",
  "-m",
  "--year-to-date",
  "-ytd",
]);

const MODIFIER_FLAGS = new Set(["--brief", "-b", "--no-summary", "-n", "--json", "-j"]);

async function main(): Promise<void> {
  // Filter out script name (e.g., "index.ts") when running with bun
  const args = process.argv.slice(2).filter((arg) => !arg.endsWith(".ts") && !arg.endsWith(".js"));
  const brief = args.includes("--brief") || args.includes("-b");
  const showAggregates = !args.includes("--no-summary") && !args.includes("-n");
  const json = args.includes("--json") || args.includes("-j");

  // Check for unknown flags
  const unknownFlag = args.find(
    (arg) => arg.startsWith("-") && !COMMAND_FLAGS.has(arg) && !MODIFIER_FLAGS.has(arg),
  );
  if (unknownFlag) {
    console.error(c.line(`\n  ${c.warning(`Unknown flag: ${unknownFlag}`)}`));
    console.error(c.line(`  ${c.dim("Run 'whstats --help' for usage.")}\n`));
    process.exit(1);
  }

  // Command is either a known command flag or a non-flag argument
  const flagCommand = args.find((arg) => COMMAND_FLAGS.has(arg));
  const nonFlagArg = args.find((arg) => !arg.startsWith("-"));
  const command = flagCommand ?? nonFlagArg;

  switch (command) {
    case "--help":
    case "-h":
      showHelp();
      break;

    case "--version":
    case "-v":
      showVersion();
      break;

    case "--setup":
    case "-s":
      await handleSetup();
      break;

    case "--config":
    case "-c":
      showConfig();
      break;

    case "--reset":
    case "-r":
      handleReset();
      break;

    case "-w":
    case "--week":
      await runStats(7, brief, showAggregates, json);
      break;

    case "-m":
    case "--month":
      await runStats(30, brief, showAggregates, json);
      break;

    case "-ytd":
    case "--year-to-date": {
      const { from, to } = getYearToDateRange();
      await runStatsForRange(from, to, brief, showAggregates, json);
      break;
    }

    case undefined:
      await runStats(7, brief, showAggregates, json);
      break;

    default:
      console.error(c.line(`\n  ${c.warning(`Unknown command: ${command}`)}`));
      console.error(c.line(`  ${c.dim("Run 'whstats --help' for usage.")}\n`));
      process.exit(1);
  }
}

main();
