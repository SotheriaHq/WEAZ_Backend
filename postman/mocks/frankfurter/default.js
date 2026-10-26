// Contract: https://frankfurter.dev/ and verified v2 flat-array responses.
const http = require('node:http');
let mode = 'valid';
let requests = 0;
const reply = (res, status, body, contentType = 'application/json') => {
  res.writeHead(status, { 'content-type': contentType });
  res.end(contentType === 'application/json' ? JSON.stringify(body) : body);
};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (req.method === 'POST' && url.pathname === '/__control') {
    let input = '';
    req.on('data', chunk => { input += chunk; });
    req.on('end', () => {
      try { mode = JSON.parse(input).mode; requests = 0; reply(res, 200, { mode }); }
      catch { reply(res, 400, { message: 'Invalid fixture control' }); }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__stats') return reply(res, 200, { requests, mode });
  if (req.method !== 'GET' || url.pathname !== '/v2/rates') return reply(res, 501, { message: 'Endpoint not modeled' });
  requests++;
  if (url.searchParams.get('base') !== 'USD') return reply(res, 422, { message: 'Fixture requires USD reference base' });
  if (mode === 'rate-limit') return reply(res, 429, { message: 'Too many requests' });
  if (mode === 'unavailable') return reply(res, 503, { message: 'Unavailable' });
  if (mode === 'html') return reply(res, 200, '<html>Gateway failure</html>', 'text/html');
  if (mode === 'hanging') return setTimeout(() => reply(res, 200, []), 6500);
  const date = mode === 'old' ? '2000-01-01' : new Date().toISOString().slice(0, 10);
  const rates = { NGN: 1500, USD: 1, EUR: 0.9, GBP: 0.75, GHS: 12, KES: 130, ZAR: 18, PAB: 1 };
  const rows = Object.entries(rates).map(([quote, rate]) => ({ date, base: 'USD', quote, rate }));
  if (mode === 'invalid') rows[0].rate = -1;
  if (mode === 'wrong-base') rows[0].base = 'EUR';
  if (mode === 'duplicate') rows.push(rows[0]);
  return reply(res, 200, rows);
}).listen(Number(process.env.PORT));
