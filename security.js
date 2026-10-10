import crypto from 'node:crypto';
import fs from 'node:fs';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export function buildCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://discord.com https://cdn.discordapp.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

export function serveHtml(filePath) {
  return (req, res) => {
    const nonce = crypto.randomBytes(18).toString('base64');
    const html = fs.readFileSync(filePath, 'utf8').replace(/<script\b([^>]*)>/gi, (tag, attributes) => {
      if (/\bnonce\s*=/.test(attributes)) return tag;
      return `<script nonce="${nonce}"${attributes}>`;
    });
    res.setHeader('Content-Security-Policy', buildCsp(nonce));
    res.type('html').send(html);
  };
}

export function rateLimit({ windowMs, max, redirect } = {}) {
  const requests = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = requests.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      requests.set(key, entry);
    }

    entry.count += 1;
    if (entry.count <= max) return next();

    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    if (redirect) return res.redirect(redirect);
    return res.status(429).json({ error: 'Zbyt wiele żądań. Spróbuj ponownie później.' });
  };
}

export function sameOrigin(req, res, next) {
  if (safeMethods.has(req.method)) return next();
  const fetchSite = req.headers?.['sec-fetch-site'] ?? req.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return res.status(403).json({ error: 'Żądanie z niedozwolonego źródła.' });
  }

  const origin = req.headers?.origin ?? req.get('origin');
  if (!origin) return next();

  let requestOrigin;
  try {
    requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
    if (new URL(origin).origin === requestOrigin) return next();
  } catch {}

  return res.status(403).json({ error: 'Żądanie z niedozwolonego źródła.' });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) console.error('Błąd obsługi żądania:', error);
  return res.status(status).json({ error: status >= 500 ? 'Wystąpił błąd serwera.' : 'Nieprawidłowe żądanie.' });
}
