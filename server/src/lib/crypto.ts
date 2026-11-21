import crypto from 'node:crypto';
import { config } from '../config.js';

// Salt keeps the pre-rename name on purpose: changing it would make stored YouTube tokens undecryptable.
const key = () => crypto.scryptSync(config.appSecret, 'clipforge-token-salt', 32);

/** AES-256-GCM encrypt -> base64(iv | tag | ciphertext) */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const randomToken = (n = 24) => crypto.randomBytes(n).toString('hex');
