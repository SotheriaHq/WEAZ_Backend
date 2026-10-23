import { createHmac } from 'node:crypto';

export interface StorageConfigReader {
  get<T = string>(key: string): T | undefined;
}

export interface PublicMediaGatewaySettings {
  baseUrl: string;
  secret: string;
  environment: string;
  ttlSeconds: number;
}

export interface StorageProviderSettings {
  provider: 'S3' | 'R2';
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  publicGateway?: PublicMediaGatewaySettings;
}

const R2_ENDPOINT_HOST = /^([a-f0-9]{32})(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/i;
const LEGACY_PUBLIC_BASE_KEYS = [
  'MEDIA_PUBLIC_BASE_URL', 'CDN_PUBLIC_BASE_URL', 'CLOUDFRONT_PUBLIC_BASE_URL',
  'CLOUDFRONT_URL', 'S3_PUBLIC_BASE_URL', 'R2_PUBLIC_BASE_URL',
];
const PUBLIC_BUCKET_FLAGS = [
  'MEDIA_BUCKET_PUBLIC', 'S3_BUCKET_PUBLIC', 'AWS_S3_BUCKET_PUBLIC',
  'S3_PUBLIC_READ', 'MEDIA_OBJECTS_PUBLIC', 'R2_BUCKET_PUBLIC',
];

function read(config: StorageConfigReader, name: string): string | undefined {
  const value = config.get<unknown>(name);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value.trim() || undefined;
}

function required(config: StorageConfigReader, name: string): string {
  const value = read(config, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cleanHttpsUrl(value: string, name: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid HTTPS URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) {
    throw new Error(`${name} must use HTTPS without credentials, query, fragment or custom port`);
  }
  return parsed;
}

function resolveGateway(config: StorageConfigReader): PublicMediaGatewaySettings | undefined {
  const base = read(config, 'MEDIA_GATEWAY_BASE_URL');
  const secret = read(config, 'MEDIA_GATEWAY_SECRET');
  const environment = read(config, 'MEDIA_GATEWAY_ENVIRONMENT');
  const ttl = read(config, 'MEDIA_GATEWAY_TTL_SECONDS');
  if (!base && !secret && !environment && !ttl) return undefined;
  if (!base || !secret || !environment) {
    throw new Error('MEDIA_GATEWAY_BASE_URL, MEDIA_GATEWAY_SECRET and MEDIA_GATEWAY_ENVIRONMENT must be configured together');
  }
  const parsed = cleanHttpsUrl(base, 'MEDIA_GATEWAY_BASE_URL');
  if (isRawStorageUrl(undefined, parsed.href)) {
    throw new Error('MEDIA_GATEWAY_BASE_URL must identify the authenticated Worker, not a storage API or public bucket');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 4096) {
    throw new Error('MEDIA_GATEWAY_SECRET must contain 32 to 4096 UTF-8 bytes');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment)) {
    throw new Error('MEDIA_GATEWAY_ENVIRONMENT must be a lowercase environment identifier');
  }
  if (ttl && !/^\d+$/.test(ttl)) throw new Error('MEDIA_GATEWAY_TTL_SECONDS must be an integer from 60 to 900');
  const ttlSeconds = ttl ? Number(ttl) : 300;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
    throw new Error('MEDIA_GATEWAY_TTL_SECONDS must be an integer from 60 to 900');
  }
  const baseUrl = parsed.href.replace(/\/+$/, '');
  // A route prefix must already have the same canonical encoding used by the Worker.
  if (parsed.pathname !== '/' && /%|\\|\/\//.test(parsed.pathname)) {
    throw new Error('MEDIA_GATEWAY_BASE_URL must use a plain canonical route prefix');
  }
  return { baseUrl, secret, environment, ttlSeconds };
}

/** Resolve once at startup. R2 never inherits S3 credentials, region or bucket. */
export function resolveStorageProviderSettings(config: StorageConfigReader): StorageProviderSettings {
  const explicitProvider = read(config, 'STORAGE_PROVIDER');
  const provider = explicitProvider?.toUpperCase() ?? 'S3';
  if (provider !== 'S3' && provider !== 'R2') throw new Error('STORAGE_PROVIDER must be S3 or R2');
  if (!explicitProvider && ['R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].some((name) => read(config, name))) {
    throw new Error('Set STORAGE_PROVIDER explicitly when R2 settings are present');
  }

  if (provider === 'R2') {
    const bucket = required(config, 'R2_BUCKET');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('R2_BUCKET must be a valid 3 to 63 character bucket name');
    const account = read(config, 'R2_ACCOUNT_ID');
    if (account && !/^[a-f0-9]{32}$/i.test(account)) throw new Error('R2_ACCOUNT_ID must be a 32 character account identifier');
    const endpointValue = read(config, 'R2_ENDPOINT') ?? (account ? `https://${account.toLowerCase()}.r2.cloudflarestorage.com` : undefined);
    if (!endpointValue) throw new Error('R2_ACCOUNT_ID or R2_ENDPOINT is required');
    const endpointUrl = cleanHttpsUrl(endpointValue, 'R2_ENDPOINT');
    const endpointAccount = R2_ENDPOINT_HOST.exec(endpointUrl.hostname)?.[1];
    if (!endpointAccount || endpointUrl.pathname !== '/' || (account && endpointAccount.toLowerCase() !== account.toLowerCase())) {
      throw new Error('R2_ENDPOINT must be the matching account R2 API origin');
    }
    const publicGateway = resolveGateway(config);
    for (const name of PUBLIC_BUCKET_FLAGS) {
      if (['1', 'true', 'yes', 'on', 'public'].includes((read(config, name) ?? '').toLowerCase())) {
        throw new Error(`${name} is incompatible with private R2 storage`);
      }
    }
    for (const name of LEGACY_PUBLIC_BASE_KEYS) {
      const value = read(config, name);
      if (value && (!publicGateway || value.replace(/\/+$/, '') !== publicGateway.baseUrl)) {
        throw new Error(`${name} must be removed or match the authenticated MEDIA_GATEWAY_BASE_URL in R2 mode`);
      }
    }
    return {
      provider, bucket, region: 'auto', endpoint: endpointUrl.origin, forcePathStyle: true,
      credentials: { accessKeyId: required(config, 'R2_ACCESS_KEY_ID'), secretAccessKey: required(config, 'R2_SECRET_ACCESS_KEY') },
      ...(publicGateway ? { publicGateway } : {}),
    };
  }

  const accessKeyId = read(config, 'AWS_ACCESS_KEY_ID') ?? read(config, 'ACCESS_KEY_ID');
  const secretAccessKey = read(config, 'AWS_SECRET_ACCESS_KEY') ?? read(config, 'SECRET_ACCESS_KEY');
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error('S3 access key and secret must be configured together');
  const endpointValue = read(config, 'S3_ENDPOINT');
  let endpoint: string | undefined;
  if (endpointValue) {
    const parsed = cleanHttpsUrl(endpointValue, 'S3_ENDPOINT');
    if (parsed.pathname !== '/') throw new Error('S3_ENDPOINT must be an origin');
    if (/\.r2\.cloudflarestorage\.com$/i.test(parsed.hostname)) throw new Error('R2 endpoints require STORAGE_PROVIDER=R2');
    endpoint = parsed.origin;
  }
  const sessionToken = read(config, 'AWS_SESSION_TOKEN');
  return {
    provider, bucket: read(config, 'AWS_S3_BUCKET') ?? required(config, 'S3_BUCKET'),
    region: read(config, 'AWS_REGION') ?? read(config, 'REGION') ?? 'eu-north-1',
    forcePathStyle: Boolean(endpoint), ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } } : {}),
  };
}

/** Includes development/public R2 hosts: none are an authenticated delivery gateway. */
export function isRawStorageUrl(settings: StorageProviderSettings | undefined, value: string): boolean {
  try {
    const parsed = new URL(value);
    return /(?:^|\.)amazonaws\.com(?:\.cn)?$/i.test(parsed.hostname)
      || /(?:^|\.)r2\.cloudflarestorage\.com$/i.test(parsed.hostname)
      || /(?:^|\.)r2\.dev$/i.test(parsed.hostname)
      || Boolean(settings?.endpoint && parsed.origin === settings.endpoint);
  } catch { return false; }
}

/** Metadata identity only; callers must authorize and resolve a delivery URL. */
export function storageObjectUrl(settings: StorageProviderSettings, key: string): string {
  const encoded = encodeMediaObjectKey(key);
  return settings.endpoint
    ? `${settings.endpoint}/${encodeURIComponent(settings.bucket)}/${encoded}`
    : `https://${settings.bucket}.s3.${settings.region}.amazonaws.com/${encoded}`;
}

export function encodeMediaObjectKey(key: string): string {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key, 'utf8') > 1024 || /[\\\u0000-\u001f\u007f]/.test(key)
      || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid media object key');
  }
  try { return key.split('/').map(encodeURIComponent).join('/'); }
  catch { throw new Error('Invalid media object key'); }
}

/** Only call after publication/visibility eligibility has been established. */
export function signPublicGatewayUrl(
  gateway: PublicMediaGatewaySettings,
  key: string,
  method: 'GET' | 'HEAD' = 'GET',
  nowMs = Date.now(),
): string {
  if (!['GET', 'HEAD'].includes(method) || !Number.isFinite(nowMs) || !Number.isInteger(gateway.ttlSeconds)
      || gateway.ttlSeconds < 60 || gateway.ttlSeconds > 900) throw new Error('Invalid media gateway signing parameters');
  const url = new URL(`${gateway.baseUrl}/${encodeMediaObjectKey(key)}`);
  const expires = String(Math.floor(nowMs / 1000) + gateway.ttlSeconds);
  const canonical = ['WIEZ-MEDIA-V1', method, url.origin, url.pathname, key, gateway.environment, expires].join('\n');
  url.search = new URLSearchParams({
    env: gateway.environment, exp: expires, method,
    sig: createHmac('sha256', gateway.secret).update(canonical).digest('base64url'),
  }).toString();
  return url.href;
}
