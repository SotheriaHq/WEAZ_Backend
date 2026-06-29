const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const authService = fs.readFileSync(
  path.join(root, 'src/auth/auth.service.ts'),
  'utf8',
);

assert.match(
  authService,
  /scenarioKey:\s*'auth\.email_verification'[\s\S]*?dispatchImmediately:\s*true/,
  'signup verification email must dispatch immediately',
);

assert.match(
  authService,
  /scenarioKey:\s*'auth\.email_verification\.resend'[\s\S]*?dispatchImmediately:\s*true/,
  'resend verification email must dispatch immediately',
);

assert.match(
  authService,
  /emitVerificationEmailDeliveryAlert\(\{[\s\S]*?phase:\s*'signup'/,
  'signup delivery failure path must emit an operational alert',
);

assert.match(
  authService,
  /emitVerificationEmailDeliveryAlert\(\{[\s\S]*?phase:\s*'resend'/,
  'resend delivery failure path must emit an operational alert',
);

assert.match(
  authService,
  /if \(dispatchResult\.dispatchStatus === 'FAILED'\)[\s\S]*?ServiceUnavailableException/,
  'resend delivery failure must not return a fake success',
);

assert.doesNotMatch(
  authService,
  /console\.log\([^)]*verification(Token|Code)|logger\.[a-z]+\([^)]*verification(Token|Code)/i,
  'verification tokens or codes must not be logged',
);

console.log('auth verification email contract passed');
