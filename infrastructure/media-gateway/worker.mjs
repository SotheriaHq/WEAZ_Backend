const MAX_TOKEN_SECONDS = 900;
const settingsCache = new WeakMap();
const encoder = new TextEncoder();

function settingsFor(env) {
  const baseUrl = String(env.MEDIA_GATEWAY_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const secret = String(env.MEDIA_GATEWAY_SECRET ?? '').trim();
  const environment = String(env.MEDIA_GATEWAY_ENVIRONMENT ?? '').trim();
  const maxTtl = String(env.MEDIA_GATEWAY_MAX_TTL_SECONDS ?? MAX_TOKEN_SECONDS);
  const origins = String(env.MEDIA_GATEWAY_ALLOWED_ORIGINS ?? '*').trim();
  const cacheVersion = String(env.MEDIA_GATEWAY_CACHE_VERSION ?? 'v1');
  const cached = settingsCache.get(env);
  if (cached && cached.baseUrl === baseUrl && cached.secret === secret && cached.environment === environment
      && cached.maxTtl === maxTtl && cached.origins === origins && cached.cacheVersion === cacheVersion) return cached;
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || /(?:^|\.)r2\.(?:cloudflarestorage\.com|dev)$/i.test(url.hostname)
      || /(?:^|\.)amazonaws\.com(?:\.cn)?$/i.test(url.hostname)
      || /%|\\|\/\//.test(url.pathname)
      || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment)
      || !/^[a-z0-9-]{1,32}$/.test(cacheVersion)
      || encoder.encode(secret).length < 32 || encoder.encode(secret).length > 4096
      || !/^\d+$/.test(maxTtl) || Number(maxTtl) < 1 || Number(maxTtl) > MAX_TOKEN_SECONDS || !env.MEDIA_BUCKET) {
    throw new Error('Invalid media gateway settings');
  }
  const settings = {
    baseUrl, secret, environment, maxTtl, origins, cacheVersion,
    origin: url.origin, prefix: url.pathname.replace(/\/+$/, ''),
    signingKey: crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']),
  };
  settingsCache.set(env, settings);
  return settings;
}

function encodeKey(key) {
  if (!key || encoder.encode(key).length > 1024 || /[\\\u0000-\u001f\u007f]/.test(key)
      || key.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid key');
  return key.split('/').map(encodeURIComponent).join('/');
}

async function authorize(request, settings, nowSeconds) {
  const url = new URL(request.url);
  if (url.origin !== settings.origin || !url.pathname.startsWith(`${settings.prefix}/`)
      || url.search.length > 1024 || [...url.searchParams.keys()].some((name) => !['env', 'exp', 'method', 'sig'].includes(name))) return null;
  for (const name of ['env', 'exp', 'method', 'sig']) if (url.searchParams.getAll(name).length !== 1) return null;
  const environment = url.searchParams.get('env');
  const expiration = url.searchParams.get('exp');
  const method = url.searchParams.get('method');
  const signature = url.searchParams.get('sig');
  if (environment !== settings.environment || !/^[1-9]\d{0,11}$/.test(expiration ?? '')
      || !['GET', 'HEAD'].includes(method) || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')) return null;
  const expires = Number(expiration);
  if (!Number.isSafeInteger(expires) || expires <= nowSeconds || expires - nowSeconds > Number(settings.maxTtl)) return null;
  const requestedMethod = request.method === 'OPTIONS' ? request.headers.get('access-control-request-method') : request.method;
  // HEAD is a safe subset of GET. A HEAD-only token never grants a body read.
  if (!['GET', 'HEAD'].includes(requestedMethod) || (method === 'HEAD' && requestedMethod !== 'HEAD')) return null;
  const rawKey = url.pathname.slice(settings.prefix.length + 1);
  const key = decodeURIComponent(rawKey);
  if (encodeKey(key) !== rawKey) return null;
  const binary = atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = ['WIEZ-MEDIA-V1', method, url.origin, url.pathname, key, environment, expiration].join('\n');
  const valid = await crypto.subtle.verify('HMAC', await settings.signingKey, bytes, encoder.encode(canonical));
  return valid ? { key, url, remainingSeconds: expires - nowSeconds } : null;
}

function originAllowed(request, settings) {
  const origin = request.headers.get('origin');
  return !origin || settings.origins === '*' || settings.origins.split(',').map((part) => part.trim()).includes(origin);
}

function errorResponse(status) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function deliveryResponse(response, request, settings, remainingSeconds) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `private, max-age=${Math.max(0, remainingSeconds)}, must-revalidate`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges, Last-Modified');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (settings.origins === '*') headers.set('Access-Control-Allow-Origin', '*');
  else {
    const origin = request.headers.get('origin');
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    else headers.delete('Access-Control-Allow-Origin');
    headers.set('Vary', 'Origin');
  }
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

function objectHeaders(object) {
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  const contentType = String(object.httpMetadata?.contentType ?? headers.get('Content-Type') ?? '').trim();
  // HTML and documents do not belong on the public fashion-media gateway.
  if (!/^(?:image|video)\/[a-z0-9.+-]+(?:\s*;.*)?$/i.test(contentType)) return null;
  headers.set('Content-Type', contentType);
  headers.set('Content-Length', String(object.size));
  headers.set('Accept-Ranges', 'bytes');
  const etag = object.httpEtag ?? (object.etag ? `"${object.etag}"` : null);
  if (etag) headers.set('ETag', etag);
  if (object.uploaded) headers.set('Last-Modified', new Date(object.uploaded).toUTCString());
  return headers;
}

function etagMatches(list, etag, weak = true) {
  if (!list || !etag) return false;
  return list.split(',').some((value) => {
    const tag = value.trim();
    if (tag === '*') return true;
    return weak ? tag.replace(/^W\//, '') === etag.replace(/^W\//, '') : !tag.startsWith('W/') && tag === etag;
  });
}

function preconditionStatus(request, headers) {
  const etag = headers.get('ETag');
  const modified = Date.parse(headers.get('Last-Modified') ?? '');
  const ifMatch = request.headers.get('if-match');
  if (ifMatch && !etagMatches(ifMatch, etag, false)) return 412;
  const unmodified = Date.parse(request.headers.get('if-unmodified-since') ?? '');
  if (!ifMatch && Number.isFinite(unmodified) && Number.isFinite(modified) && modified > unmodified) return 412;
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) return 304;
  const since = Date.parse(request.headers.get('if-modified-since') ?? '');
  if (!ifNoneMatch && Number.isFinite(since) && Number.isFinite(modified) && modified <= since) return 304;
  return null;
}

function noBodyResponse(status, headers) {
  const result = new Headers(headers);
  result.delete('Content-Length');
  result.delete('Content-Range');
  return new Response(null, { status, headers: result });
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  const offset = first ?? Math.max(0, size - last);
  const end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if ((first === null && last <= 0) || offset >= size || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

function rangeMayApply(request, headers) {
  const condition = request.headers.get('if-range');
  if (!condition) return true;
  if (condition.startsWith('"') || condition.startsWith('W/')) return !condition.startsWith('W/') && condition === headers.get('ETag');
  const date = Date.parse(condition);
  const modified = Date.parse(headers.get('Last-Modified') ?? '');
  return Number.isFinite(date) && Number.isFinite(modified) && modified <= date;
}

/** Exported for deterministic tests; production uses the default fetch handler. */
export async function handleMediaRequest(request, env, context, runtime = {}) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const response = errorResponse(405);
    response.headers.set('Allow', 'GET, HEAD, OPTIONS');
    return response;
  }
  let settings;
  try { settings = settingsFor(env); } catch { return errorResponse(503); }
  let authorization;
  try { authorization = await authorize(request, settings, Math.floor((runtime.nowMs ?? Date.now()) / 1000)); }
  catch { return errorResponse(403); }
  if (!authorization || !originAllowed(request, settings)) return errorResponse(403);
  const { key, url, remainingSeconds } = authorization;
  if (request.method === 'OPTIONS') {
    const names = (request.headers.get('access-control-request-headers') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (names.some((name) => !['range', 'if-none-match', 'if-modified-since', 'if-match', 'if-range', 'if-unmodified-since'].includes(name))) return errorResponse(403);
    const response = deliveryResponse(new Response(null, { status: 204 }), request, settings, remainingSeconds);
    response.headers.set('Access-Control-Allow-Headers', names.join(', '));
    response.headers.set('Access-Control-Max-Age', String(Math.min(remainingSeconds, 300)));
    return response;
  }

  // Authorization MUST precede even a cache hit: expired/tampered URLs cannot read cached bodies.
  const cache = runtime.cache ?? globalThis.caches?.default;
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.search = new URLSearchParams({ env: settings.environment, v: settings.cacheVersion }).toString();
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
  try {
    if (!rangeHeader && cache) {
      const cached = await cache.match(cacheKey).catch(() => undefined);
      if (cached) {
        const conditional = preconditionStatus(request, cached.headers);
        return deliveryResponse(conditional ? noBodyResponse(conditional, cached.headers) : cached, request, settings, remainingSeconds);
      }
    }
    let metadata;
    let headers;
    const conditionalRequest = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].some((name) => request.headers.has(name));
    if (request.method === 'HEAD' || rangeHeader || conditionalRequest) {
      metadata = await env.MEDIA_BUCKET.head(key);
      if (!metadata) return errorResponse(404);
      headers = objectHeaders(metadata);
      if (!headers) return errorResponse(415);
      const status = preconditionStatus(request, headers);
      if (status) return deliveryResponse(noBodyResponse(status, headers), request, settings, remainingSeconds);
      if (request.method === 'HEAD') return deliveryResponse(new Response(null, { headers }), request, settings, remainingSeconds);
    }
    const useRange = /^bytes=/i.test(rangeHeader ?? '') && rangeMayApply(request, headers);
    const range = useRange ? parseRange(rangeHeader, metadata.size) : null;
    if (useRange && !range) {
      const response = errorResponse(416);
      response.headers.set('Content-Range', `bytes */${metadata.size}`);
      return response;
    }
    const object = await env.MEDIA_BUCKET.get(key, range ? { range, onlyIf: { etagMatches: metadata.etag } } : undefined);
    if (!object) return errorResponse(404);
    if (object.body === undefined) return errorResponse(412);
    headers = objectHeaders(object);
    if (!headers) return errorResponse(415);
    if (range) {
      headers.set('Content-Length', String(range.length));
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    }
    const response = new Response(object.body, { status: range ? 206 : 200, headers });
    if (!range && cache && context?.waitUntil) {
      const cacheHeaders = new Headers(headers);
      cacheHeaders.set('Cache-Control', `public, max-age=${Math.min(remainingSeconds, 300)}`);
      context.waitUntil(cache.put(cacheKey, new Response(response.clone().body, { headers: cacheHeaders })).catch(() => undefined));
    }
    return deliveryResponse(response, request, settings, remainingSeconds);
  } catch { return errorResponse(503); }
}

export default { fetch: handleMediaRequest };
