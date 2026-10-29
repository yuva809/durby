import { parseArgs } from 'node:util';
import type { INestApplicationContext } from '@nestjs/common';
import { emailRequestSchema, STAFF_ROLES, type StaffMember, type StaffRole } from '@durby/shared';
import { StaffService } from '../platform/staff';
import { runCommand } from './run-command';

const USAGE = `Usage: create-staff --email <email> --role ${STAFF_ROLES.join('|')}

Bootstraps Durby staff for the admin portal (docs/platform/admin-portal.md): creates the staff
account if missing (the email must be in STAFF_EMAIL_DOMAINS) and emails an invitation link to set
a password and two-factor authentication. Safe to run again while the account is still invited: a
fresh link is sent and older ones stop working. Never takes a password. Create two super admins:
the portal always keeps at least 2 active.`;

export interface CreateStaffInput {
  email: string;
  role: StaffRole;
}

export function parseCreateStaffArgs(argv: string[]): CreateStaffInput {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) throw new UsageError(USAGE);
  const email = emailRequestSchema.safeParse({ email: values.email });
  const role = STAFF_ROLES.find((r) => r === values.role);
  if (!email.success || role === undefined) throw new UsageError(USAGE);
  return { email: email.data.email, role };
}

export function createStaff(
  app: INestApplicationContext,
  input: CreateStaffInput,
): Promise<StaffMember> {
  return app.get(StaffService).invite({ system: 'cli.create_staff' }, input.email, input.role);
}

class UsageError extends Error {}

// Entry point when run with node (CJS build); skipped when imported (tests).
if (typeof require !== 'undefined' && require.main === module) {
  let input: CreateStaffInput;
  try {
    input = parseCreateStaffArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    process.exit(2);
  }
  void runCommand('create-staff', async (app) => {
    const member = await createStaff(app, input);
    console.log(`staff   ${member.email} (${member.id}): ${member.role}, ${member.status}`);
    console.log(`Invitation email sent to ${member.email}.`);
  });
}
