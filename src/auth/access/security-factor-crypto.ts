import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

function readKeys(config: ConfigService): Buffer[] {
  const values = [config.get<string>('SECURITY_FACTOR_ENCRYPTION_KEY'), config.get<string>('SECURITY_FACTOR_ENCRYPTION_KEY_PREVIOUS')].filter((v): v is string => Boolean(v));
  const keys = values.map((v) => Buffer.from(v.trim(), 'base64'));
  if (!keys.length || keys.some((key, index) => key.length !== 32 || key.toString('base64') !== values[index].trim())) throw new ServiceUnavailableException('Stronger authentication is temporarily unavailable');
  return keys;
}
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12);
export const secretDigest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const randomSecuritySecret = () => randomBytes(32).toString('base64url');

export function encryptFactor(config: ConfigService, userId: string, factorId: string, value: string): string {
  const key = readKeys(config)[0];
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`wiez:security-factor:v1:${userId}:${factorId}`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', keyId(key), nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decryptFactor(config: ConfigService, userId: string, factorId: string, sealed: string): string {
  if (sealed.length > 1024) throw new ServiceUnavailableException('Stronger authentication is temporarily unavailable');
  const [version, id, nonce, tag, ciphertext, extra] = sealed.split('.');
  const key = readKeys(config).find((candidate) => keyId(candidate) === id);
  if (version !== 'v1' || !key || !nonce || !tag || !ciphertext || extra !== undefined) throw new ServiceUnavailableException('Stronger authentication is temporarily unavailable');
  try {
    const iv = Buffer.from(nonce, 'base64url');
    const authenticationTag = Buffer.from(tag, 'base64url');
    const encrypted = Buffer.from(ciphertext, 'base64url');
    if (iv.length !== 12 || authenticationTag.length !== 16 || encrypted.length < 1 || encrypted.length > 512 ||
      iv.toString('base64url') !== nonce || authenticationTag.toString('base64url') !== tag || encrypted.toString('base64url') !== ciphertext) throw new Error('Invalid encrypted factor');
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`wiez:security-factor:v1:${userId}:${factorId}`));
    decipher.setAuthTag(authenticationTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch { throw new ServiceUnavailableException('Stronger authentication is temporarily unavailable'); }
}

/** Stable JSON without materializing attacker-controlled property names. */
function canonical(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 20) throw new BadRequestException('Action is too complex to authorize');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || !value || seen.has(value)) throw new BadRequestException('Invalid action data');
  seen.add(value);
  const result = Array.isArray(value) ? `[${value.map((entry) => canonical(entry, seen, depth + 1)).join(',')}]`
    : `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen, depth + 1)}`).join(',')}}`;
  seen.delete(value);
  if (Buffer.byteLength(result) > 65_536) throw new BadRequestException('Action data exceeds the authorization limit');
  return result;
}
export function operationDigest(config: ConfigService, operation: unknown): string {
  const key = readKeys(config)[0];
  return `${keyId(key)}:${createHmac('sha256', key).update('wiez:operation:v1:').update(canonical(operation, new Set(), 0)).digest('hex')}`;
}
export function matchesOperationDigest(config: ConfigService, digest: string, operation: unknown): boolean {
  const [id, value] = digest.split(':');
  const key = readKeys(config).find((candidate) => keyId(candidate) === id);
  if (!key || !/^[a-f0-9]{64}$/.test(value ?? '')) return false;
  const expected = createHmac('sha256', key).update('wiez:operation:v1:').update(canonical(operation, new Set(), 0)).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'));
}
