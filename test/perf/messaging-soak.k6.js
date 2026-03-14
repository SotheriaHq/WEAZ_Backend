import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3040';
const BUYER_TOKEN = __ENV.BUYER_TOKEN || '';
const BRAND_TOKEN = __ENV.BRAND_TOKEN || '';
const BUYER_CUSTOM_ORDER_IDS = (__ENV.BUYER_CUSTOM_ORDER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean);
const BRAND_CUSTOM_ORDER_IDS = (__ENV.BRAND_CUSTOM_ORDER_IDS || '').split(',').map((v) => v.trim()).filter(Boolean);
const BRAND_ID = __ENV.BRAND_ID || '';

if (!BUYER_TOKEN || !BRAND_TOKEN || BUYER_CUSTOM_ORDER_IDS.length === 0 || BRAND_CUSTOM_ORDER_IDS.length === 0 || !BRAND_ID) {
  console.error('Missing required env vars: BUYER_TOKEN, BRAND_TOKEN, BUYER_CUSTOM_ORDER_IDS, BRAND_CUSTOM_ORDER_IDS, BRAND_ID');
}

export const options = {
  scenarios: {
    buyer_read_write_mix: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '4m', target: 30 },
        { duration: '2m', target: 30 },
        { duration: '1m', target: 0 },
      ],
      exec: 'buyerFlow',
    },
    brand_read_write_mix: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 8 },
        { duration: '4m', target: 20 },
        { duration: '2m', target: 20 },
        { duration: '1m', target: 0 },
      ],
      exec: 'brandFlow',
    },
    bulk_summary_pressure: {
      executor: 'constant-vus',
      vus: 25,
      duration: '5m',
      exec: 'bulkSummaryFlow',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<700'],
  },
};

function jsonHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}

function randomId(prefix = 'k6') {
  const now = Date.now().toString(16);
  const rnd = Math.floor(Math.random() * 1e9).toString(16);
  return `${prefix}-${now}-${rnd}`;
}

function randomOrderId(ids) {
  return ids[Math.floor(Math.random() * ids.length)];
}

export function buyerFlow() {
  const orderId = randomOrderId(BUYER_CUSTOM_ORDER_IDS);

  const listRes = http.get(`${BASE_URL}/custom-orders/${orderId}/messages?limit=30`, {
    headers: { Authorization: `Bearer ${BUYER_TOKEN}` },
  });

  check(listRes, {
    'buyer list status ok': (r) => r.status === 200,
  });

  const payload = JSON.stringify({
    clientMessageId: randomId('buyer-msg'),
    bodyText: 'k6 buyer soak ping',
  });

  const sendRes = http.post(
    `${BASE_URL}/custom-orders/${orderId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${BUYER_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomId('buyer-idem'),
      },
    },
  );

  check(sendRes, {
    'buyer send accepted': (r) => r.status === 201 || r.status === 200 || r.status === 429,
  });

  sleep(0.5);
}

export function brandFlow() {
  const orderId = randomOrderId(BRAND_CUSTOM_ORDER_IDS);

  const listRes = http.get(`${BASE_URL}/brands/${BRAND_ID}/custom-orders/${orderId}/messages?limit=30`, {
    headers: { Authorization: `Bearer ${BRAND_TOKEN}` },
  });

  check(listRes, {
    'brand list status ok': (r) => r.status === 200,
  });

  const payload = JSON.stringify({
    clientMessageId: randomId('brand-msg'),
    bodyText: 'k6 brand soak ping',
  });

  const sendRes = http.post(
    `${BASE_URL}/brands/${BRAND_ID}/custom-orders/${orderId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${BRAND_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomId('brand-idem'),
      },
    },
  );

  check(sendRes, {
    'brand send accepted': (r) => r.status === 201 || r.status === 200 || r.status === 429,
  });

  sleep(0.6);
}

export function bulkSummaryFlow() {
  const buyerPayload = JSON.stringify({
    contextIds: BUYER_CUSTOM_ORDER_IDS,
    includeUnreadCount: 'true',
  });

  const buyerSummaryRes = http.post(
    `${BASE_URL}/custom-orders/messages/summaries`,
    buyerPayload,
    jsonHeaders(BUYER_TOKEN),
  );

  check(buyerSummaryRes, {
    'buyer bulk summary ok': (r) => r.status === 201 || r.status === 200,
  });

  const brandPayload = JSON.stringify({
    contextIds: BRAND_CUSTOM_ORDER_IDS,
    includeUnreadCount: 'true',
  });

  const brandSummaryRes = http.post(
    `${BASE_URL}/brands/${BRAND_ID}/custom-orders/messages/summaries`,
    brandPayload,
    jsonHeaders(BRAND_TOKEN),
  );

  check(brandSummaryRes, {
    'brand bulk summary ok': (r) => r.status === 201 || r.status === 200,
  });

  sleep(0.4);
}
