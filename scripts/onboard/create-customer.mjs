#!/usr/bin/env node
/**
 * Creates a customer organization (AsiaMight) through the platform onboarding API, as a platform admin. The owner gets
 * an invitation link and sets their own permanent password there; this script never takes or sets a password.
 *
 *   PLATFORM_API=https://app.durby.tech/api/v1 \
 *   STAFF_EMAIL=<your admin email> STAFF_PASSWORD='<your admin password>' \
 *   node scripts/onboard/create-customer.mjs --name AsiaMight --owner asiamight01@gmail.com --partner AsiaMight [--dry-run]
 *
 * Node 20 or later. Stops with a clear message on a duplicate name or owner (ask before creating a second one).
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    owner: { type: 'string' },
    partner: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

const API = (process.env.PLATFORM_API ?? '').replace(/\/+$/, '');
const STAFF_EMAIL = process.env.STAFF_EMAIL;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!values.name || !values.owner) fail('Usage: --name <organization name> --owner <owner email> [--partner <name>]');
if (!API || !STAFF_EMAIL || !STAFF_PASSWORD) fail('Set PLATFORM_API, STAFF_EMAIL and STAFF_PASSWORD (nothing is stored).');

async function call(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'POST' && path === '/platform/customers') headers['idempotency-key'] = crypto.randomUUID();
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail(`Cannot reach ${API}: ${error.cause?.code ?? error.message}`);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, json, code: json?.code ?? `http_${res.status}` };
}

// 1. Sign in as platform staff.
const login = await call('POST', '/auth/login', { body: { email: STAFF_EMAIL, password: STAFF_PASSWORD } });
if (!login.ok) fail(`Admin sign-in failed: ${login.code}`);
const token = login.json.accessToken;

// 2. Find the partner by name (default: Durby, as the API does).
const options = await call('GET', '/platform/onboarding-options', { token });
if (!options.ok) fail(`Cannot read onboarding options: ${options.code}`);
let partnerId;
if (values.partner) {
  const partners = options.json.partners ?? [];
  const match = partners.find((p) => p.name.toLowerCase() === values.partner.toLowerCase());
  if (!match) fail(`No partner named "${values.partner}". Partners: ${partners.map((p) => p.name).join(', ')}`);
  partnerId = match.id;
}

const body = {
  name: values.name,
  ownerEmail: values.owner,
  ownerLocale: 'en',
  plan: 'full',
  ...(partnerId ? { partnerId } : {}),
};

if (values['dry-run']) {
  console.log('DRY RUN. Would create:', JSON.stringify({ ...body, ownerEmail: '(owner)' }));
  process.exit(0);
}

// 3. Create. A known name or owner needs a deliberate second run with confirmDuplicates.
const created = await call('POST', '/platform/customers', { token, body });
if (!created.ok) {
  if (created.code === 'staff.customer_duplicate') {
    fail(
      `Not created: a customer with this name or owner already exists (${JSON.stringify(created.json?.details ?? {})}). ` +
        'Check it in the admin portal before creating another.',
    );
  }
  fail(`Not created: ${created.code}`);
}
console.log('Organization created. The owner has an invitation link to set their own password.');
console.log(JSON.stringify(created.json, null, 2));
