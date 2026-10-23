import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { emailRequestSchema, PLAN_KEYS, type PlanKey } from '@durby/shared';
import { PasswordService } from '../platform/auth';
import { ProvisioningService } from '../platform/provisioning';
import { runCommand } from './run-command';

const USAGE = `Usage: create-admin --email <email> --org <organization name> [--locale en|de]
                    [--plan ${PLAN_KEYS.join('|')}] [--partner <slug>]

Creates the default partner (or uses --partner, which must exist: other partners come from
migrations with their theme and domains), the organization (with its system roles, on --plan, default full; an
existing organization keeps its plan), the user and an Owner
membership if missing, then emails the user a link to set their password. Safe to run again: nothing is duplicated or
overwritten, and a fresh link is sent. Never takes a password and never creates demo data.`;

/** The default partner (ARCHITECTURE.md: Durby itself is the default partner). */
export const DEFAULT_PARTNER = { slug: 'durby', name: 'Durby' } as const;

export interface CreateAdminInput {
  email: string;
  org: string;
  locale: string;
  plan: PlanKey;
  /** Slug of an existing partner; default: the default partner (created if missing). */
  partner?: string;
}

export interface CreateAdminResult {
  partner: { id: string; created: boolean };
  organization: { id: string; created: boolean };
  user: { id: string; created: boolean };
  membership: { id: string; created: boolean };
}

export function parseCreateAdminArgs(argv: string[]): CreateAdminInput {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      org: { type: 'string' },
      locale: { type: 'string', default: 'en' },
      plan: { type: 'string', default: 'full' },
      partner: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) throw new UsageError(USAGE);
  const email = emailRequestSchema.safeParse({ email: values.email });
  const org = values.org?.trim();
  if (!email.success || !org) throw new UsageError(USAGE);
  if (!['en', 'de'].includes(values.locale)) throw new UsageError(USAGE);
  const plan = PLAN_KEYS.find((key) => key === values.plan);
  if (plan === undefined) throw new UsageError(USAGE);
  const partner = values.partner?.trim();
  if (partner !== undefined && !/^[a-z0-9-]+$/.test(partner)) throw new UsageError(USAGE);
  return { email: email.data.email, org, locale: values.locale, plan, ...(partner && { partner }) };
}

export async function createAdmin(
  app: INestApplicationContext,
  input: CreateAdminInput,
): Promise<CreateAdminResult> {
  const provisioning = app.get(ProvisioningService);
  const partner = await resolvePartner(provisioning, input.partner);
  const organization = await provisioning.ensureOrganization(
    partner.id,
    input.org,
    'cli.create_admin',
    input.plan,
  );
  const user = await provisioning.ensureUser(input.email, { locale: input.locale });
  const membership = await provisioning.ensureMembership(
    organization.id,
    user.id,
    'owner',
    'cli.create_admin',
  );
  await app.get(PasswordService).sendPasswordSetMail(user.id);
  return { partner, organization, user, membership };
}

async function resolvePartner(
  provisioning: ProvisioningService,
  slug: string | undefined,
): Promise<CreateAdminResult['partner']> {
  if (slug === undefined || slug === DEFAULT_PARTNER.slug) {
    return provisioning.ensurePartner(DEFAULT_PARTNER.slug, DEFAULT_PARTNER.name);
  }
  const partner = await provisioning.findPartner(slug);
  if (!partner) throw new Error(`Partner "${slug}" does not exist (partners come from migrations)`);
  return { id: partner.id, created: false };
}

class UsageError extends Error {}

// Entry point when run with node (CJS build); skipped when imported (tests).
if (typeof require !== 'undefined' && require.main === module) {
  let input: CreateAdminInput;
  try {
    input = parseCreateAdminArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    process.exit(2);
  }
  void runCommand('create-admin', async (app) => {
    const result = await createAdmin(app, input);
    const state = (r: { created: boolean }) => (r.created ? 'created' : 'exists');
    console.log(`partner       ${input.partner ?? DEFAULT_PARTNER.slug}: ${state(result.partner)}`);
    console.log(
      `organization  ${input.org} (${result.organization.id}): ${state(result.organization)}`,
    );
    console.log(`user          ${input.email} (${result.user.id}): ${state(result.user)}`);
    console.log(`membership    ${state(result.membership)}`);
    console.log(`Password-set email sent to ${input.email}.`);
  });
}
