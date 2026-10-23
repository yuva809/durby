import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { OutboxAdmin } from '../platform/outbox';
import { runCommand } from './run-command';

const USAGE = `Usage:
  outbox dead-letters      [--org <id>]
  outbox retry             --org <id> --event <id>
  outbox handler-failures
  outbox retry-handler     --job <jobId>

Lists and retries dead-lettered outbox events and handler jobs that exhausted their retries
(docs/platform/outbox.md → CLI). Retries are audited (actor cli.outbox). Prints JSON lines.`;

export type OutboxCommand =
  | { command: 'dead-letters'; org?: string }
  | { command: 'retry'; org: string; event: string }
  | { command: 'handler-failures' }
  | { command: 'retry-handler'; job: string };

export class UsageError extends Error {}

export function parseOutboxArgs(argv: string[]): OutboxCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      org: { type: 'string' },
      event: { type: 'string' },
      job: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  const { org, event, job } = values;
  if (values.help || rest.length > 0) throw new UsageError(USAGE);
  switch (command) {
    case 'dead-letters':
      if (event !== undefined || job !== undefined) break;
      return org === undefined ? { command } : { command, org };
    case 'retry':
      if (!org || !event || job !== undefined) break;
      return { command, org, event };
    case 'handler-failures':
      if (org !== undefined || event !== undefined || job !== undefined) break;
      return { command };
    case 'retry-handler':
      if (!job || org !== undefined || event !== undefined) break;
      return { command, job };
  }
  throw new UsageError(USAGE);
}

export async function runOutboxCommand(
  app: INestApplicationContext,
  cmd: OutboxCommand,
  print: (line: string) => void = console.log,
): Promise<void> {
  const admin = app.get(OutboxAdmin);
  switch (cmd.command) {
    case 'dead-letters':
      for (const row of await admin.deadLetters(cmd.org)) print(JSON.stringify(row));
      return;
    case 'retry':
      await admin.retry(cmd.org, cmd.event);
      print(JSON.stringify({ retried: cmd.event }));
      return;
    case 'handler-failures':
      for (const row of await admin.handlerFailures()) print(JSON.stringify(row));
      return;
    case 'retry-handler':
      await admin.retryHandler(cmd.job);
      print(JSON.stringify({ retried: cmd.job }));
      return;
  }
}

// Entry point when run with node (CJS build); skipped when imported (tests).
if (typeof require !== 'undefined' && require.main === module) {
  let cmd: OutboxCommand;
  try {
    cmd = parseOutboxArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  void runCommand('outbox', (app) => runOutboxCommand(app, cmd));
}
