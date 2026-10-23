const fs = require('node:fs');
const path = require('node:path');

const WORKER_NAME = 'wiez-sit-media-gateway';
const BUCKET_NAME = 'wiez-sit-media';
const ALLOWED_ORIGINS = require('../../docs/storage/r2-sit-cors.json')[0].AllowedOrigins;

/** Generate a concrete config only after the account's public endpoint is known. */
function createSitGatewayConfig({ baseUrl, transport, zoneName, jurisdiction }) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('The gateway requires an HTTPS URL without credentials, port, query or fragment');
  if (/%|\\|\/\//.test(url.pathname) || url.pathname.split('/').some((part) => part === '.' || part === '..')) throw new Error('Use a plain canonical gateway route prefix');
  if (/(?:^|\.)r2\.dev$|(?:^|\.)r2\.cloudflarestorage\.com$|(?:^|\.)amazonaws\.com(?:\.cn)?$/.test(url.hostname)) throw new Error('A raw bucket/API hostname cannot be a gateway');
  const normalizedBase = url.href.replace(/\/+$/, '');
  let route;
  if (transport === 'workers-dev') {
    if (!new RegExp(`^${WORKER_NAME}\\.[a-z0-9-]+\\.workers\\.dev$`).test(url.hostname)) throw new Error('Use the verified Workers account subdomain for this exact Worker name');
    route = 'routes = []';
  } else if (transport === 'route' || transport === 'custom-domain') {
    if (!zoneName || !/^[a-z0-9.-]+$/.test(zoneName) || !(url.hostname === zoneName || url.hostname.endsWith(`.${zoneName}`))) throw new Error('Specify the confirmed Cloudflare zone containing this hostname');
    route = transport === 'route'
      ? `routes = [{ pattern = ${JSON.stringify(`${normalizedBase}/*`)}, zone_name = ${JSON.stringify(zoneName)} }]`
      : `routes = [{ pattern = ${JSON.stringify(url.hostname)}, custom_domain = true }]`;
  } else throw new Error('Choose workers-dev, route or custom-domain explicitly');
  if (jurisdiction && !['eu', 'us', 'fedramp'].includes(jurisdiction)) throw new Error('Unsupported bucket jurisdiction');

  return `# Generated from verified SIT endpoint inputs; contains no credentials.\n`
    + `name = ${JSON.stringify(WORKER_NAME)}\nmain = "worker.mjs"\ncompatibility_date = "2026-10-21"\n`
    + `workers_dev = ${transport === 'workers-dev'}\npreview_urls = false\n${route}\n\n`
    + `[[r2_buckets]]\nbinding = "MEDIA_BUCKET"\nbucket_name = ${JSON.stringify(BUCKET_NAME)}\n`
    + (jurisdiction ? `jurisdiction = ${JSON.stringify(jurisdiction)}\n` : '')
    + `\n[vars]\nMEDIA_GATEWAY_BASE_URL = ${JSON.stringify(normalizedBase)}\nMEDIA_GATEWAY_ENVIRONMENT = "sit"\n`
    + `MEDIA_GATEWAY_MAX_TTL_SECONDS = "900"\nMEDIA_GATEWAY_ALLOWED_ORIGINS = ${JSON.stringify(ALLOWED_ORIGINS.join(','))}\nMEDIA_GATEWAY_CACHE_VERSION = "v1"\n`;
}

module.exports = { createSitGatewayConfig };

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  const names = { '--base-url': 'baseUrl', '--transport': 'transport', '--zone-name': 'zoneName', '--jurisdiction': 'jurisdiction', '--out': 'out' };
  try {
    for (let index = 0; index < args.length; index += 2) {
      if (!names[args[index]] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Expected --base-url URL --transport workers-dev|route|custom-domain [--zone-name ZONE] [--jurisdiction eu|us|fedramp] [--out PATH]');
      options[names[args[index]]] = args[index + 1];
    }
    if (!options.baseUrl || !options.transport) throw new Error('A verified base URL and explicit transport are required');
    const output = path.resolve(__dirname, options.out || 'wrangler.sit.toml');
    if (path.dirname(output) !== __dirname || !/^wrangler(?:\.sit)?\.toml$/.test(path.basename(output))) throw new Error('Output must be wrangler.sit.toml or wrangler.toml in this gateway directory');
    const config = createSitGatewayConfig(options);
    fs.writeFileSync(output, config, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`Created ${output}; no deployment or environment switch performed.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid SIT configuration'}\n`);
    process.exitCode = 1;
  }
}
