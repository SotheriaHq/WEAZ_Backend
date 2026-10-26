// Local contract subset: https://docs.expo.dev/push-notifications/sending-notifications/
// Synthetic messages only. This simulator does not contact Expo, FCM or APNs.
const http = require('node:http');
const { gunzipSync } = require('node:zlib');
const { randomUUID } = require('node:crypto');
let messages = [];
let requests = 0;
const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
http
  .createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
    if (req.method === 'GET' && pathname === '/__stats')
      return reply(res, 200, { requests, messages });
    if (req.method === 'POST' && pathname === '/__reset') {
      requests = 0;
      messages = [];
      return reply(res, 200, { reset: true });
    }
    if (req.method !== 'POST' || pathname !== '/--/api/v2/push/send')
      return reply(res, 501, { errors: [{ message: 'Endpoint not modeled' }] });
    const handle = (input) => {
      try {
        const batch = Array.isArray(input) ? input : [input];
        if (
          !batch.length ||
          batch.length > 100 ||
          batch.some(
            (message) =>
              typeof message?.to !== 'string' ||
              !/^ExponentPushToken\[fixture-[a-f0-9-]+\]$/.test(message.to) ||
              typeof message.title !== 'string' ||
              typeof message.body !== 'string' ||
              (message.badge != null &&
                (!Number.isInteger(message.badge) || message.badge < 0)),
          )
        )
          return reply(res, 400, {
            errors: [{ message: 'Invalid fixture payload' }],
          });
        requests++;
        messages.push(...batch);
        return reply(res, 200, {
          data: batch.map(() => ({ status: 'ok', id: randomUUID() })),
        });
      } catch {
        return reply(res, 400, { errors: [{ message: 'Invalid JSON' }] });
      }
    };
    // Support Postman interception and direct local execution of the same fixture.
    if (req.body !== undefined) return handle(req.body);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
        handle(JSON.parse(body.toString('utf8')));
      } catch {
        reply(res, 400, { errors: [{ message: 'Invalid JSON' }] });
      }
    });
  })
  .listen(Number(process.env.PORT));
