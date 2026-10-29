import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the staff TOTP secrets at rest (ADR 0017 §5): a database dump alone can't produce
 * codes. Stored as `iv.tag.ciphertext`, each base64url; the key is STAFF_TOTP_KEY (64 hex).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  }

  /** Throws when the value was tampered with or sealed under another key. */
  open(sealed: string): string {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !data) throw new Error('Malformed sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
