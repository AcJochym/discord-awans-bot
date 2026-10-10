import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCsp, rateLimit, sameOrigin, serveHtml, errorHandler } from './security.js';

const makeRes = () => {
  const res = { code: 200, headers: {}, body: null, redirected: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.type = () => res;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.redirect = (u) => { res.redirected = u; };
  return res;
};
const makeReq = (over = {}) => ({ method: 'POST', headers: {}, protocol: 'https', get: () => 'panel.example.com', ip: '1.2.3.4', ...over });

test('CSRF: żądanie z obcego źródła jest odrzucane', () => {
  const res = makeRes();
  let passed = false;
  sameOrigin(makeReq({ headers: { origin: 'https://evil.example' } }), res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.code, 403);
});

test('CSRF: to samo źródło i zapytania odczytu przechodzą', () => {
  let ok = 0;
  sameOrigin(makeReq({ headers: { origin: 'https://panel.example.com' } }), makeRes(), () => { ok += 1; });
  sameOrigin(makeReq({ method: 'GET', headers: { origin: 'https://evil.example' } }), makeRes(), () => { ok += 1; });
  assert.equal(ok, 2);
});

test('CSRF: Sec-Fetch-Site cross-site bez Origin jest odrzucane', () => {
  const res = makeRes();
  let passed = false;
  sameOrigin(makeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.code, 403);
});

test('limit zapytań blokuje po przekroczeniu i zwraca Retry-After', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 3 });
  let passed = 0;
  const res = makeRes();
  for (let i = 0; i < 5; i += 1) limiter(makeReq({ method: 'GET' }), res, () => { passed += 1; });
  assert.equal(passed, 3);
  assert.equal(res.code, 429);
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('limit zapytań liczy każdy adres IP osobno', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1 });
  let passed = 0;
  limiter(makeReq({ ip: '10.0.0.1' }), makeRes(), () => { passed += 1; });
  limiter(makeReq({ ip: '10.0.0.2' }), makeRes(), () => { passed += 1; });
  assert.equal(passed, 2);
});

test('CSP: skrypty tylko z nonce, bez unsafe-inline, brak osadzania w ramkach', () => {
  const csp = buildCsp('abc123');
  assert.match(csp, /script-src 'nonce-abc123'/);
  assert.doesNotMatch(csp.split(';').find((p) => p.includes('script-src')), /unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('serveHtml dodaje nonce do każdego <script> i nagłówek CSP', () => {
  const file = path.join(os.tmpdir(), `csp-test-${process.pid}.html`);
  fs.writeFileSync(file, '<html><script>1</script><script src="/a.js"></script></html>');
  const res = makeRes();
  serveHtml(file)({}, res);
  const nonce = /nonce-([^']+)'/.exec(res.headers['Content-Security-Policy'])[1];
  assert.equal(res.body.split(`nonce="${nonce}"`).length - 1, 2);
  fs.unlinkSync(file);
});

test('errorHandler nie zdradza szczegółów technicznych', () => {
  const res = makeRes();
  errorHandler(Object.assign(new Error('secret stack info'), { status: 413 }), {}, res, () => {});
  assert.equal(res.code, 413);
  assert.doesNotMatch(JSON.stringify(res.body), /secret/);
});