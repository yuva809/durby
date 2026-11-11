import type { StaffRole } from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { StaffService } from '../../src/platform/staff';
import { type AuthTestKit, PASSWORD, WEB_ORIGIN } from './auth-app';

export const STAFF_COOKIE = '__Secure-durby_staff';

/** A staff browser: its own IP, the allowed Origin, and the staff cookie it was given. */
export class StaffBrowser {
  cookie: string | undefined;
  readonly ip = `10.${rnd()}.${rnd()}.${rnd()}`;

  constructor(private readonly kit: AuthTestKit) {}

  send(
    method: 'get' | 'post' | 'patch' | 'put',
    path: string,
    body?: object,
    opts: { origin?: string; headers?: Record<string, string> } = {},
  ) {
    let req = request(this.kit.server)
      [method](`/api/v1/platform${path}`)
      .set('X-Forwarded-For', this.ip);
    const origin = opts.origin ?? WEB_ORIGIN;
    if (origin) req = req.set('Origin', origin);
    if (this.cookie) req = req.set('Cookie', `${STAFF_COOKIE}=${this.cookie}`);
    for (const [name, value] of Object.entries(opts.headers ?? {})) req = req.set(name, value);
    const keep = (res: request.Response) => {
      for (const line of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
        const match = new RegExp(`^${STAFF_COOKIE}=([^;]*)`).exec(line);
        if (match) this.cookie = match[1] || undefined;
      }
      return res;
    };
    return { expect: async (status: number) => keep(await req.send(body ?? {}).expect(status)) };
  }
}

export const staffEmail = () => `s-${uuidv7()}@durby.test`;

/** The newest `#token=` link mailed to `address`. */
export function mailedToken(kit: AuthTestKit, address: string): string {
  const mail = kit.mailer.to(address).at(-1);
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1];
  if (!token) throw new Error(`no token mailed to ${address}`);
  return token;
}

/** A signed-in staff member with `role` (invited by the bootstrap command, invitation accepted). */
export async function signedInStaff(kit: AuthTestKit, role: StaffRole = 'super_admin') {
  const address = staffEmail();
  const member = await kit.app
    .get(StaffService)
    .invite({ system: 'cli.create_staff' }, address, role);
  const browser = new StaffBrowser(kit);
  await browser
    .send('post', '/auth/accept', { token: mailedToken(kit, address), password: PASSWORD })
    .expect(204);
  return { id: member.id, email: address, browser };
}

function rnd(): number {
  return Math.floor(Math.random() * 250) + 1;
}
