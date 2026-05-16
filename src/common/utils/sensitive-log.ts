import { createHash } from 'crypto';

export function maskEmailForLog(email?: string | null): string {
  const normalizedEmail = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!normalizedEmail) {
    return 'email_fingerprint=empty';
  }

  const fingerprint = createHash('sha256')
    .update(normalizedEmail)
    .digest('hex')
    .slice(0, 12);

  return `email_fingerprint=${fingerprint}`;
}
