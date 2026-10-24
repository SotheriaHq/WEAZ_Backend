const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');

async function withServer(app, execute) {
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try { await execute(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('JSON parsing preserves exact webhook bytes for ordinary and compressed requests', async () => {
  const app = express();
  app.use(bodyParser.json({ limit: '2mb', verify: (req, _res, bytes) => { req.rawBody = bytes.toString('utf8'); } }));
  app.post('/webhook', (req, res) => res.json({ body: req.body, rawBody: req.rawBody }));
  const payload = '{"reference":"subscription-capture","amount":1000000}';
  await withServer(app, async base => {
    for (const compressed of [false, true]) {
      const response = await fetch(`${base}/webhook`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) },
        body: compressed ? gzipSync(payload) : payload, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { body: JSON.parse(payload), rawBody: payload });
    }
  });
});

test('malformed trailing compressed bytes cannot take down subsequent requests', async () => {
  const app = express();
  app.use(bodyParser.json());
  app.get('/health', (_req, res) => res.send('ok'));
  app.post('/json', (req, res) => res.json(req.body));
  app.use((_error, _req, res, _next) => res.sendStatus(400));
  await withServer(app, async base => {
    try {
      await fetch(`${base}/json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: Buffer.concat([gzipSync('{"ok":true}'), Buffer.from('invalid trailing bytes')]), signal: AbortSignal.timeout(5000) });
    } catch (error) { assert(['TypeError', 'TimeoutError'].includes(error.name)); }
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200); assert.equal(await health.text(), 'ok');
  });
});

test('multipart memory uploads retain asynchronous filtering and exact field-size boundary', async () => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024, fieldSize: 4 },
    fileFilter: (_req, _file, callback) => setImmediate(() => callback(null, true)) });
  app.post('/upload', upload.single('image'), (req, res) => res.json({ caption: req.body.caption,
    file: req.file.buffer.toString('utf8'), type: req.file.mimetype }));
  const form = new FormData(); form.set('caption', 'WIEZ');
  form.set('image', new Blob(['image bytes'], { type: 'image/jpeg' }), 'sample.jpg');
  await withServer(app, async base => {
    const response = await fetch(`${base}/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { caption: 'WIEZ', file: 'image bytes', type: 'image/jpeg' });
  });
});
