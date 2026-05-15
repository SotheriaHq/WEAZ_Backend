import 'dotenv/config';

type SmokeStatus = 'PASS' | 'FAIL' | 'SKIP';

type SmokeCheck = {
  name: string;
  method: string;
  path: string;
  status: SmokeStatus;
  httpStatus?: number;
  summary?: unknown;
  note?: string;
};

type RequestOptions = {
  method?: 'GET' | 'POST';
  token?: string;
  body?: unknown;
};

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3040').replace(
  /\/+$/,
  '',
);

const SEEDED_IDS = {
  brandOwnerEmail: 'brand.owner@test.com',
  buyerEmail: 'buyer@test.com',
  password: 'Password@123',
  brandOwnerId: '11111111-1111-4111-8111-111111111111',
  designId: '44444444-4444-4444-8444-444444444444',
  productId: '55555555-5555-4555-8555-555555555555',
  storeCollectionId: '66666666-6666-4666-8666-666666666666',
};

const checks: SmokeCheck[] = [];

function unwrapPayload(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    'data' in value &&
    'statusCode' in value
  ) {
    return (value as { data?: unknown }).data;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractArray(value: unknown): unknown[] {
  const payload = unwrapPayload(value);
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  if (Array.isArray(record.items)) {
    return record.items;
  }
  if (Array.isArray(record.data)) {
    return record.data;
  }
  if (Array.isArray(record.results)) {
    return record.results;
  }
  return [];
}

function summarizeKeys(value: unknown, keys: string[] = []): Record<string, unknown> {
  const payload = unwrapPayload(value);
  const record = asRecord(payload);
  const summary: Record<string, unknown> = {};

  for (const key of keys) {
    if (key in record) {
      summary[key] = record[key];
    }
  }

  if (Object.keys(summary).length > 0) {
    return summary;
  }

  const topLevelKeys = Object.keys(record).slice(0, 12);
  return { keys: topLevelKeys };
}

async function request(path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  const text = await response.text();
  let json: unknown = null;

  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  return { response, json };
}

function record(check: SmokeCheck) {
  checks.push(check);
}

async function check(
  name: string,
  path: string,
  validate: (json: unknown) => { passed: boolean; summary?: unknown; note?: string },
  options: RequestOptions = {},
) {
  try {
    const { response, json } = await request(path, options);
    const validation = response.ok
      ? validate(json)
      : {
          passed: false,
          summary: summarizeKeys(json, ['message', 'error', 'statusCode']),
          note: `HTTP ${response.status}`,
        };

    record({
      name,
      method: options.method ?? 'GET',
      path,
      httpStatus: response.status,
      status: validation.passed ? 'PASS' : 'FAIL',
      summary: validation.summary,
      note: validation.note,
    });
  } catch (error) {
    record({
      name,
      method: options.method ?? 'GET',
      path,
      status: 'FAIL',
      note: error instanceof Error ? error.message : String(error),
    });
  }
}

async function login(email: string) {
  const path = '/auth/login';
  try {
    const { response, json } = await request(path, {
      method: 'POST',
      body: {
        email,
        password: SEEDED_IDS.password,
      },
    });
    const payload = asRecord(unwrapPayload(json));
    const token =
      typeof payload.accessToken === 'string'
        ? payload.accessToken
        : typeof payload.token === 'string'
          ? payload.token
          : undefined;

    record({
      name: `login seeded user ${email}`,
      method: 'POST',
      path,
      httpStatus: response.status,
      status: response.ok && Boolean(token) ? 'PASS' : 'FAIL',
      summary: {
        message: payload.message,
        userId: asRecord(payload.user).id,
        email: asRecord(payload.user).email,
        accessTokenReturned: Boolean(token),
      },
      note: token ? undefined : 'No access token returned.',
    });

    return token;
  } catch (error) {
    record({
      name: `login seeded user ${email}`,
      method: 'POST',
      path,
      status: 'FAIL',
      note: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function main() {
  await check('root endpoint responds', '/', (json) => ({
    passed: true,
    summary: summarizeKeys(json, ['message', 'data', 'statusCode']),
  }));

  await check('categories are available', '/categories', (json) => {
    const items = extractArray(json);
    return {
      passed: items.length > 0,
      summary: { count: items.length },
    };
  });

  await check('category filters are available', '/categories/filters', (json) => {
    const items = extractArray(json);
    return {
      passed: items.length > 0,
      summary: { count: items.length },
    };
  });

  await check('market product endpoint responds', '/products/market?limit=5', (json) => {
    const payload = asRecord(unwrapPayload(json));
    const items = extractArray(json);
    const entityTypes = Array.from(
      new Set(
        items
          .map((item) => asRecord(item).entityType)
          .filter((entityType) => typeof entityType === 'string'),
      ),
    ).sort();
    return {
      passed: true,
      summary: {
        count: items.length,
        total: payload.total,
        nextCursor: payload.nextCursor,
        entityTypes,
      },
    };
  });

  await check(
    'seeded explicit Design can be read',
    `/designs/${SEEDED_IDS.designId}`,
    (json) => {
      const payload = asRecord(unwrapPayload(json));
      const designId = payload.designId ?? payload.id;
      const media = Array.isArray(payload.media)
        ? payload.media
        : Array.isArray(payload.medias)
          ? payload.medias
          : [];
      return {
        passed:
          designId === SEEDED_IDS.designId &&
          media.length === 4 &&
          payload.entityType === 'DESIGN',
        summary: summarizeKeys(payload, [
          'id',
          'designId',
          'entityType',
          'legacyCollectionId',
          'collectionId',
          'title',
          'customOrderEnabled',
          'status',
        ]),
        note: `mediaCount=${media.length}`,
      };
    },
  );

  await check(
    'seeded Product can be read',
    `/products/${SEEDED_IDS.productId}`,
    (json) => {
      const payload = asRecord(unwrapPayload(json));
      const productId = payload.productId ?? payload.id;
      return {
        passed: productId === SEEDED_IDS.productId && payload.entityType === 'PRODUCT',
        summary: summarizeKeys(payload, ['id', 'productId', 'entityType', 'name', 'title', 'price']),
      };
    },
  );

  await check(
    'seeded StoreCollection can be read',
    `/store-collections/${SEEDED_IDS.storeCollectionId}`,
    (json) => {
      const payload = asRecord(unwrapPayload(json));
      const collectionId = payload.collectionId ?? payload.id;
      return {
        passed:
          collectionId === SEEDED_IDS.storeCollectionId &&
          payload.entityType === 'COLLECTION',
        summary: summarizeKeys(payload, [
          'id',
          'collectionId',
          'entityType',
          'title',
          'visibility',
          'status',
        ]),
      };
    },
  );

  await check(
    'seeded Design custom-order config can be read',
    `/designs/${SEEDED_IDS.designId}/custom-order-configuration`,
    (json) => {
      const payload = asRecord(unwrapPayload(json));
      return {
        passed:
          payload.customOrderEnabled === true ||
          payload.enabled === true ||
          payload.id != null,
        summary: summarizeKeys(payload, [
          'id',
          'sourceType',
          'sourceId',
          'customOrderEnabled',
          'enabled',
          'status',
        ]),
      };
    },
  );

  const buyerToken = await login(SEEDED_IDS.buyerEmail);
  if (buyerToken) {
    await check(
      'seeded saved items can be read',
      '/saved/me',
      (json) => {
        const items = extractArray(json);
        const targetTypes = new Set(
          items
            .map((item) => asRecord(item).targetType)
            .filter((targetType) => typeof targetType === 'string'),
        );
        return {
          passed: targetTypes.has('DESIGN') && targetTypes.has('PRODUCT'),
          summary: {
            count: items.length,
            targetTypes: Array.from(targetTypes).sort(),
          },
        };
      },
      { token: buyerToken },
    );
  } else {
    record({
      name: 'seeded saved items can be read',
      method: 'GET',
      path: '/saved/me',
      status: 'SKIP',
      note: 'Skipped because seeded buyer login did not return an access token.',
    });
  }

  const failed = checks.filter((item) => item.status === 'FAIL');
  const skipped = checks.filter((item) => item.status === 'SKIP');
  const summary = {
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    checkedAt: new Date().toISOString(),
    apiBaseUrl: API_BASE_URL,
    checks,
    totals: {
      passed: checks.filter((item) => item.status === 'PASS').length,
      failed: failed.length,
      skipped: skipped.length,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
