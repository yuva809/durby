import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { isLocalDate } from '@durby/shared';
import { DailyReport, ReportsRebuild } from '../modules/reports';
import { runCommand } from './run-command';

const USAGE = `Usage:
  reports rebuild --org <id> [--from YYYY-MM-DD]
  reports daily --org <id>

Recomputes an organization's report data from the till and the bookings (docs/modules/reports.md → Rebuild). Needed once
per organization after the first release and after switching the reports feature on. Safe while the till is in use.
Audited (actor cli.reports). Prints JSON.

daily: sends the owners yesterday's sales now (docs/modules/reports.md → Daily report) without waiting for the time set.
Only once per day, and only after the day has ended. Prints the result: sent, done (already sent), early, no_orders, off.`;

export interface ReportsCommand {
  name: 'rebuild' | 'daily';
  org: string;
  from?: Date;
}

export class UsageError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReportsArgs(argv: string[]): ReportsCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      org: { type: 'string' },
      from: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const { org, from } = values;
  const [name] = positionals;
  if (values.help || positionals.length !== 1 || (name !== 'rebuild' && name !== 'daily')) {
    throw new UsageError(USAGE);
  }
  if (!org || !UUID.test(org)) throw new UsageError(USAGE);
  if (from === undefined) return { name, org };
  if (name === 'daily' || !isLocalDate(from)) throw new UsageError(USAGE);
  return { name, org, from: new Date(`${from}T00:00:00.000Z`) };
}

export async function runReportsCommand(
  app: INestApplicationContext,
  cmd: ReportsCommand,
  print: (line: string) => void = console.log,
): Promise<void> {
  if (cmd.name === 'daily') {
    print(JSON.stringify({ result: await app.get(DailyReport).send(cmd.org, { force: true }) }));
    return;
  }
  print(JSON.stringify(await app.get(ReportsRebuild).rebuild(cmd.org, cmd.from)));
}

// Entry point when run with node (CJS build); skipped when imported (tests).
if (typeof require !== 'undefined' && require.main === module) {
  let cmd: ReportsCommand;
  try {
    cmd = parseReportsArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  void runCommand('reports', (app) => runReportsCommand(app, cmd));
}
