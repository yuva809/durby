import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** argon2id (the library default) with OWASP parameters: 19 MiB, 2 iterations, 1 lane. */
export const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

@Injectable()
export class PasswordHasher {
  /** Hash of a random password, verified against for unknown users so timing matches real ones. */
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /** `storedHash = null` (unknown user, or no password set yet) costs the same as a real check. */
  async verify(storedHash: string | null, password: string): Promise<boolean> {
    if (storedHash === null) {
      this.dummyHash ??= this.hash(`dummy-${Math.random()}-${Date.now()}`);
      await verify(await this.dummyHash, password);
      return false;
    }
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }
}
