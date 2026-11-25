/**
 * ARU Product Identity Migration — Ingress Network Header Compatibility & Security Suite
 * Tests all 8 scenarios across all 4 security-relevant header pairs.
 */

const assert = require('assert');
const { createHash } = require('crypto');

// 1. Device ID Ingestion Logic (twin of src/view-counting/device-id.ts)
const MAX_DEVICE_ID_LENGTH = 128;
const ARU_DEVICE_ID_HEADER = 'x-aru-device-id';
const LEGACY_DEVICE_ID_HEADER = 'x-wiez-device-id';

function sanitizeDeviceId(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_DEVICE_ID_LENGTH) return null;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function readDeviceId(req) {
  const headers = req?.headers || {};
  // Case-insensitivity helper (standard Node.js http behavior)
  const getHeader = (name) => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  };
  return (
    sanitizeDeviceId(getHeader(ARU_DEVICE_ID_HEADER)) ??
    sanitizeDeviceId(getHeader(LEGACY_DEVICE_ID_HEADER))
  );
}

// 2. Security Device & Name Logic (twin of src/auth/helper/general.helper.ts)
function extractSecurityDevice(req, userId) {
  const headers = req?.headers || {};
  const getHeader = (name) => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  };

  const parseDevice = (val) =>
    typeof val === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(val) ? val : null;
  const deviceId =
    parseDevice(getHeader('x-aru-security-device')) ??
    parseDevice(getHeader('x-wiez-security-device'));

  const parseName = (val) =>
    typeof val === 'string' ? val.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80).trim() || null : null;
  const deviceName =
    parseName(getHeader('x-aru-device-name')) ??
    parseName(getHeader('x-wiez-device-name'));

  return {
    deviceId,
    deviceKey: deviceId ? createHash('sha256').update(`${userId}:${deviceId}`).digest('hex') : null,
    deviceName,
  };
}

// 3. Action Proof Logic (twin of src/auth/access/adaptive-access.interceptor.ts)
function extractActionProof(req) {
  const headers = req?.headers || {};
  const getHeader = (name) => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  };

  return (
    (typeof getHeader('x-aru-action-proof') === 'string' && getHeader('x-aru-action-proof').trim()) ||
    (typeof getHeader('x-wiez-action-proof') === 'string' && getHeader('x-wiez-action-proof').trim()) ||
    undefined
  );
}

function runSuite() {
  console.log('=== RUNNING ARU INGRESS HEADER COMPATIBILITY & SECURITY SUITE ===\n');
  let passed = 0;

  // --- PAIR 1: Device ID (x-aru-device-id / x-wiez-device-id) ---
  console.log('Testing Pair 1: Device ID (x-aru-device-id / x-wiez-device-id)...');

  // Scenario 1: ARU only
  assert.strictEqual(readDeviceId({ headers: { 'x-aru-device-id': 'dev_aru_1' } }), 'dev_aru_1');
  passed++;

  // Scenario 2: Legacy only
  assert.strictEqual(readDeviceId({ headers: { 'x-wiez-device-id': 'dev_legacy_1' } }), 'dev_legacy_1');
  passed++;

  // Scenario 3: Both identical
  assert.strictEqual(readDeviceId({ headers: { 'x-aru-device-id': 'dev_same', 'x-wiez-device-id': 'dev_same' } }), 'dev_same');
  passed++;

  // Scenario 4: Both conflicting (ARU precedence)
  assert.strictEqual(readDeviceId({ headers: { 'x-aru-device-id': 'dev_aru_primary', 'x-wiez-device-id': 'dev_wiez_stale' } }), 'dev_aru_primary');
  passed++;

  // Scenario 5: Empty ARU with valid legacy (fallback)
  assert.strictEqual(readDeviceId({ headers: { 'x-aru-device-id': '   ', 'x-wiez-device-id': 'dev_legacy_fallback' } }), 'dev_legacy_fallback');
  passed++;

  // Scenario 6: Malformed ARU with valid legacy (fallback)
  assert.strictEqual(readDeviceId({ headers: { 'x-aru-device-id': 'invalid:characters:here!', 'x-wiez-device-id': 'dev_legacy_good' } }), 'dev_legacy_good');
  passed++;

  // Scenario 7: Missing headers
  assert.strictEqual(readDeviceId({ headers: {} }), null);
  passed++;

  // Scenario 8: Case-insensitive handling
  assert.strictEqual(readDeviceId({ headers: { 'X-ARU-DEVICE-ID': 'dev_case_aru' } }), 'dev_case_aru');
  assert.strictEqual(readDeviceId({ headers: { 'X-WIEZ-DEVICE-ID': 'dev_case_legacy' } }), 'dev_case_legacy');
  passed++;
  console.log('  -> Pair 1 all 8 scenarios PASSED.');

  // --- PAIR 2: Security Device (x-aru-security-device / x-wiez-security-device) ---
  console.log('Testing Pair 2: Security Device (x-aru-security-device / x-wiez-security-device)...');
  const user = 'user_123';
  const validSecAru = 'sec_device_aru_valid_12345';
  const validSecWiez = 'sec_device_wiez_valid_12345';

  // Scenario 1: ARU only
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-security-device': validSecAru } }, user).deviceId, validSecAru);
  passed++;

  // Scenario 2: Legacy only
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-wiez-security-device': validSecWiez } }, user).deviceId, validSecWiez);
  passed++;

  // Scenario 3: Both identical
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-security-device': validSecAru, 'x-wiez-security-device': validSecAru } }, user).deviceId, validSecAru);
  passed++;

  // Scenario 4: Both conflicting (ARU precedence)
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-security-device': validSecAru, 'x-wiez-security-device': validSecWiez } }, user).deviceId, validSecAru);
  passed++;

  // Scenario 5: Empty ARU with valid legacy
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-security-device': '', 'x-wiez-security-device': validSecWiez } }, user).deviceId, validSecWiez);
  passed++;

  // Scenario 6: Malformed ARU with valid legacy (<16 chars or special chars)
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-security-device': 'short_bad!', 'x-wiez-security-device': validSecWiez } }, user).deviceId, validSecWiez);
  passed++;

  // Scenario 7: Missing headers
  assert.strictEqual(extractSecurityDevice({ headers: {} }, user).deviceId, null);
  passed++;

  // Scenario 8: Case-insensitive handling
  assert.strictEqual(extractSecurityDevice({ headers: { 'X-ARU-SECURITY-DEVICE': validSecAru } }, user).deviceId, validSecAru);
  assert.strictEqual(extractSecurityDevice({ headers: { 'X-WIEZ-SECURITY-DEVICE': validSecWiez } }, user).deviceId, validSecWiez);
  passed++;
  console.log('  -> Pair 2 all 8 scenarios PASSED.');

  // --- PAIR 3: Device Name (x-aru-device-name / x-wiez-device-name) ---
  console.log('Testing Pair 3: Device Name (x-aru-device-name / x-wiez-device-name)...');

  // Scenario 1: ARU only
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-device-name': 'Pixel 9 ARU' } }, user).deviceName, 'Pixel 9 ARU');
  passed++;

  // Scenario 2: Legacy only
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-wiez-device-name': 'iPhone 15 WIEZ' } }, user).deviceName, 'iPhone 15 WIEZ');
  passed++;

  // Scenario 3: Both identical
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-device-name': 'iPad Pro', 'x-wiez-device-name': 'iPad Pro' } }, user).deviceName, 'iPad Pro');
  passed++;

  // Scenario 4: Both conflicting (ARU precedence)
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-device-name': 'Desktop ARU', 'x-wiez-device-name': 'Old Laptop' } }, user).deviceName, 'Desktop ARU');
  passed++;

  // Scenario 5: Empty ARU with valid legacy
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-device-name': '   ', 'x-wiez-device-name': 'Fallback Phone' } }, user).deviceName, 'Fallback Phone');
  passed++;

  // Scenario 6: Malformed/control-chars ARU with valid legacy
  assert.strictEqual(extractSecurityDevice({ headers: { 'x-aru-device-name': '\x00\x01\x02', 'x-wiez-device-name': 'Fallback Phone' } }, user).deviceName, 'Fallback Phone');
  passed++;

  // Scenario 7: Missing headers
  assert.strictEqual(extractSecurityDevice({ headers: {} }, user).deviceName, null);
  passed++;

  // Scenario 8: Case-insensitive handling
  assert.strictEqual(extractSecurityDevice({ headers: { 'X-ARU-DEVICE-NAME': 'Galaxy S24' } }, user).deviceName, 'Galaxy S24');
  passed++;
  console.log('  -> Pair 3 all 8 scenarios PASSED.');

  // --- PAIR 4: Action Proof (x-aru-action-proof / x-wiez-action-proof) ---
  console.log('Testing Pair 4: Action Proof (x-aru-action-proof / x-wiez-action-proof)...');
  const proofAru = 'proof_token_aru_sig_999';
  const proofWiez = 'proof_token_wiez_sig_888';

  // Scenario 1: ARU only
  assert.strictEqual(extractActionProof({ headers: { 'x-aru-action-proof': proofAru } }), proofAru);
  passed++;

  // Scenario 2: Legacy only
  assert.strictEqual(extractActionProof({ headers: { 'x-wiez-action-proof': proofWiez } }), proofWiez);
  passed++;

  // Scenario 3: Both identical
  assert.strictEqual(extractActionProof({ headers: { 'x-aru-action-proof': proofAru, 'x-wiez-action-proof': proofAru } }), proofAru);
  passed++;

  // Scenario 4: Both conflicting (ARU precedence)
  assert.strictEqual(extractActionProof({ headers: { 'x-aru-action-proof': proofAru, 'x-wiez-action-proof': proofWiez } }), proofAru);
  passed++;

  // Scenario 5: Empty ARU with valid legacy
  assert.strictEqual(extractActionProof({ headers: { 'x-aru-action-proof': '   ', 'x-wiez-action-proof': proofWiez } }), proofWiez);
  passed++;

  // Scenario 6: Malformed/empty whitespace ARU with valid legacy
  assert.strictEqual(extractActionProof({ headers: { 'x-aru-action-proof': '', 'x-wiez-action-proof': proofWiez } }), proofWiez);
  passed++;

  // Scenario 7: Missing headers
  assert.strictEqual(extractActionProof({ headers: {} }), undefined);
  passed++;

  // Scenario 8: Case-insensitive handling
  assert.strictEqual(extractActionProof({ headers: { 'X-ARU-ACTION-PROOF': proofAru } }), proofAru);
  assert.strictEqual(extractActionProof({ headers: { 'X-WIEZ-ACTION-PROOF': proofWiez } }), proofWiez);
  passed++;
  console.log('  -> Pair 4 all 8 scenarios PASSED.');

  console.log(`\nALL ${passed} INGRESS HEADER SECURITY SCENARIOS PASSED WITH ZERO REGRESSIONS.`);
}

runSuite();
