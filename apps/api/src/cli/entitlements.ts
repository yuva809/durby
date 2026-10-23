import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { EntitlementsAdmin, type OrganizationEntitlements } from '../platform/config/entitlements';
import { runCommand } from './run-command';

const USAGE = `Usage:
  entitlements show            --org <id>
  entitlements set-plan        --org <id> --plan <key>
  entitlements override        --org <id> --feature <key> --enable [--limits '<json>']
  entitlements override        --org <id> --feature <key> --disable
  entitlements clear-override  --org <id> --feature <key>

Changes an organization's plan and feature overrides (docs/platform/entitlements.md). Every change
is audited (actor cli.entitlements) in the same transaction; a no-op writes nothing. Plan contents
change only through migrations. Prints the resulting entitlements.`;

export type EntitlementsCommand =
  | { command: 'show'; org: string }
  | { command: 'set-plan'; org: string; plan: string }
  | { command: 'override'; org: string; feature: string; enabled: boolean; limits: unknown }
  | { command: 'clear-override'; org: string; feature: string };

export class UsageError extends Error {}

export function parseEntitlementsArgs(argv: string[]): EntitlementsCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      org: { type: 'string' },
      plan: { type: 'string' },
      feature: { type: 'string' },
      enable: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
      limits: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  const { org, plan, feature, enable, disable, limits } = values;
  if (values.help || rest.length > 0 || !org) throw new UsageError(USAGE);
  const none = (...flags: unknown[]) => flags.every((f) => f === undefined || f === false);
  switch (command) {
    case 'show':
      if (!none(plan, feature, enable, disable, limits)) break;
      return { command, org };
    case 'set-plan':
      if (!plan || !none(feature, enable, disable, limits)) break;
      return { command, org, plan };
    case 'override': {
      if (!feature || plan !== undefined || enable === disable) break;
      if (limits !== undefined && !enable) break;
      return { command, org, feature, enabled: enable, limits: parseJson(limits) };
    }
    case 'clear-override':
      if (!feature || !none(plan, enable, disable, limits)) break;
      return { command, org, feature };
  }
  throw new UsageError(USAGE);
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new UsageError(`--limits is not valid JSON\n\n${USAGE}`);
  }
}

export interface EntitlementsResult {
  changed: boolean;
  state: OrganizationEntitlements;
}

export async function runEntitlements(
  app: INestApplicationContext,
  cmd: EntitlementsCommand,
): Promise<EntitlementsResult> {
  const admin = app.get(EntitlementsAdmin);
  const actor = 'cli.entitlements';
  let changed = false;
  switch (cmd.command) {
    case 'show':
      break;
    case 'set-plan':
      ({ changed } = await admin.setPlan(cmd.org, cmd.plan, actor));
      break;
    case 'override':
      ({ changed } = await admin.setOverride(cmd.org, cmd.feature, cmd.enabled, cmd.limits, actor));
      break;
    case 'clear-override':
      ({ changed } = await admin.clearOverride(cmd.org, cmd.feature, actor));
      break;
  }
  return { changed, state: await admin.show(cmd.org) };
}

/** Operator output (English: CLI only, not user-facing UI). */
export function formatEntitlements({ changed, state }: EntitlementsResult): string[] {
  const lines = [
    `organization  ${state.organizationId}`,
    `plan          ${state.planKey ?? '(none: nothing from a plan is enabled)'}`,
  ];
  for (const o of state.overrides) {
    const limits = o.limits ? ` ${JSON.stringify(o.limits)}` : '';
    lines.push(`override      ${o.featureKey}: ${o.enabled ? 'enable' : 'disable'}${limits}`);
  }
  for (const [key, limits] of state.resolved.features) {
    const shown = Object.entries(limits).map(([n, v]) => `${n}=${v ?? 'unlimited'}`);
    lines.push(`enabled       ${key}${shown.length ? ` (${shown.join(', ')})` : ''}`);
  }
  for (const key of state.blockedByDependency) {
    lines.push(`warning       ${key} stays disabled: a feature it depends on is disabled`);
  }
  lines.push(changed ? 'Changed (audited).' : 'No change.');
  return lines;
}

// Entry point when run with node (CJS build); skipped when imported (tests).
if (typeof require !== 'undefined' && require.main === module) {
  let cmd: EntitlementsCommand;
  try {
    cmd = parseEntitlementsArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  void runCommand('entitlements', async (app) => {
    for (const line of formatEntitlements(await runEntitlements(app, cmd))) console.log(line);
  });
}
