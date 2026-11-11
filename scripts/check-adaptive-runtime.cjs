// Verify configuration before draining the working runtime. Never log key values.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { ConfigService } = require('@nestjs/config');
const { encryptFactor, decryptFactor } = require('../src/auth/access/security-factor-crypto');
const { passkeyConfiguration } = require('../src/auth/access/passkey-configuration');
const { StoreBankIdentity } = require('../src/store/store-payment-account-sync');

function checkAdaptiveRuntime(env) {
  const config = new ConfigService(env);
  for (const name of ['REFRESH_TOKEN_HASH_SECRET', 'PAYMENT_SAVED_METHODS_SECRET']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error(`${name} is required before the security cutover.`);
  }
  const sealed = encryptFactor(config, 'runtime-probe', 'runtime-probe', 'configuration-check');
  if (decryptFactor(config, 'runtime-probe', 'runtime-probe', sealed) !== 'configuration-check') throw new Error('MFA encryption configuration failed.');
  new StoreBankIdentity(env.STORE_PAYOUT_IDENTITY_SECRET);
  const passkeys = passkeyConfiguration(config);
  if (!['observe', 'enforce'].includes(env.SECURITY_RISK_MODE || 'observe')) throw new Error('Unsupported SECURITY_RISK_MODE.');
  return { passed: true, passkeyRpId: passkeys.rpID, androidPasskeysConfigured: passkeys.androidConfigured,
    riskMode: env.SECURITY_RISK_MODE || 'observe' };
}
module.exports = { checkAdaptiveRuntime };
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  try { console.log(JSON.stringify(checkAdaptiveRuntime(process.env))); }
  catch { console.error('Adaptive runtime configuration is incomplete or invalid. Keep the current release running and review the MFA/passkey and payout-account runbooks. No secret values were logged.'); process.exitCode = 1; }
}
