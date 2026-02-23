import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import * as readline from "readline";

const CONFIG_DIR = join(homedir(), ".config", "whstats");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  redmineApiKey: string;
  redmineUrl: string;
  mssqlServer: string;
  mssqlDatabase: string;
  mssqlUser: string;
  mssqlPassword: string;
  slackUserId: string;
  targetHoursPerDay?: number;
  ignoredRedmineTicketIds?: number[];
}

function parseIgnoredTicketIds(input: string): { ids: number[]; invalid: string[] } {
  if (!input.trim()) {
    return { ids: [], invalid: [] };
  }

  const parts = input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const invalid: string[] = [];
  const ids: number[] = [];

  for (const part of parts) {
    const num = Number(part);
    if (Number.isInteger(num) && num > 0) {
      ids.push(num);
    } else {
      invalid.push(part);
    }
  }

  return { ids: Array.from(new Set(ids)), invalid };
}

function normalizeConfig(config: Config): Config {
  return {
    ...config,
    ignoredRedmineTicketIds: Array.isArray(config.ignoredRedmineTicketIds)
      ? config.ignoredRedmineTicketIds
        .filter((id) => Number.isInteger(id) && id > 0)
      : [],
  };
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(content) as Config;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(normalizeConfig(config), null, 2), { mode: 0o600 });
}

export function deleteConfig(): boolean {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
    return true;
  }
  return false;
}

function prompt(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const displayQuestion = defaultValue
    ? `${question} [${defaultValue}]: `
    : `${question}: `;

  return new Promise((resolve) => {
    rl.question(displayQuestion, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function promptPassword(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(`${question}: `);

    // Disable echo for password input
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let password = "";

    const onData = (char: Buffer) => {
      const c = char.toString();

      switch (c) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl+D
          if (stdin.isTTY) {
            stdin.setRawMode(false);
          }
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(password);
          break;
        case "\u0003": // Ctrl+C
          if (stdin.isTTY) {
            stdin.setRawMode(false);
          }
          process.exit(1);
          break;
        case "\u007F": // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            stdout.write("\b \b");
          }
          break;
        default:
          password += c;
          stdout.write("*");
      }
    };

    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function promptForConfig(existingConfig?: Config | null): Promise<Config> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n  WH Stats Configuration\n");
  console.log("  Enter your credentials (press Enter to keep existing values)\n");

  try {
    const config: Config = {
      redmineUrl: await prompt(rl, "  Redmine URL", existingConfig?.redmineUrl ?? "https://redmine.wirth-horn.de/"),
      redmineApiKey: await prompt(rl, "  Redmine API Key", existingConfig?.redmineApiKey),
      mssqlServer: await prompt(rl, "  MSSQL Server", existingConfig?.mssqlServer ?? "10.10.10.15"),
      mssqlDatabase: await prompt(rl, "  MSSQL Database", existingConfig?.mssqlDatabase ?? "wh_timelogger"),
      mssqlUser: await prompt(rl, "  MSSQL User", existingConfig?.mssqlUser),
      mssqlPassword: await prompt(rl, "  MSSQL Password", existingConfig?.mssqlPassword),
      slackUserId: await prompt(rl, "  User ID (in timelogger). Use /wh debug in Slack to find it.", existingConfig?.slackUserId),
      targetHoursPerDay: parseFloat(await prompt(rl, "  Target hours per day", existingConfig?.targetHoursPerDay?.toString() ?? "8")),
    };

    // Handle ignored ticket IDs separately to validate and warn about invalid inputs
    const ticketIdsInput = await prompt(
      rl,
      "  Ignored Redmine ticket IDs (comma-separated)",
      existingConfig?.ignoredRedmineTicketIds?.join(",") ?? ""
    );
    const parsedTickets = parseIgnoredTicketIds(ticketIdsInput);
    if (parsedTickets.invalid.length > 0) {
      console.log(`  Warning: Ignored invalid ticket ID(s): ${parsedTickets.invalid.join(", ")}`);
    }
    config.ignoredRedmineTicketIds = parsedTickets.ids;

    rl.close();

    // Validate required fields
    const missingFields: string[] = [];
    if (!config.redmineUrl) missingFields.push("Redmine URL");
    if (!config.redmineApiKey) missingFields.push("Redmine API Key");
    if (!config.mssqlServer) missingFields.push("MSSQL Server");
    if (!config.mssqlDatabase) missingFields.push("MSSQL Database");
    if (!config.mssqlUser) missingFields.push("MSSQL User");
    if (!config.mssqlPassword) missingFields.push("MSSQL Password");
    if (!config.slackUserId) missingFields.push("User ID");

    if (missingFields.length > 0) {
      console.error(`\n  Error: Missing required fields: ${missingFields.join(", ")}`);
      process.exit(1);
    }

    // Validate target hours (must be positive number, default to 8 if invalid)
    if (isNaN(config.targetHoursPerDay!) || config.targetHoursPerDay! <= 0) {
      console.log("  Warning: Invalid target hours, using default of 8");
      config.targetHoursPerDay = 8;
    }

    if ((existingConfig?.ignoredRedmineTicketIds?.length ?? 0) > 0 && config.ignoredRedmineTicketIds!.length === 0) {
      console.log("  Note: Ignored ticket list cleared.");
    }

    // Normalize URL
    config.redmineUrl = config.redmineUrl.replace(/\/$/, "");

    saveConfig(config);
    console.log(`\n  Config saved to ${CONFIG_FILE}\n`);

    return config;
  } catch (error) {
    rl.close();
    throw error;
  }
}

export function getConfigOrExit(): Config {
  const config = loadConfig();
  if (config) {
    return config;
  }

  console.error("\n  No configuration found.\n");
  console.error("  Run 'whstats --setup' to configure your credentials.\n");
  process.exit(1);
}
