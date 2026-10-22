import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { emailRequestSchema } from '@durby/shared';
import { PasswordService } from '../platform/auth';
import { ProvisioningService } from '../platform/provisioning';
import { runCommand } from './run-command';

const USAGE = `Usage: create-admin --email <email> --org <organization name> [--locale en|de]

Creates the default partner, the organization (with its system roles), the user and an Owner
membership if missing, then emails the user a link to set their password. Safe to run again: nothing is duplicated or
overwritten, and a fresh link is sent. Never takes a password and never creates demo data.`;

/** The default partner (ARCHITECTURE.md: Durby itself is the default partner). */
export const DEFAULT_PARTNER = { slug: 'durby', name: 'Durby' } as const;

export interface CreateAdminInput {
  email: string;
  org: string;
  locale: string;
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
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) throw new UsageError(USAGE);
  const email = emailRequestSchema.safeParse({ email: values.email });
  const org = values.org?.trim();
  if (!email.success || !org) throw new UsageError(USAGE);
  if (!['en', 'de'].includes(values.locale)) throw new UsageError(USAGE);
  return { email: email.data.email, org, locale: values.locale };
}

export async function createAdmin(
  app: INestApplicationContext,
  input: CreateAdminInput,
): Promise<CreateAdminResult> {
  const provisioning = app.get(ProvisioningService);
  const partner = await provisioning.ensurePartner(DEFAULT_PARTNER.slug, DEFAULT_PARTNER.name);
  const organization = await provisioning.ensureOrganization(partner.id, input.org);
  const user = await provisioning.ensureUser(input.email, { locale: input.locale });
  const membership = await provisioning.ensureMembership(organization.id, user.id, 'owner');
  await app.get(PasswordService).sendPasswordSetMail(user.id);
  return { partner, organization, user, membership };
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
    console.log(`partner       ${DEFAULT_PARTNER.slug}: ${state(result.partner)}`);
    console.log(
      `organization  ${input.org} (${result.organization.id}): ${state(result.organization)}`,
    );
    console.log(`user          ${input.email} (${result.user.id}): ${state(result.user)}`);
    console.log(`membership    ${state(result.membership)}`);
    console.log(`Password-set email sent to ${input.email}.`);
  });
}
