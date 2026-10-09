const crypto = require('crypto');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const reports = globalThis.__lelaAdminReports || [];
const bans = globalThis.__lelaAdminBans || new Map();
globalThis.__lelaAdminReports = reports;
globalThis.__lelaAdminBans = bans;

// ip -> { count, first } used to throttle repeated failed admin logins.
const loginThrottle = new Map();

// SECURITY: forwarding headers are only trustworthy when this function actually
// runs behind a proxy that rewrites them. Trusting them unconditionally let an
// attacker mint a fresh throttle bucket per request by rotating
// x-forwarded-for, which disabled the brute-force protection entirely.
const TRUST_PROXY = (() => {
  const configured = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  // Hosting platforms that always terminate TLS/proxy in front of the function.
  return Boolean(process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RENDER);
})();

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isValidIp(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return false;
  if (candidate.includes(':')) return /^[0-9a-fA-F:]+$/.test(candidate);
  if (!IPV4.test(candidate)) return false;
  return candidate.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

/**
 * Resolve the client address used for throttling and audit logging.
 * Only reads forwarding headers when we are configured to sit behind a trusted
 * proxy, and validates every value so a malformed header cannot be used to
 * create unlimited distinct throttle keys.
 */
function clientIp(req) {
  const headers = req.headers || {};

  if (TRUST_PROXY) {
    const candidates = [
      headers['x-vercel-forwarded-for'],
      headers['cf-connecting-ip'],
      headers['x-real-ip'],
      headers['true-client-ip'],
      headers['x-forwarded-for']
    ];
    for (const raw of candidates) {
      if (!raw) continue;
      const first = String(raw).split(',')[0].trim().replace(/^\[|\]$/g, '');
      if (isValidIp(first)) return first;
    }
  }

  // Socket address: not controllable by the client.
  const remote = req.socket?.remoteAddress || 'unknown';
  return isValidIp(remote) ? String(remote).trim().replace(/^\[|\]$/g, '') : 'unknown';
}

/**
 * Session signing secret.
 *
 * SECURITY: this used to fall back to the literal 'lela-admin-session-secret'
 * when no environment variable was set. That constant is public knowledge, so
 * anybody could have hand-crafted a valid admin_session cookie and taken over
 * the Vercel deployment. There is now no default: with no configured secret,
 * every session is rejected and login is refused.
 */
function getSecret() {
  const secret = String(
    process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || ''
  ).trim();
  if (!secret) return null;
  if (secret === 'lela-admin-session-secret') return null; // refuse the old literal
  return secret;
}

function secureCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function base64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function unbase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(value) {
  const secret = getSecret();
  if (!secret) return '';
  return base64url(crypto.createHmac('sha256', secret).update(value).digest());
}

function createSession() {
  const payload = base64url(JSON.stringify({
    exp: Date.now() + SESSION_TTL_MS
  }));
  return `${payload}.${sign(payload)}`;
}

function validSession(token) {
  if (!token || typeof token !== 'string') return false;
  if (!getSecret()) return false; // no secret configured: reject everything
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  if (!expected) return false;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  try {
    const data = JSON.parse(unbase64url(payload));
    return Number.isFinite(data.exp) && Date.now() < data.exp;
  } catch {
    return false;
  }
}

function cookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function setCookie(res, value) {
  res.setHeader('Set-Cookie', value);
}

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  const token = cookies(req).admin_session;
  if (!validSession(token)) {
    json(res, 401, { error: 'Admin authentication required.' });
    return false;
  }
  return true;
}

function activeBans() {
  const now = Date.now();
  const result = [];
  for (const [userId, ban] of bans.entries()) {
    if (ban.expiresAt && now >= ban.expiresAt) {
      bans.delete(userId);
      continue;
    }
    result.push({ userId, ...ban });
  }
  return result;
}

function durationMs(value) {
  return ({
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    'permanent': null
  })[value] ?? 24 * 60 * 60 * 1000;
}

module.exports = async function handler(req, res) {
  const parts = Array.isArray(req.query.path)
    ? req.query.path
    : (typeof req.query.path === 'string' ? req.query.path.split('/').filter(Boolean) : []);
  const action = parts.join('/');

  if (action === 'login' && req.method === 'POST') {
    // Refuse to mint sessions at all when no signing secret is configured.
    if (!getSecret()) {
      return json(res, 503, { error: 'Admin login is not configured on this deployment.' });
    }

    const usernameExpected = process.env.ADMIN_USERNAME || '';
    const passwordExpected = process.env.ADMIN_PASSWORD || '';

    if (!usernameExpected || !passwordExpected) {
      return json(res, 503, { error: 'Admin login is not configured on this deployment.' });
    }

    // SECURITY: the throttle key used to be taken straight from x-forwarded-for.
    // That header is fully attacker-controlled whenever the function is not
    // provably behind a trusted proxy, so rotating it on every request defeated
    // the brute-force lockout completely. Resolve the address through a single
    // validated helper instead, exactly as server.cjs does with its TRUST_PROXY
    // gate, and fall back to the socket address we cannot forge.
    const ip = clientIp(req);
    const nowMs = Date.now();
    const bucket = loginThrottle.get(ip);
    if (bucket && bucket.count >= 5 && nowMs - bucket.first < 15 * 60 * 1000) {
      return json(res, 429, { error: 'Too many failed attempts. Try again later.' });
    }

    let data;
    try { data = await body(req); }
    catch (error) { return json(res, 400, { error: error.message }); }

    const username = String(data.username || '');
    const password = String(data.password || '');

    // SECURITY: a plain !== comparison leaks the correct value one character
    // at a time through response timing. Both fields are always compared so the
    // work done does not depend on which one is wrong.
    const usernameOk = secureCompare(username, usernameExpected);
    const passwordOk = secureCompare(password, passwordExpected);
    const valid = usernameOk && passwordOk;

    if (!valid) {
      const entry = loginThrottle.get(ip);
      if (entry && nowMs - entry.first < 15 * 60 * 1000) {
        entry.count += 1;
      } else {
        loginThrottle.set(ip, { count: 1, first: nowMs });
      }
      return json(res, 401, { error: 'Invalid admin credentials.' });
    }

    loginThrottle.delete(ip);

    const token = createSession();
    if (!token) {
      return json(res, 503, { error: 'Admin login is not configured on this deployment.' });
    }
    setCookie(res, `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax; Secure`);
    return json(res, 200, { ok: true });
  }

  if (action === 'logout' && req.method === 'POST') {
    setCookie(res, 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    return json(res, 200, { ok: true });
  }

  if (!requireAdmin(req, res)) return;

  if (action === 'stats' && req.method === 'GET') {
    return json(res, 200, {
      online: 0,
      activeMatches: 0,
      waiting: 0,
      reportsTotal: reports.length,
      pendingReports: reports.filter(r => r.status === 'pending').length,
      activeBans: activeBans().length,
      serverTime: new Date().toISOString()
    });
  }

  if (action === 'users' && req.method === 'GET') {
    return json(res, 200, []);
  }

  if (action === 'reports' && req.method === 'GET') {
    return json(res, 200, reports);
  }

  if (action === 'bans' && req.method === 'GET') {
    return json(res, 200, activeBans());
  }

  const reportMatch = action.match(/^reports\/(\d+)\/(resolve|dismiss|ban)$/);
  if (reportMatch && req.method === 'POST') {
    const id = Number(reportMatch[1]);
    const operation = reportMatch[2];
    const report = reports.find(item => item.id === id);
    if (!report) return json(res, 404, { error: 'Report not found.' });

    if (operation === 'resolve') report.status = 'resolved';
    if (operation === 'dismiss') report.status = 'dismissed';
    if (operation === 'ban') {
      let data = {};
      try { data = await body(req); } catch {}
      const duration = String(data.duration || '24h');
      const ms = durationMs(duration);
      bans.set(report.reportedUserId, {
        reason: `Report #${report.id}: ${report.reason}`,
        createdAt: Date.now(),
        expiresAt: ms ? Date.now() + ms : null
      });
      report.status = 'resolved';
      report.action = `ban:${duration}`;
    }
    report.resolvedAt = Date.now();
    return json(res, 200, { ok: true, report });
  }

  const userMatch = action.match(/^users\/([^/]+)\/(ban|unban|disconnect)$/);
  if (userMatch && req.method === 'POST') {
    const userId = decodeURIComponent(userMatch[1]);
    const operation = userMatch[2];

    if (operation === 'disconnect') {
      return json(res, 200, { ok: true });
    }

    if (operation === 'unban') {
      bans.delete(userId);
      return json(res, 200, { ok: true });
    }

    let data = {};
    try { data = await body(req); } catch {}
    const duration = String(data.duration || '24h');
    const ms = durationMs(duration);
    bans.set(userId, {
      reason: String(data.reason || 'Administrator ban'),
      createdAt: Date.now(),
      expiresAt: ms ? Date.now() + ms : null
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Admin endpoint not found.' });
};
