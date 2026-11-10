import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

function key(): Buffer | null {
  const secret = process.env.PAYMENT_SAVED_METHODS_SECRET?.trim();
  return secret ? createHash('sha256').update(secret).digest() : null;
}

export function subscriptionAuthorizationStorageReady(): boolean {
  return Boolean(key());
}

/** Reuse the configured payment-token key, with brand-bound authenticated data. */
export function encryptSubscriptionAuthorization(
  value: string,
  brandId: string,
): string | null {
  const encryptionKey = key();
  if (!encryptionKey || !value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`wiez-subscription:${brandId}`));
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptSubscriptionAuthorization(
  value: string | null,
  brandId: string,
): string | null {
  const encryptionKey = key();
  if (!encryptionKey || !value) return null;
  try {
    if (value.length > 16384) return null;
    const [version, iv, tag, encrypted, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined)
      return null;
    const nonce = Buffer.from(iv, 'base64'),
      authTag = Buffer.from(tag, 'base64'),
      ciphertext = Buffer.from(encrypted, 'base64');
    if (
      nonce.length !== 12 ||
      authTag.length !== 16 ||
      !ciphertext.length ||
      nonce.toString('base64') !== iv ||
      authTag.toString('base64') !== tag ||
      ciphertext.toString('base64') !== encrypted
    )
      return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(`wiez-subscription:${brandId}`));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
