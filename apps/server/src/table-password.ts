import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { tablePasswordLength, type ApplicationRejection } from '@poker/contracts';

/**
 * Table Passwords (ADR-0033). A table keeps only a salted, slow hash of its password, server-only on the Persisted
 * Table Session: never in its Table Session Record, a projection, a response or a request fingerprint. People reuse
 * passwords, so a leak of the server's data must not expose them.
 */
const cost: ScryptOptions = { N: 16384, r: 8, p: 1 };
const keyLength = 32;
const derive = (password: string, salt: Buffer, options: ScryptOptions) => new Promise<Buffer>((resolve, reject) =>
  scrypt(password.normalize('NFC'), salt, keyLength, options, (error, key) => error ? reject(error) : resolve(key)));

/** Why `value` cannot be a Table Password, or undefined when it can: 4 to 64 characters, case-sensitive, never trimmed. */
export function tablePasswordProblem(value: unknown, field = 'tablePassword'): ApplicationRejection | undefined {
  const length = typeof value === 'string' ? [...value].length : 0;
  if (typeof value === 'string' && length >= tablePasswordLength.minimum && length <= tablePasswordLength.maximum) return undefined;
  return { ok: false, rejection: { code: 'invalid-table-password', field, message: `A Table Password is ${tablePasswordLength.minimum} to ${tablePasswordLength.maximum} characters.` } };
}

/** The stored form of a Table Password: `scrypt$N$r$p$salt$key`, salt and key in base64. */
export async function hashTablePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether `password` is the one `stored` was hashed from, compared in constant time. */
export async function tablePasswordMatches(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || [...password].length > tablePasswordLength.maximum) return false;
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
