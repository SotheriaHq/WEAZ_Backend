// Local synthetic subset of https://paystack.com/docs/api/transaction/.
// Fixture control routes are test-only; unmodeled provider routes return501.
const http = require('node:http');
let transactions = new Map();
let requests = [];
let nextId = 100000;
const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
http
  .createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
    if (req.method === 'GET' && pathname === '/__stats')
      return reply(res, 200, { requests });
    const handle = (body) => {
      if (req.method === 'POST' && pathname === '/__fixtures') {
        transactions = new Map(
        (body.transactions ?? []).map((row) => [row.reference, { id: nextId++, ...row }]),
        );
        requests = [];
        return reply(res, 200, { reset: true });
      }
      if (req.method === 'GET' && pathname.startsWith('/transaction/verify/')) {
        const reference = decodeURIComponent(
          pathname.slice('/transaction/verify/'.length),
        );
        requests.push({ method: req.method, path: pathname, reference });
        const row = transactions.get(reference);
        if (!row)
          return reply(res, 400, {
            status: false,
            message: 'Invalid transaction reference',
          });
        if (row.httpError)
          return reply(res, row.httpError, {
            status: false,
            message: 'Synthetic provider outage',
          });
        return reply(res, 200, {
          status: true,
          message: 'Verification successful',
          data: {
            id: row.id ?? 12345,
            reference,
            status: row.status,
            amount: row.amount,
            currency: row.currency ?? 'NGN',
            paid_at: row.paid_at,
            customer: { email: row.email },
          },
        });
      }
      if (
        req.method === 'POST' &&
        pathname === '/transaction/charge_authorization'
      ) {
        requests.push({
          method: req.method,
          path: pathname,
          reference: body.reference,
        });
        if (
          !Number.isSafeInteger(body.amount) ||
          body.amount <= 0 ||
          body.currency !== 'NGN' ||
          typeof body.email !== 'string' ||
          !String(body.authorization_code).startsWith('AUTH_fixture_')
        )
          return reply(res, 400, {
            status: false,
            message: 'Invalid fixture authorization charge',
          });
        const row = {
          id: nextId++,
          reference: body.reference,
          status: 'success',
          amount: body.amount,
          currency: body.currency,
          email: body.email,
          paid_at: new Date().toISOString(),
        };
        transactions.set(row.reference, row);
        return reply(res, 200, {
          status: true,
          message: 'Charge attempted',
          data: { ...row, customer: { email: row.email } },
        });
      }
      return reply(res, 501, {
        status: false,
        message: 'Provider endpoint not modeled',
      });
    };
    if (req.body !== undefined) return handle(req.body);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        handle(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
            : {},
        );
      } catch {
        reply(res, 400, { status: false, message: 'Invalid JSON' });
      }
    });
  })
  .listen(Number(process.env.PORT));
