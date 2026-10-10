// Zabezpieczenia HTTP: nagłówki + CSP z nonce, limity zapytań, ochrona przed CSRF, serwowanie stron HTML.
import crypto from 'node:crypto';
import fs from 'node:fs';

const baseUrl = () => {
  const raw = (process.env.DASHBOARD_BASE_URL || '').trim().replace(/^["']+|["']+$/g, '').replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
};

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.removeHeader('X-Powered-By');
  if (baseUrl().startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

export function buildCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https:",
    'media-src https:',
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'"
  ].join('; ');
}

// Serwuje plik HTML, nadając każdemu <script> świeży nonce (bez 'unsafe-inline' dla skryptów)
export function serveHtml(file) {
  return (_req, res) => {
    let html;
    try { html = fs.readFileSync(file, 'utf8'); } catch { return res.status(500).send('Nie można wczytać strony.'); }
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', buildCsp(nonce));
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`));
  };
}

// Limit zapytań w oknie czasowym (w pamięci, na adres IP lub własny klucz)
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Zbyt wiele żądań. Spróbuj za chwilę.', redirect = null }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.max(windowMs, 10_000)).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(k, entry); }
    entry.count += 1;
    if (entry.count <= max) return next();
    res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
    if (redirect) return res.redirect(redirect);
    return res.status(429).json({ ok: false, error: message });
  };
}

// Ochrona przed CSRF dla żądań zmieniających dane: źródło musi być tym samym adresem co panel
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const deny = () => res.status(403).json({ ok: false, error: 'Niedozwolone źródło żądania.' });
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
    if (baseUrl()) { try { allowed.add(new URL(baseUrl()).origin); } catch { /* pomijamy */ } }
    return allowed.has(origin) ? next() : deny();
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return deny();
  return next();
}

// Ostatnia linia obrony: błędy middleware (np. za duży JSON) jako JSON, bez szczegółów technicznych
export function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error('[http]', err);
  const message = status === 413 ? 'Zbyt duży ładunek żądania.' : status === 400 ? 'Niepoprawne dane żądania.' : 'Błąd serwera.';
  res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: message });
}
