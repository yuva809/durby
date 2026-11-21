#!/usr/bin/env node
/**
 * Onboards an organization's branches and staff on a Durby API, through the endpoints the web app uses (no database
 * access). Run it with the owner's own login:
 *
 *   DURBY_API=https://app.asiamight.site/api/v1 \
 *   OWNER_EMAIL=owner@example.com OWNER_PASSWORD='...' \
 *   node scripts/onboard/onboard.mjs scripts/onboard/people.json [--dry-run]
 *
 * people.json is NOT in git (see .gitignore): it holds each person's temporary password. Passwords are checked for
 * the server's minimum length before anything is sent, and are never printed. People are created with their temporary
 * password and must change it at first sign-in. Re-running is safe: branches and people that already exist are left
 * alone. Node 20 or later (uses the built-in fetch).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Server policy (packages/shared/src/api/auth.ts: PASSWORD_MIN_LENGTH). */
const PASSWORD_MIN_LENGTH = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const [, , configPath, flag] = process.argv;
const dryRun = flag === '--dry-run';
const API = (process.env.DURBY_API ?? '').replace(/\/+$/, '');
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

if (!configPath) fail('Usage: node scripts/onboard/onboard.mjs <people.json> [--dry-run]');
if (!API || !OWNER_EMAIL || !OWNER_PASSWORD) {
  fail('Set DURBY_API, OWNER_EMAIL and OWNER_PASSWORD (the owner signs in; nothing is stored).');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!UUID.test(config.organizationId ?? '') || /^0+$/.test(config.organizationId)) {
  fail('organizationId must be the organization’s id.');
}
if (!Array.isArray(config.branches) || !Array.isArray(config.people)) {
  fail('The config needs "branches" and "people" lists.');
}

// Everything is checked before the first request, so a bad line never leaves half the staff created.
const problems = [];
for (const p of config.people) {
  const who = p.email ?? p.name ?? '(no name)';
  if (!p.name || !p.email || !p.role) problems.push(`${who}: needs name, email and role`);
  if (!Array.isArray(p.locations) || p.locations.length === 0) {
    problems.push(`${who}: needs at least one branch in "locations"`);
  }
  if (typeof p.temporaryPassword === 'string' && p.temporaryPassword.startsWith('REPLACE')) {
    problems.push(`${who}: replace the placeholder temporaryPassword`);
  }
  if (typeof p.temporaryPassword !== 'string' || p.temporaryPassword.length < PASSWORD_MIN_LENGTH) {
    problems.push(`${who}: temporaryPassword must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
}
if (problems.length > 0) fail(`Not sent, fix these first:\n- ${problems.join('\n- ')}`);

/** One call; the body of an error is reduced to its code so no password can reach the log. */
async function call(method, path, { token, body, idempotent = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotent) headers['idempotency-key'] = randomUUID();
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, code: json?.code ?? `http_${res.status}` };
}

const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// 1. Sign in as the owner, and into the organization.
const login = await call('POST', '/auth/login', {
  body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
});
if (!login.ok) fail(`Sign-in failed: ${login.code}`);
let token = login.json.accessToken;
if (login.json.activeOrganizationId !== config.organizationId) {
  const switched = await call('POST', '/auth/switch-organization', {
    token,
    body: { organizationId: config.organizationId },
  });
  if (!switched.ok) fail(`Cannot switch to that organization: ${switched.code}`);
  token = switched.json.accessToken;
}
console.log(`Signed in. ${dryRun ? 'DRY RUN: nothing is written.' : 'Writing to the live organization.'}`);

// 2. Branches (locations): create the ones that are missing.
const existingLocations = (await call('GET', '/locations?includeArchived=true', { token })).json
  .data;
const locationIds = new Map();
for (const branch of config.branches) {
  const found = existingLocations.find((l) => same(l.name, branch.name));
  if (found) {
    locationIds.set(branch.name, found.id);
    console.log(`branch exists     ${branch.name}`);
    continue;
  }
  if (dryRun) {
    console.log(`branch would be created  ${branch.name}`);
    continue;
  }
  const created = await call('POST', '/locations', {
    token,
    idempotent: true,
    body: { name: branch.name, ...(branch.address ? { address: branch.address } : {}) },
  });
  if (!created.ok) fail(`Branch ${branch.name}: ${created.code}`);
  locationIds.set(branch.name, created.json.id);
  console.log(`branch created    ${branch.name}`);
}

// 3. Warehouses and roles, by name: what the people refer to.
const warehouses = (await call('GET', '/inventory/warehouses', { token })).json.data;
const roles = (await call('GET', '/roles', { token })).json.data;
const staff = (await call('GET', '/staff', { token })).json.data;
const knownEmails = new Set(staff.map((m) => m.email.toLowerCase()));

function resolve(names, pool, label) {
  return names.map((name) => {
    const hit = pool.find((x) => same(x.name, name));
    if (!hit) throw new Error(`${label} "${name}" does not exist yet`);
    return hit.id;
  });
}

// 4. People: create each one who is not there yet, with the temporary password.
const results = [];
for (const p of config.people) {
  const row = { name: p.name, email: p.email, role: p.role, branch: p.locations.join(', ') };
  if (knownEmails.has(p.email.toLowerCase())) {
    results.push({ ...row, result: 'exists, left alone' });
    continue;
  }
  let body;
  try {
    const role = roles.find((r) => r.systemKey === p.role || same(r.name ?? '', p.role));
    if (!role) throw new Error(`role "${p.role}" does not exist`);
    const locs = p.locations.map((name) => {
      const id = locationIds.get(name) ?? existingLocations.find((l) => same(l.name, name))?.id;
      if (!id) throw new Error(`branch "${name}" does not exist yet`);
      return id;
    });
    body = {
      name: p.name,
      email: p.email,
      roleId: role.id,
      locationIds: locs,
      warehouseIds: p.warehouses?.length ? resolve(p.warehouses, warehouses, 'warehouse') : null,
      grants: [],
      denies: [],
      temporaryPassword: p.temporaryPassword,
      sendEmail: false,
    };
  } catch (error) {
    results.push({ ...row, result: `not created: ${error.message}` });
    continue;
  }
  if (dryRun) {
    results.push({ ...row, result: 'would be created' });
    continue;
  }
  const created = await call('POST', '/staff', { token, idempotent: true, body });
  results.push({
    ...row,
    result: created.ok ? 'created' : `not created: ${created.code}`,
  });
}

console.log('');
for (const r of results) {
  console.log(`${r.result.padEnd(28)} ${r.role.padEnd(10)} ${r.email.padEnd(34)} ${r.branch}`);
}
console.log('\nPasswords are not printed. Each new person must change theirs at first sign-in.');
