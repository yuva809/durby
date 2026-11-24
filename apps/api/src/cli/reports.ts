import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { isLocalDate } from '@durby/shared';
import { ReportsRebuild } from '../modules/reports';
import { runCommand } from './run-command';

const USAGE = `Usage:
  reports rebuild --org <id> [--from YYYY-MM-DD]

Recomputes an organization's report data from the till and the bookings (docs/modules/reports.md → Rebuild). Needed once
per organization after the first release and after switching the reports feature on. Safe while the till is in use.
Audited (actor cli.reports). Prints JSON.`;

export interface ReportsCommand {
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
  if (values.help || positionals.length !== 1 || positionals[0] !== 'rebuild') {
    throw new UsageError(USAGE);
  }
  if (!org || !UUID.test(org)) throw new UsageError(USAGE);
  if (from === undefined) return { org };
  if (!isLocalDate(from)) throw new UsageError(USAGE);
  return { org, from: new Date(`${from}T00:00:00.000Z`) };
}

export async function runReportsCommand(
  app: INestApplicationContext,
  cmd: ReportsCommand,
  print: (line: string) => void = console.log,
): Promise<void> {
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
