/**
 * Every custom header the web client sends must be in the CORS allow-list.
 *
 * This is not a degradation when it is wrong. A browser refuses to send a
 * cross-origin request carrying a header the preflight did not approve, so a
 * missing entry takes the ENTIRE web app off the API — `weaz.me` talks to
 * `api.weaz.me`, and `httpClient` attaches its headers to every call.
 *
 * It is also invisible locally: same-origin dev servers issue no preflight, so
 * the app works perfectly right up until it is deployed. Adding
 * `x-wiez-device-id` to the client passed typecheck, passed every unit test,
 * and would have shipped a dead web app.
 *
 * So the check reads the CLIENT for the headers it actually sets and the
 * SERVER for the ones it permits, and compares them. It skips with a printed
 * reason when the web repo is not checked out.
 */
const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'src', 'main.ts');
const clientPath = path.join(
  __dirname,
  '..',
  '..',
  'fthreadly',
  'src',
  'api',
  'httpClient.ts',
);

const allowedFromServer = () => {
  const source = fs.readFileSync(mainPath, 'utf8');
  // The always-allowed literal array, plus anything the env list can add at
  // runtime (which this cannot see, so it is treated as "not guaranteed").
  const block = source.match(/\[\s*\n(?:\s*'[^']+',\s*\n)+\s*\]\.forEach\(\(h\) => allowedHeadersSet\.add\(h\)\)/);
  if (!block) {
    console.error('Could not find the always-allowed header array in main.ts.');
    process.exit(1);
  }
  return new Set(
    Array.from(block[0].matchAll(/'([^']+)'/g)).map((match) =>
      match[1].toLowerCase(),
    ),
  );
};

/**
 * Headers the client sets on outgoing requests.
 *
 * Deliberately matches `headers.set('...')` rather than every string in the
 * file: the goal is what actually goes on the wire.
 */
const sentByClient = () => {
  const source = fs.readFileSync(clientPath, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(/headers\.set\(\s*'([^']+)'/g)) {
    found.add(match[1].toLowerCase());
  }
  /*
    Header names held in constants.

    Resolved across the whole client tree, not just this file: the first
    version of this check only looked inside `httpClient.ts`, and
    `WIEZ_DEVICE_ID_HEADER` is declared in `utils/deviceId.ts` and imported.
    So the constant was seen, its value was not, and the check passed while
    the header was missing from the allow-list — the exact regression it
    exists to catch. Verified by removing the entry and watching it fail.
  */
  const constants = Array.from(
    source.matchAll(/headers\.set\(\s*([A-Z_][A-Z0-9_]*)\s*,/g),
  ).map((match) => match[1]);

  if (constants.length > 0) {
    const clientSrc = path.join(__dirname, '..', '..', 'fthreadly', 'src');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(clientSrc);

    for (const constant of constants) {
      let resolved = null;
      for (const file of files) {
        const declared = fs
          .readFileSync(file, 'utf8')
          .match(new RegExp(`\\b${constant}\\s*=\\s*'([^']+)'`));
        if (declared) {
          resolved = declared[1];
          break;
        }
      }
      if (!resolved) {
        console.error(
          `Could not resolve the value of ${constant}, which the client sets as a header.`,
        );
        console.error(
          'Declare it as a string literal so this check can see it, or the',
        );
        console.error('allow-list cannot be verified.');
        process.exit(1);
      }
      found.add(resolved.toLowerCase());
    }
  }

  return found;
};

if (!fs.existsSync(clientPath)) {
  console.log(
    'client header contract skipped — fthreadly is not checked out beside this repo',
  );
  process.exit(0);
}

const allowed = allowedFromServer();
const sent = sentByClient();

/** Headers every browser sends without needing to be allow-listed. */
const CORS_SAFELISTED = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'authorization', // always in the base allow-list; checked below anyway
  'range',
]);

const missing = Array.from(sent).filter(
  (header) => !CORS_SAFELISTED.has(header) && !allowed.has(header),
);

if (missing.length > 0) {
  console.error('CORS allow-list is missing headers the web client sends:\n');
  for (const header of missing) {
    console.error(`  ${header}`);
  }
  console.error(
    '\nAdd them to the always-allowed array in bthreadly/src/main.ts.',
  );
  console.error(
    'Without this the browser blocks the request at preflight and the whole',
  );
  console.error('web app loses the API — it will look fine locally.');
  process.exit(1);
}

console.log(
  `client header contract passed (${sent.size} client headers, all permitted by CORS)`,
);
