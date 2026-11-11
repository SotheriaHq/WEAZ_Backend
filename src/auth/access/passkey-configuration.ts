import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const list = (value: string | undefined) => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const unavailable = () => new ServiceUnavailableException('Passkeys are not configured for this environment. Use an authenticator app or recovery code.');
const publicTemplateCertificate = Buffer.from('FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C', 'hex').toString('base64url');

export function passkeyConfiguration(config: ConfigService) {
  const rpID = config.get<string>('SECURITY_PASSKEY_RP_ID')?.trim().toLowerCase();
  const webOrigins = list(config.get<string>('SECURITY_PASSKEY_ORIGINS'));
  const androidOrigins = list(config.get<string>('SECURITY_PASSKEY_ANDROID_ORIGINS'));
  if (!rpID || (rpID !== 'localhost' && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rpID)) ||
    !webOrigins.length || webOrigins.length + androidOrigins.length > 32) throw unavailable();
  for (const origin of webOrigins) {
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin || parsed.hostname.includes('*') ||
        (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) ||
        (parsed.hostname !== rpID && !parsed.hostname.endsWith(`.${rpID}`))) throw unavailable();
    } catch { throw unavailable(); }
  }
  for (const origin of androidOrigins) {
    const hash = origin.slice('android:apk-key-hash:'.length);
    if (!/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(origin) || Buffer.from(hash, 'base64url').length !== 32 ||
      Buffer.from(hash, 'base64url').toString('base64url') !== hash || hash === publicTemplateCertificate) throw unavailable();
  }
  return { rpID, origins: [...new Set([...webOrigins, ...androidOrigins])], androidConfigured: androidOrigins.length > 0 };
}
