import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { PermissionSplitReport, type SplitReportLine } from '../platform/rbac/permission-split';
import { runCommand } from './run-command';

const USAGE = `Usage:
  rbac:split --dry-run

The dry run of the ADR 0051 migration (split broad permission keys). Reads only. For every organization, prints
each custom role, member with permission changes and open invitation with permission changes that the migration
gives rows, the rows, and whether their effective permissions stay the same ("unchanged"). Ends with a summary.
Run it before the deploy and keep the output; after the deploy it prints no rows (the migration is idempotent).
Prints ids and role names, never emails.`;

export function parseRbacSplitArgs(argv: string[]): { dryRun: true } {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help || !values['dry-run']) throw new Error(USAGE);
  return { dryRun: true };
}

/** One line per role, member or invitation, then the summary; exit code 1 when anything would change. */
export function formatSplitReport(lines: readonly SplitReportLine[]): {
  text: string;
  ok: boolean;
} {
  const out = lines.map(
    (l) =>
      `${l.organizationId} ${l.kind} ${l.id} (${l.role}): + ${l.adds.join(', ')} | ${
        l.unchanged
          ? 'unchanged'
          : `CHANGED lost=[${l.lost.join(', ')}] gained=[${l.gained.join(', ')}]`
      }`,
  );
  const changed = lines.filter((l) => !l.unchanged).length;
  const orgs = new Set(lines.map((l) => l.organizationId)).size;
  out.push(
    `summary: ${lines.length} roles, members or invitations in ${orgs} organizations get new keys; ${changed} would change effective permissions`,
  );
  return { text: out.join('\n'), ok: changed === 0 };
}

export async function runRbacSplit(app: INestApplicationContext): Promise<void> {
  const { text, ok } = formatSplitReport(await app.get(PermissionSplitReport).run());
  console.log(text);
  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    parseRbacSplitArgs(process.argv.slice(2));
    void runCommand('rbac:split', runRbacSplit);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
