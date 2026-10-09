require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");
const { isIP } = require("net");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const supabase = require("./lib/supabase.cjs");
const redis = require("./lib/redis.cjs");
const rtcConfig = require("./lib/rtc-config.cjs");

// Never let an unhandled Promise rejection silently kill the moderation/chat
// runtime. Log the real reason so hosted runtimes (including Vercel) expose
// something actionable instead of "Unhandled Rejection: [object Object]".
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) {
    console.error("[UNHANDLED REJECTION]", reason.stack || reason.message);
  } else {
    try {
      console.error("[UNHANDLED REJECTION]", JSON.stringify(reason));
    } catch (_) {
      console.error("[UNHANDLED REJECTION]", String(reason));
    }
  }
});

// Wrap async EventEmitter/WebSocket callbacks so rejected promises never escape
// the ws event loop. This is important on Vercel because an unhandled rejection
// can terminate a Function invocation and take every connected client with it.
function safeAsync(fn, label) {
  return (...args) => {
    Promise.resolve()
      .then(() => fn(...args))
      .catch((error) => {
        console.error(`[ASYNC ERROR] ${label}:`, error?.stack || error?.message || error);
      });
  };
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(250, Number(timeoutMs) || 5000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || "Operation"} timed out`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// Runtime Port & Host configuration
// AI Studio dev server strictly routes to 3000
const PORT = process.env.PORT && process.env.PORT !== "8080" ? parseInt(process.env.PORT, 10) : 3000;
const HOST = "0.0.0.0";

const publicDir = path.join(__dirname, "public");
const adminDir = path.join(__dirname, "admin");
const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
if (!fs.existsSync(adminDir)) {
  fs.mkdirSync(adminDir, { recursive: true });
}

// ==================================================
// SECURITY & JWT CONFIGURATION
// ==================================================

const IS_PRODUCTION =
  process.env.NODE_ENV === "production" ||
  Boolean(
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.FLY_APP_NAME ||
    process.env.HEROKU_APP_ID ||
    process.env.KOYEB_SERVICE_ID ||
    process.env.VERCEL ||
    process.env.DIGITALOCEAN_APP_ID ||
    process.env.ZEABUR_ENVIRONMENT
  );

// Development-only fallbacks. These are intentionally weak and are ONLY ever
// used when the server is not running in production, so you can log in with
// admin/admin123 locally without any setup.
//
// SECURITY: a JWT signing key must be unpredictable. If a deployment ever
// started with this literal, anyone could mint their own admin token. It is
// therefore rejected outright in production (see validateProductionSecrets).
const DEV_FALLBACK_JWT_SECRET = "dev-only-insecure-jwt-secret-do-not-use-in-production";
const DEV_FALLBACK_ADMIN_USERNAME = "admin";
const DEV_FALLBACK_ADMIN_PASSWORD = "admin123";

const JWT_SECRET = String(
  process.env.JWT_SECRET || (IS_PRODUCTION ? "" : DEV_FALLBACK_JWT_SECRET)
).trim();
const JWT_EXPIRY = String(process.env.JWT_EXPIRY || "2h").trim();
const JWT_ISSUER = "lela-admin";

// Upper bound used when a revoked token carries no usable exp claim. Mirrors the
// default 2h JWT lifetime so a logout is remembered for as long as it matters.
const TOKEN_BLACKLIST_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

// Hashing the token before it is used as a map key means the raw bearer token is
// never retained in a long-lived in-memory structure.
function hashTokenForLookup(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const ADMIN_USERNAME = String(
  process.env.ADMIN_USERNAME || (IS_PRODUCTION ? "" : DEV_FALLBACK_ADMIN_USERNAME)
).trim();
const ADMIN_PASSWORD = String(
  process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? "" : DEV_FALLBACK_ADMIN_PASSWORD)
);

// In production a custom private route can be supplied through ADMIN_PATH.
// Defaults to /admin for direct access only in development.
//
// SECURITY: this previously fell back to "/admin" unconditionally, which meant a
// production deploy that reached this line without ADMIN_PATH (reachable via the
// ALLOW_WEAK_SECRETS escape hatch, or any future code path that reaches this
// before the production gate runs) served the entire admin dashboard at the
// well-known, guessable /admin path. The admin page is guarded by a password,
// but "hidden only by an unguessable URL" is the second line of defence, not the
// first. validateProductionSecrets() already demands ADMIN_PATH in production,
// so failing closed here changes nothing for a correctly configured deploy - it
// only removes the guessable-path fallback. In production ADMIN_ROUTE is now
// null, and every use below is null-guarded, so no admin route exists at all
// rather than falling back to /admin.
const rawAdminPath = String(process.env.ADMIN_PATH || "").trim();
const ADMIN_ROUTE = rawAdminPath
  ? `/${rawAdminPath.replace(/^\/+|\/+$/g, "")}`
  : (IS_PRODUCTION ? null : "/admin");

/**
 * Production startup gate.
 *
 * Previously this only logged a warning, which meant a misconfigured
 * deployment could silently start with no admin password at all. Production
 * now refuses to start when a required secret is missing or weak, matching
 * what ADMIN_PRIVATE_PATH_SETUP.md already documented.
 *
 * Set ALLOW_WEAK_SECRETS=true to downgrade this to a warning (only useful
 * for temporary debugging, never for a real deployment).
 */
function validateProductionSecrets() {
  const problems = [];

  if (JWT_SECRET.length < 32) {
    problems.push("JWT_SECRET must be set and at least 32 characters long");
  }
  if (JWT_SECRET === DEV_FALLBACK_JWT_SECRET) {
    problems.push("JWT_SECRET is still the built-in development value");
  }

  if (!ADMIN_USERNAME) {
    problems.push("ADMIN_USERNAME must be set");
  }

  if (!ADMIN_PASSWORD) {
    problems.push("ADMIN_PASSWORD must be set");
  } else if (ADMIN_PASSWORD === DEV_FALLBACK_ADMIN_PASSWORD) {
    problems.push("ADMIN_PASSWORD is still the default admin123");
  } else if (
    ADMIN_PASSWORD.length < 12 ||
    !/[a-z]/.test(ADMIN_PASSWORD) ||
    !/[A-Z]/.test(ADMIN_PASSWORD) ||
    !/[0-9]/.test(ADMIN_PASSWORD) ||
    !/[^A-Za-z0-9]/.test(ADMIN_PASSWORD)
  ) {
    problems.push(
      "ADMIN_PASSWORD must be at least 12 characters and include uppercase, lowercase, a number and a symbol"
    );
  }

  const adminPath = String(process.env.ADMIN_PATH || "").trim();
  if (!adminPath) {
    problems.push("ADMIN_PATH must be set to a private path so /admin is not publicly reachable");
  } else if (adminPath.length < 24 || !/^[A-Za-z0-9_-]+$/.test(adminPath)) {
    problems.push("ADMIN_PATH must be 24+ characters using only letters, numbers, hyphens or underscores");
  }

  if (!supabase.isSupabaseConfigured()) {
    problems.push("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  return problems;
}

if (IS_PRODUCTION) {
  const problems = validateProductionSecrets();
  if (problems.length) {
    const allowWeak = String(process.env.ALLOW_WEAK_SECRETS || "").toLowerCase() === "true";
    const details = problems.map((problem) => `  - ${problem}`).join("\n");
    if (!allowWeak) {
      console.error(
        `\n[SECURITY] Refusing to start in production with insecure configuration:\n${details}\n\n` +
          "Set these values in your hosting platform's environment variables and redeploy.\n" +
          "Local development is unaffected: NODE_ENV is not 'production'.\n"
      );
      process.exit(1);
    }
    console.warn(`[SECURITY] Running with weak configuration (ALLOW_WEAK_SECRETS=true):\n${details}`);
  }
}

const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);


const ENV_ADMIN_PASSWORD_HASH = ADMIN_PASSWORD
  ? bcrypt.hashSync(ADMIN_PASSWORD, 12)
  : null;

// Role-Based Access Control (RBAC) Permission Matrix
const ROLE_PERMISSIONS = {
  superadmin: ["*"],
  admin: [
    "ads:read", "ads:write", "ads:delete",
    "reports:read", "reports:write",
    "bans:read", "bans:write",
    "clients:read", "clients:kick",
    "broadcast:send",
    "analytics:read",
    "logs:read"
  ],
  moderator: [
    "reports:read", "reports:write",
    "bans:read", "bans:write",
    "clients:read", "clients:kick",
    "broadcast:send",
    "ads:read"
  ],
  ads_manager: [
    "ads:read", "ads:write", "ads:delete",
    "analytics:read"
  ]
};

function hasPermission(role, requiredPermission) {
  if (!role || !ROLE_PERMISSIONS[role]) return false;
  const permissions = ROLE_PERMISSIONS[role];
  if (permissions.includes("*")) return true;
  return permissions.includes(requiredPermission);
}

// Token blacklist fallback. Redis is used when available so revocations survive restarts.
//
// SECURITY: this used to be a plain Set that only ever grew. Every logout added
// a full JWT string that was retained for the lifetime of the process, so the
// map was an unbounded memory leak (a slow DoS) and the raw tokens were held in
// memory indefinitely. It is now a TTL map keyed by a SHA-256 digest, so the
// secret token itself is never retained and entries expire on their own once the
// token could no longer be valid anyway.
const TOKEN_BLACKLIST_MAX_ENTRIES = 5000;
const tokenBlacklist = new Map(); // sha256(token) -> expiresAt (epoch ms)

function blacklistToken(token, expiresAtSeconds) {
  if (!token) return;
  const ttlMs = Math.max(0, (Number(expiresAtSeconds) || 0) * 1000 - Date.now());
  // Fall back to the JWT lifetime cap when no exp claim was supplied.
  const entryMs = ttlMs > 0 ? ttlMs : TOKEN_BLACKLIST_DEFAULT_TTL_MS;
  tokenBlacklist.set(hashTokenForLookup(token), Date.now() + entryMs);

  // Hard cap: drop the oldest entries first so an attacker cannot grow this
  // map without bound by cycling through logins.
  while (tokenBlacklist.size > TOKEN_BLACKLIST_MAX_ENTRIES) {
    const oldestKey = tokenBlacklist.keys().next().value;
    if (oldestKey === undefined) break;
    tokenBlacklist.delete(oldestKey);
  }
}

// Constant-time-safe membership test for the in-memory revocation list.
function isTokenBlacklisted(token) {
  const key = hashTokenForLookup(token);
  const expiresAt = tokenBlacklist.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    tokenBlacklist.delete(key);
    return false;
  }
  return true;
}

// Rate limiting for administrative login attempts (Brute-Force Protection)
const loginAttempts = new Map(); // key -> { count, firstAttempt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// SECURITY: every in-memory limiter below is keyed by something an unauthenticated
// client influences (an IP address, or an ip+username pair on the admin login).
// Entries were only ever removed when that exact key was seen again, so an
// attacker rotating source addresses - trivial with IPv6, where a single /64
// yields more addresses than could ever be enumerated - grew these Maps without
// bound until the process ran out of memory. That is a cheap remote DoS against
// the whole site, not just the limiter.
//
// Cap each map and sweep expired entries on a timer, evicting the oldest key
// first. Real users have only a handful of live keys at a time, so the caps are
// far above legitimate traffic and never change observable behaviour.
const LIMITER_MAX_KEYS = 10_000;

function enforceMapLimit(map) {
  while (map.size > LIMITER_MAX_KEYS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

// Drop entries whose time window has fully elapsed, then cap the size.
function sweepLimiterMaps() {
  const now = Date.now();

  for (const [key, record] of loginAttempts) {
    const windowExpired = now - record.firstAttempt > ATTEMPT_WINDOW_MS;
    const lockoutExpired = !record.lockedUntil || record.lockedUntil <= now;
    if (windowExpired && lockoutExpired) loginAttempts.delete(key);
  }

  for (const [key, stamps] of adEventAttempts) {
    const live = stamps.filter((t) => now - t < AD_EVENT_WINDOW_MS);
    if (live.length) adEventAttempts.set(key, live);
    else adEventAttempts.delete(key);
  }
  for (const [key, entry] of reportThrottle) {
    if (now - entry.windowStart > REPORT_WINDOW_MS) reportThrottle.delete(key);
  }
  for (const [key, item] of banCheckCache) {
    if (item.expiresAt <= now) banCheckCache.delete(key);
  }
  for (const [key, stamps] of rtcConfigAttempts) {
    const live = stamps.filter((t) => now - t < RTC_CONFIG_WINDOW_MS);
    if (live.length) rtcConfigAttempts.set(key, live);
    else rtcConfigAttempts.delete(key);
  }

  enforceMapLimit(loginAttempts);

  enforceMapLimit(adEventAttempts);
  enforceMapLimit(reportThrottle);
  enforceMapLimit(banCheckCache);
  enforceMapLimit(rtcConfigAttempts);
}

// SECURITY: the sweep runs on a timer rather than at module load. The maps it
// touches are declared further down this file, so calling it synchronously here
// would read them while they are still in the temporal dead zone. By the time
// the first tick fires the module has finished initialising.
const limiterSweepTimer = setInterval(sweepLimiterMaps, 60_000);
// Do not hold the event loop open on behalf of the sweeper.
if (typeof limiterSweepTimer.unref === "function") limiterSweepTimer.unref();



// Ad impression/click tracking is an unauthenticated write endpoint, so it is
// trivially scriptable. Without a limit, one client could inflate analytics or
// hammer Supabase/Redis at will. Same sliding-window shape as the contact
// limiter, with a far higher ceiling because a normal page fires a few events
// per ad rotation.
const adEventAttempts = new Map(); // ip -> [timestamps]
const AD_EVENT_LIMIT = 120;
const AD_EVENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function checkAdEventRate(ip) {
  const now = Date.now();
  const recent = (adEventAttempts.get(ip) || []).filter(
    (timestamp) => now - timestamp < AD_EVENT_WINDOW_MS
  );
  if (recent.length >= AD_EVENT_LIMIT) {
    return false;
  }
  recent.push(now);
  adEventAttempts.set(ip, recent);
  enforceMapLimit(adEventAttempts);
  return true;
}

// SECURITY: /api/rtc-config mints a fresh short-lived TURN credential on every
// call and was completely unauthenticated and unthrottled. TURN credentials
// legitimately cannot be secret - the browser needs them - so the control has to
// be volume, not secrecy: unlimited minting lets an attacker burn the relay's
// allocation quota, run up its bill, or use the relay as an open proxy. Cap the
// rate per client well above what a real page load needs (a page fetches this
// once, occasionally twice on reconnect).
const rtcConfigAttempts = new Map(); // ip -> [timestamps]
const RTC_CONFIG_LIMIT = 30;
const RTC_CONFIG_WINDOW_MS = 10 * 60 * 1000;

function checkRtcConfigRate(ip) {
  const now = Date.now();
  const recent = (rtcConfigAttempts.get(ip) || []).filter(
    (timestamp) => now - timestamp < RTC_CONFIG_WINDOW_MS
  );
  if (recent.length >= RTC_CONFIG_LIMIT) return false;
  recent.push(now);
  rtcConfigAttempts.set(ip, recent);
  enforceMapLimit(rtcConfigAttempts);
  return true;
}

// Short-lived ban lookup cache prevents reconnect storms from hammering
// Supabase every time a browser retries its WebSocket connection.
const banCheckCache = new Map(); // ip -> { banned, expiresAt }
// "Not banned" answers are cached longer (every ban/unban path in this server
// updates the cache immediately), so reconnects and Next do not wait on the
// database. "Banned" answers are re-checked sooner.
const BAN_CACHE_TTL_MS = 10 * 1000;
const NOT_BANNED_CACHE_TTL_MS = 2 * 60 * 1000;

function getCachedBan(ip) {
  const item = banCheckCache.get(ip);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    banCheckCache.delete(ip);
    return null;
  }
  return item.banned;
}

function cacheBanResult(ip, banned) {
  if (!ip) return;
  banCheckCache.set(ip, {
    banned: !!banned,
    expiresAt: Date.now() + (banned ? BAN_CACHE_TTL_MS : NOT_BANNED_CACHE_TTL_MS)
  });
  if (banCheckCache.size > 5000) banCheckCache.delete(banCheckCache.keys().next().value);
}

// A ban can target an IP address OR an anonymous browser id ("cid:<id>").
// IP bans are easy to dodge with a VPN; the browser-id ban follows the person
// across IP changes (until they clear their site data or use a new browser).
const CID_BAN_PATTERN = /^cid:[A-Za-z0-9_-]{8,64}$/;
function isValidBanKey(value) {
  const v = String(value || "").trim();
  return isIP(v) !== 0 || CID_BAN_PATTERN.test(v);
}

// Cached + bounded ban lookup for one key (IP or "cid:...").
async function checkBanKey(key) {
  let banned = getCachedBan(key);
  if (banned === null) {
    if (redis.isRedisConfigured()) {
      try {
        banned = await withTimeout(redis.isIpBannedFast(key), 900, "Redis ban check");
      } catch (_) {
        banned = false;
      }
    } else {
      try {
        banned = await withTimeout(supabase.isIpBanned(key), 900, "Supabase ban check");
      } catch (_) {
        banned = false;
      }
    }
  }
  cacheBanResult(key, !!banned);
  return !!banned;
}

// Remember which browser id was on the other end of a saved report, so that
// "Ban IP" on that report can also ban the browser. Memory only (bounded).
const reportedCidByReportId = new Map();
function rememberReportedCid(reportId, cid) {
  if (!reportId || !cid) return;
  reportedCidByReportId.set(String(reportId), cid);
  if (reportedCidByReportId.size > 1000) {
    reportedCidByReportId.delete(reportedCidByReportId.keys().next().value);
  }
}

function rateLimitKey(ip, username = "") {
  const normalizedUser = String(username || "").trim().toLowerCase().slice(0, 120);
  return `${ip}|${normalizedUser}`;
}

async function checkRateLimit(ip, username = "") {
  const key = rateLimitKey(ip, username);
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (record) {
    if (record.lockedUntil && now < record.lockedUntil) {
      const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      return { allowed: false, error: `Too many failed attempts. Locked for ${remainingSeconds}s.` };
    }
    if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
      loginAttempts.delete(key);
    } else if (record.count >= MAX_FAILED_ATTEMPTS) {
      record.lockedUntil = now + LOCKOUT_DURATION_MS;
      return { allowed: false, error: "Too many failed attempts. Account locked for 15 minutes." };
    }
  }

  if (redis.isRedisConfigured()) {
    try {
      const state = await withTimeout(
        redis.getRateLimitState(`admin-login:${crypto.createHash("sha256").update(key).digest("hex")}`),
        600,
        "Redis admin login rate-limit check"
      );
      if (state && state.count >= MAX_FAILED_ATTEMPTS && state.ttl > 0) {
        return { allowed: false, error: `Too many failed attempts. Locked for ${state.ttl}s.` };
      }
    } catch (_) {
      // Local limiter remains authoritative when Redis is unavailable/slow.
    }
  }

  return { allowed: true };
}

async function recordFailedLogin(ip, username = "") {
  const key = rateLimitKey(ip, username);
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, firstAttempt: now, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
  }
  loginAttempts.set(key, record);

  if (redis.isRedisConfigured()) {
    await redis.recordRateLimitFailure(`admin-login:${crypto.createHash("sha256").update(key).digest("hex")}`, Math.ceil(ATTEMPT_WINDOW_MS / 1000));
  }
}

async function resetLoginAttempts(ip, username = "") {
  const key = rateLimitKey(ip, username);
  loginAttempts.delete(key);
  if (redis.isRedisConfigured()) {
    await redis.resetRateLimit(`admin-login:${crypto.createHash("sha256").update(key).digest("hex")}`);
  }
}

// Only honour forwarding headers when we actually sit behind a proxy we
// control. If these headers were trusted unconditionally, any client could
// send a fake x-forwarded-for and walk straight around IP bans and the admin
// login lockout, because both are keyed on the resolved client IP.
//
// Auto-detected for the managed platforms that always terminate TLS in front
// of the app, and explicitly overridable with TRUST_PROXY.
const TRUST_PROXY = (() => {
  const configured = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  // Managed platforms where the proxy is the only possible path in.
  return Boolean(
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.FLY_APP_NAME ||
    process.env.HEROKU_APP_ID ||
    process.env.KOYEB_SERVICE_ID ||
    process.env.VERCEL ||
    process.env.DIGITALOCEAN_APP_ID ||
    process.env.ZEABUR_ENVIRONMENT
  );
})();

// Helper: Client IP detection with proxy support
function getClientIp(req) {
  const headers = req?.headers || {};

  // Forwarding headers are trusted when TRUST_PROXY is on, OR when the direct
  // peer is itself a loopback/private address. A peer on 127.0.0.1 or a private
  // network can only be a reverse proxy sitting in front of this app, never a
  // random internet visitor, so its headers are safe to read. Without this, a
  // TRUST_PROXY=false setting on a proxied host made every user look like
  // 127.0.0.1 (so "Ban IP" would have banned everyone at once).
  const directPeer = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/i, "");
  if (TRUST_PROXY || isPrivateOrLocalIp(directPeer)) {
    const candidates = [
      headers["x-vercel-forwarded-for"],
      headers["cf-connecting-ip"],
      headers["x-real-ip"],
      headers["x-forwarded-for"],
      headers["true-client-ip"]
    ];
    for (const raw of candidates) {
      if (!raw) continue;
      for (const part of String(raw).split(",")) {
        const normalized = part.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
        // Skip loopback/private values so we keep looking for the real client.
        if (normalized && isIP(normalized) && !isPrivateOrLocalIp(normalized)) return normalized;
      }
    }
  }

  // Direct connection, or an untrusted proxy header. Use the socket address,
  // which cannot be forged by the client.
  const remote = req?.socket?.remoteAddress || "unknown";
  return isIP(remote) ? remote : String(remote);
}

// Helper: JSON Body parser with size limit (DoS protection)
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB, measured in bytes

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    // SECURITY: reject an oversized Content-Length before reading a single byte.
    // The previous implementation only checked after each chunk had already been
    // concatenated into a growing string.
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      fail("Request body exceeds 1MB limit");
      return;
    }

    req.on("data", (chunk) => {
      // SECURITY: account for real bytes, not string length. A string length
      // check counts UTF-16 code units, so a body of multi-byte characters could
      // exceed the intended limit several times over.
      if (settled) return; // stop buffering immediately; the rest is discarded
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_JSON_BODY_BYTES) {
        // Reject without destroying the socket so the caller still receives a
        // real HTTP status. Buffering has already stopped, so the oversized
        // upload cannot grow server memory.
        fail("Request body exceeds 1MB limit");
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (err) => fail(err && err.message ? err.message : "Request stream error"));
  });
}

// Helper: Verify JWT token from Authorization header, revocation store, and session version.
async function verifyAdminToken(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || isTokenBlacklisted(token)) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_ISSUER
    });

    // SECURITY: revocation + session version are resolved together in a single
    // time-boxed step so this stays one round trip, not two.
    //
    // The session-version check is what makes a role change, a password reset or
    // an account deletion take effect immediately. It used to be written but
    // never enforced: bumpAdminSessionVersion() was called on all four of those
    // events while verifyAdminToken() only ever checked the token blacklist, so a
    // deleted or demoted-from-superadmin account kept full access until its token
    // expired (JWT_EXPIRY, 2h by default).
    //
    // It is deliberately fail-open on infrastructure errors and time-bounded: a
    // slow or reconnecting Redis must never make a legitimate admin look logged
    // out. The in-process map is the authority when Redis is unavailable, so
    // revocation still works on a single instance without Redis configured.
    const [revoked, currentVersion] = await Promise.race([
      Promise.all([
        redis.isAdminTokenRevoked(token).catch(() => false),
        redis.getAdminSessionVersion(decoded.id).catch(() => null)
      ]),
      new Promise((resolve) => setTimeout(() => resolve([false, null]), 1500))
    ]);

    if (revoked) return null;

    // Only enforce when the token carries a version claim. Tokens minted before
    // this change (and the env-backed root account) simply skip the check rather
    // than being invalidated, so upgrading the app never logs anyone out.
    if (
      decoded.sv !== undefined &&
      currentVersion !== null &&
      Number(decoded.sv) !== Number(currentVersion)
    ) {
      return null;
    }

    return { ...decoded, token };
  } catch (err) {
    return null;
  }
}

// Helper: Sanitize external URLs against XSS / protocol manipulation
function sanitizeUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return "";
  const trimmed = urlString.trim();
  if (!trimmed) return "";

  // SECURITY: control characters (including the tab/newline forms browsers strip
  // before parsing) are never legitimate in an ad URL and can be used to smuggle
  // a scheme past a naive prefix check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "";

  // SECURITY: browsers normalise a backslash to a forward slash when resolving a
  // URL, so "/\evil.com" and "https://\evil.com" both leave the site even though
  // they do not start with "//" and so slipped past the check below. Reject any
  // backslash outright rather than trying to normalise it.
  if (trimmed.includes("\\")) return "";

  // Only same-origin paths and explicit http(s) absolute URLs are allowed.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "";
}

// Same policy as sanitizeUrl, for values that are already stored and rendered in
// the browser. Applied before assigning to an href so a legacy stored value
// cannot become an open redirect.
function isSafeExternalUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (candidate.includes("\\")) return false;
  return /^https?:\/\//i.test(candidate);
}

// Helper: Validate MIME types for uploaded media (Strict file validation)
const ALLOWED_UPLOAD_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm"
]);

const ALLOWED_UPLOAD_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".mp4", ".webm"
]);

// Track system start time for uptime & performance monitoring
const SERVER_START_TIME = Date.now();
let eventLoopLag = 0;
setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    eventLoopLag = Math.round((performance.now() - start) * 100) / 100;
  });
}, 2000);

// Maintenance mode & website updates announcement state
let activeAnnouncement = null;
const announcementHistory = [];

// ==================================================
// HTTP SERVER & ADMIN API
// ==================================================

const server = http.createServer(async (req, res) => {
  let requestPath = req.url.split("?")[0];

  // Shared security headers for every HTTP response.
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isHttps = req.socket.encrypted || forwardedProto === "https";
  const isAdminRequest = Boolean(ADMIN_ROUTE && (requestPath === ADMIN_ROUTE || requestPath.startsWith(`${ADMIN_ROUTE}/`) || requestPath.startsWith("/api/admin/")));

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("Cache-Control", isAdminRequest ? "no-store" : "no-cache");

  // Clickjacking defence. The admin dashboard must never be rendered inside a
  // frame on another site, otherwise an attacker can overlay invisible buttons
  // and trick an admin into clicking them. The public site only needs the
  // legacy header for older browsers; the CSP below is the real control.
  res.setHeader("X-Frame-Options", isAdminRequest ? "DENY" : "SAMEORIGIN");

  if (isHttps) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  const supabaseOrigin = (() => {
    try {
      return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : "";
    } catch (_) {
      return "";
    }
  })();

  const adminConnectSrc = ["'self'", supabaseOrigin].filter(Boolean).join(" ");

  // SECURITY: a fresh, unpredictable nonce per admin response. It is placed in
  // the CSP header AND injected into the dashboard's single inline <script>, so
  // the browser runs exactly that script and refuses any other inline script.
  const adminNonce = crypto.randomBytes(16).toString("base64");
  const adminCsp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // The admin dashboard is never legitimate inside a frame. The previous
    // value "https: http:" allowed ANY site to frame it (clickjacking).
    "frame-ancestors 'none'",
    "form-action 'self'",
    // SECURITY: 'unsafe-inline' has been REMOVED from script-src. The dashboard
    // is authorised by a fresh per-request nonce injected into its single
    // inline <script> block; 'strict-dynamic' lets that one trusted script pull
    // in the SRI-pinned D3 bundle and refuses everything else, including any
    // injected <script>. Previously CSP offered no defence at all here, so a
    // single XSS bug in the admin panel would have executed unchecked.
    `script-src 'nonce-${adminNonce}' 'strict-dynamic' https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js`,
    // style-src deliberately KEEPS 'unsafe-inline': the dashboard ships a large
    // inline <style> block plus many element.style writes. CSS injection is a
    // materially smaller risk class than script execution, and scripts are the
    // boundary this policy exists to enforce.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    `connect-src ${adminConnectSrc}`,
    "worker-src 'self' blob:"
  ].join("; ");

  const publicCsp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:"
  ].join("; ");

  res.setHeader("Content-Security-Policy", isAdminRequest ? adminCsp : publicCsp);

  // Helper for JSON responses with security headers
  const sendJson = (status, obj) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(obj));
  };

  // --------------------------------------------------
  // ADMIN DASHBOARD HTML & AUTH
  // --------------------------------------------------

  // Only hide /admin if a custom private route was explicitly configured
  if (ADMIN_ROUTE !== "/admin" && (requestPath === "/admin" || requestPath === "/admin/" || requestPath === "/admin/index.html")) {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });
    res.end("Not found");
    return;
  }

  // Private admin dashboard route. The actual path comes only from ADMIN_PATH.
  if (ADMIN_ROUTE && (requestPath === ADMIN_ROUTE || requestPath === `${ADMIN_ROUTE}/` || requestPath === `${ADMIN_ROUTE}/index.html`)) {
    const adminHtmlPath = path.join(adminDir, "index.html");
    fs.readFile(adminHtmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error loading admin dashboard");
      }
      // SECURITY: inject the per-request nonce into the dashboard's single
      // inline <script> block so it matches the script-src 'nonce-...' in the
      // CSP header above. Without this the browser would refuse the dashboard's
      // own script once 'unsafe-inline' is gone.
      // SECURITY: BOTH script tags in the dashboard need the nonce, not just
      // the inline one. The CSP uses 'strict-dynamic', and under CSP3 that makes
      // browsers IGNORE host-source allowlists such as the jsdelivr entry - only
      // nonce- or hash-authorised scripts execute. An earlier version of this
      // nonced only the inline script, so the browser blocked the pinned D3
      // bundle and the analytics chart failed with "d3 is not defined".
      // SRI's integrity attribute does NOT satisfy script-src; it is a separate
      // mechanism, so the nonce is the only thing authorising this tag.
      const html = String(data)
        .replace(
          /<script>(\s*const TOKEN_KEY)/,
          `<script nonce="${adminNonce}">$1`
        )
        .replace(
          /(<script)(\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/d3@)/,
          `<script nonce="${adminNonce}"$2`
        );
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });
      res.end(html);
    });
    return;
  }

  // Serve the private admin's small static assets under the same private route.
  if (ADMIN_ROUTE && requestPath.startsWith(`${ADMIN_ROUTE}/`)) {
    const relativeAdminPath = requestPath.slice(`${ADMIN_ROUTE}/`.length);
    const safeAdminName = path.basename(relativeAdminPath);

    if (relativeAdminPath && safeAdminName === relativeAdminPath) {
      const adminFilePath = path.join(adminDir, safeAdminName);
      fs.readFile(adminFilePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end("Not found");
        }

        const ext = path.extname(adminFilePath).toLowerCase();
        const contentTypes = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8"
        };

        res.writeHead(200, {
          "Content-Type": contentTypes[ext] || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store"
        });
        res.end(data);
      });
      return;
    }
  }

  // Admin Login with JWT issuance and Brute-Force lockout protection
  if (requestPath === "/api/admin/login" && req.method === "POST") {
    const clientIp = getClientIp(req);

    try {
      const { username: rawUsername, password } = await parseJsonBody(req);
      const username = String(rawUsername || "").trim();
      const rateCheck = await checkRateLimit(clientIp, username);
      if (!rateCheck.allowed) {
        return sendJson(429, { error: rateCheck.error });
      }

      if (!username || !password) {
        return sendJson(400, { error: "Username and password required" });
      }

      // Check database admins first, but never let a slow Supabase request
      // make the admin login hang. If the database is temporarily unavailable,
      // the configured environment-backed root account remains usable.
      let dbAdmin = null;
      try {
        dbAdmin = await withTimeout(
          supabase.getAdminByUsername(username),
          2500,
          "Supabase admin lookup"
        );
      } catch (lookupError) {
        console.warn("[ADMIN] Admin lookup unavailable/slow:", lookupError?.message || lookupError);
      }
      let isValidUser = false;
      let userRole = "admin";
      let adminId = "admin-root";
      let email = "admin@lela.chat";

      if (dbAdmin && dbAdmin.is_active !== false) {
        adminId = dbAdmin.id;
        userRole = dbAdmin.role || "admin";
        email = dbAdmin.email || `${username}@lela.chat`;

        if (dbAdmin.password_hash) {
          isValidUser = bcrypt.compareSync(password, dbAdmin.password_hash);
        } else if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && ENV_ADMIN_PASSWORD_HASH) {
          isValidUser = bcrypt.compareSync(password, ENV_ADMIN_PASSWORD_HASH);
        }
      } else if (!dbAdmin && username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && ENV_ADMIN_PASSWORD_HASH) {
        isValidUser = bcrypt.compareSync(password, ENV_ADMIN_PASSWORD_HASH);
        userRole = "superadmin";
      }

      if (isValidUser) {
        // Clear brute-force state without making the user wait on an external
        // Redis round-trip when Redis is slow.
        resetLoginAttempts(clientIp, username).catch(() => {});

        // Sign cryptographically verified JWT token.
        // SECURITY: sv pins the token to the account's current session version so
        // a later role change, password reset or deletion invalidates it at once
        // instead of leaving a revoked account usable until the token expires.
        const sessionVersion = await redis.getAdminSessionVersion(adminId).catch(() => null);
        const token = jwt.sign(
          {
            id: adminId,
            username,
            email,
            role: userRole,
            permissions: ROLE_PERMISSIONS[userRole] || [],
            ...(sessionVersion !== null ? { sv: Number(sessionVersion) } : {})
          },
          JWT_SECRET,
          {
            expiresIn: JWT_EXPIRY,
            algorithm: "HS256",
            issuer: JWT_ISSUER,
            audience: JWT_ISSUER
          }
        );

        // Audit logging must never block an otherwise valid login.
        supabase.logAction("ADMIN_LOGIN", { username, role: userRole, ip: clientIp }, adminId, clientIp).catch((logError) => {
          console.warn("[ADMIN] Login audit log failed:", logError.message);
        });

        return sendJson(200, {
          success: true,
          token,
          user: {
            id: adminId,
            username,
            email,
            role: userRole,
            permissions: ROLE_PERMISSIONS[userRole] || []
          }
        });
      }

      await recordFailedLogin(clientIp, username);
      return sendJson(401, { error: "Invalid username or password credentials" });
    } catch (e) {
      // SECURITY: this used to return e.message verbatim. parseJsonBody produces
      // safe, fixed strings, but any other throw here (a driver error, a
      // misconfigured Supabase client) would leak internals about the server to
      // an unauthenticated caller. Log the detail, return a generic message.
      console.warn("[ADMIN] Login request error:", e && e.message ? e.message : e);
      return sendJson(400, { error: "Invalid login request" });
    }
  }

  // Admin Logout (Invalidates JWT Session)
  if (requestPath === "/api/admin/logout" && req.method === "POST") {
    const admin = await verifyAdminToken(req);
    if (admin && admin.token) {
      blacklistToken(admin.token, admin.exp);
      await redis.revokeAdminToken(admin.token, admin.exp);
      await supabase.logAction("ADMIN_LOGOUT", { username: admin.username }, admin.id, getClientIp(req));
    }
    return sendJson(200, { success: true, message: "Logged out successfully" });
  }

  // Admin Heartbeat for session liveness
  if (requestPath === "/api/admin/heartbeat" && req.method === "POST") {
    const admin = await verifyAdminToken(req);
    if (!admin) return sendJson(401, { error: "Session expired" });
    return sendJson(200, { status: "active", user: admin });
  }

  // --------------------------------------------------
  // PROTECTED ADMIN API ROUTES (RBAC & JWT GUARD)
  // --------------------------------------------------

  if (requestPath.startsWith("/api/admin/")) {
    const admin = await verifyAdminToken(req);
    if (!admin) {
      return sendJson(401, { error: "Unauthorized. Valid JWT token required." });
    }

    // GET /api/admin/me - Current Admin Profile
    if (requestPath === "/api/admin/me" && req.method === "GET") {
      return sendJson(200, { user: admin });
    }

    // GET /api/admin/stats - Overview Statistics
    if (requestPath === "/api/admin/stats" && req.method === "GET") {
      // SECURITY: this endpoint sits inside the authenticated block but was
      // missing a role check, so the lowest-privilege "moderator" role could
      // read the full operational overview. It aggregates moderation, ad and
      // analytics data, so it requires the analytics permission.
      if (!hasPermission(admin.role, "analytics:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      let activePairs = 0;
      const uniqueIps = new Set();
      for (const client of connectedClients) {
        if (client.peer) activePairs++;
        if (client.ip) uniqueIps.add(client.ip);
      }
      activePairs = Math.floor(activePairs / 2);

      const allReports = await supabase.getReports();
      const allBans = await supabase.getBans();
      const allAds = await supabase.getAds();
      const engagement = redis.getEngagementMetrics();

      const totalImpressions = allAds.reduce((acc, a) => acc + (Number(a.impressions) || 0), 0);
      const totalClicks = allAds.reduce((acc, a) => acc + (Number(a.clicks) || 0), 0);
      const overallCtr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + "%" : "0.00%";

      return sendJson(200, {
        onlineCount: getOnlineCount(),
        totalConnections: connectedClients.size,
        waitingCount: waitingClients.length,
        activePairsCount: activePairs,
        totalReports: allReports.length,
        pendingReports: allReports.filter(r => r.status === "pending").length,
        totalBans: allBans.length,
        totalAds: allAds.length,
        liveAds: allAds.filter(a => a.active).length,
        adImpressions: totalImpressions,
        adClicks: totalClicks,
        adCtr: overallCtr,
        engagementMetrics: engagement,
        redisConnected: redis.isRedisConfigured(),
        supabaseConnected: supabase.isSupabaseConfigured()
      });
    }

    // GET /api/admin/analytics/performance - Real-Time System Performance
    if (requestPath === "/api/admin/analytics/performance" && req.method === "GET") {
      // SECURITY: same missing-authorization gap as /api/admin/stats. This one
      // discloses process memory, CPU time, uptime and the exact Node version,
      // which is useful reconnaissance, so it requires analytics:read.
      if (!hasPermission(admin.role, "analytics:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);

      return sendJson(200, {
        uptimeSeconds,
        uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
        memory: {
          rssMb: Math.round(memory.rss / (1024 * 1024)),
          heapTotalMb: Math.round(memory.heapTotal / (1024 * 1024)),
          heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
          externalMb: Math.round(memory.external / (1024 * 1024))
        },
        cpu: {
          userMs: Math.round(cpu.user / 1000),
          systemMs: Math.round(cpu.system / 1000)
        },
        eventLoopLagMs: eventLoopLag,
        connections: {
          webSocketCount: connectedClients.size,
          waitingQueue: waitingClients.length
        },
        nodeVersion: process.version
      });
    }

    // GET /api/admin/analytics/engagement - Real Supabase ad analytics
    if ((requestPath === "/api/admin/analytics/engagement" || requestPath === "/api/admin/analytics/trends") && req.method === "GET") {
      if (!hasPermission(admin.role, "analytics:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }

      const ads = await supabase.getAds();
      const engagement = redis.getEngagementMetrics();
      const analytics = await supabase.getAdAnalytics30d(30);
      const totalImpressions = ads.reduce((sum, a) => sum + (Number(a.impressions) || 0), 0);
      const totalClicks = ads.reduce((sum, a) => sum + (Number(a.clicks) || 0), 0);
      const trends = analytics.trends30Days || [];
      const totalImpressions30d = trends.reduce((sum, d) => sum + (Number(d.dailyImpressions) || 0), 0);
      const totalClicks30d = trends.reduce((sum, d) => sum + (Number(d.dailyClicks) || 0), 0);

      return sendJson(200, {
        engagement,
        totalConfiguredAds: ads.length,
        totalImpressions,
        totalClicks,
        totalImpressions30d,
        totalClicks30d,
        overallCtr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + "%" : "0.00%",
        trends30Days: trends,
        topPerformingAds: ads
          .slice()
          .sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))
          .slice(0, 5)
          .map(a => ({
            id: a.id,
            title: a.title,
            impressions: Number(a.impressions) || 0,
            clicks: Number(a.clicks) || 0,
            ctr: Number(a.impressions) > 0 ? ((Number(a.clicks || 0) / Number(a.impressions)) * 100).toFixed(2) + "%" : "0.00%"
          }))
      });
    }

    // ==================================================
    // ADS MANAGEMENT (RBAC: requires ads:read / ads:write)
    // ==================================================

    // GET /api/admin/ads/settings - Retrieve global ad settings
    if (requestPath === "/api/admin/ads/settings" && req.method === "GET") {
      if (!hasPermission(admin.role, "ads:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to view ad settings." });
      }
      const settings = await supabase.getAdSettings();
      return sendJson(200, { settings });
    }

    // PUT /api/admin/ads/settings - Update global ad settings
    if (requestPath === "/api/admin/ads/settings" && req.method === "PUT") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to update ad settings." });
      }
      const body = await parseJsonBody(req);
      const updates = {};
      if (body.enabled !== undefined) updates.enabled = !!body.enabled;
      if (body.defaultPlacement !== undefined) updates.defaultPlacement = body.defaultPlacement;
      if (body.mobileDockStranger !== undefined) updates.mobileDockStranger = !!body.mobileDockStranger;
      if (body.rotationSeconds !== undefined) updates.rotationSeconds = Math.max(3, parseInt(body.rotationSeconds) || 12);
      if (body.allowDismiss !== undefined) updates.allowDismiss = !!body.allowDismiss;
      if (body.redisplayOnRotate !== undefined) updates.redisplayOnRotate = !!body.redisplayOnRotate;

      const updatedSettings = await supabase.updateAdSettings(updates);
      await supabase.logAction("AD_SETTINGS_UPDATE", { updates }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, settings: updatedSettings });
    }

    // GET /api/admin/ads - List all ads with metrics
    if (requestPath === "/api/admin/ads" && req.method === "GET") {
      if (!hasPermission(admin.role, "ads:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to view ads." });
      }
      const adsList = await supabase.getAds();
      const settings = await supabase.getAdSettings();
      return sendJson(200, { ads: adsList, settings });
    }

    // POST /api/admin/ads/upload-url - Create a short-lived direct upload URL
    if (requestPath === "/api/admin/ads/upload-url" && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to upload ads." });
      }
      try {
        const body = await parseJsonBody(req);
        const originalName = String(body.filename || "").trim();
        const mimeType = String(body.mimeType || "").trim().toLowerCase();
        const size = Number(body.size || 0);
        if (!originalName || !ALLOWED_UPLOAD_MIMES.has(mimeType)) {
          return sendJson(400, { error: "Unsupported media type." });
        }
        if (!Number.isFinite(size) || size <= 0 || size > 20 * 1024 * 1024) {
          return sendJson(400, { error: "Ad media must be 20 MB or smaller." });
        }
        const signed = await supabase.createSignedAdUpload(originalName, mimeType);
        if (!signed) return sendJson(503, { error: "Supabase Storage is unavailable." });
        return sendJson(200, signed);
      } catch (error) {
        console.error("[ADS] signed upload error:", error?.message || error);
        return sendJson(503, { error: "Could not prepare the ad upload. Check the Supabase Storage bucket and server key configuration." });
      }
    }

    // POST /api/admin/ads - Create New Ad from a Supabase-hosted media URL
    if (requestPath === "/api/admin/ads" && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to create ads." });
      }
      try {
        const body = await parseJsonBody(req);
        const title = String(body.title || "").trim().slice(0, 90);
        const link_url = sanitizeUrl(body.link_url);
        const media_url = sanitizeUrl(body.media_url);
        const media_path = String(body.media_path || "").trim().slice(0, 300);
        const media_type = body.media_type === "video" ? "video" : "image";
        const placement = ["stranger-overlay", "below-video", "corner"].includes(body.placement) ? body.placement : "stranger-overlay";
        const active = body.active !== false;

        if (!title) return sendJson(400, { error: "Campaign name is required." });
        if (!media_url || !media_path) return sendJson(400, { error: "A Supabase-hosted media file is required." });

        const bucket = process.env.SUPABASE_ADS_BUCKET || "ad-media";
        const expectedPrefix = `${String(process.env.SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/`;
        if (!expectedPrefix || !media_url.startsWith(expectedPrefix) || !media_path.startsWith("ads/")) {
          return sendJson(400, { error: "Media must be uploaded through Supabase Storage." });
        }

        const newAd = await supabase.addAd({
          title,
          body: "",
          cta_text: "Learn more ↗",
          device_target: "all",
          media_url,
          media_path,
          media_type,
          link_url,
          placement,
          rotation_seconds: 12,
          priority: 5,
          active,
          created_by: admin.username
        });

        await supabase.logAction("AD_CREATE", { id: newAd.id, title }, admin.id, getClientIp(req));
        return sendJson(201, { success: true, ad: newAd });
      } catch (error) {
        console.error("[ADS] create error:", error.message);
        return sendJson(500, { error: "Could not create the ad campaign." });
      }
    }

    // PUT /api/admin/ads/:id/status - Toggle Ad Status
    const adStatusMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/status$/);
    if (adStatusMatch && req.method === "PUT") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to modify ads." });
      }
      const adId = adStatusMatch[1];
      const { active } = await parseJsonBody(req);
      const updated = await supabase.updateAdStatus(adId, !!active);
      if (!updated) return sendJson(404, { error: "Ad not found" });

      await supabase.logAction("AD_STATUS_CHANGE", { adId, active: !!active }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ad: updated });
    }

    // PUT /api/admin/ads/:id - Full Ad Customization & Update
    const adUpdateMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)$/);
    if (adUpdateMatch && req.method === "PUT") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to modify ads." });
      }
      const adId = adUpdateMatch[1];
      const existingAd = await supabase.getAdById(adId);
      if (!existingAd) return sendJson(404, { error: "Ad not found" });

      const body = await parseJsonBody(req);
      const updates = {};
      if (body.title !== undefined) updates.title = String(body.title).trim().slice(0, 90) || "Untitled Campaign";
      if (body.link_url !== undefined) updates.link_url = sanitizeUrl(body.link_url);
      if (body.media_url !== undefined) {
        const nextMediaUrl = sanitizeUrl(body.media_url);
        // SECURITY: POST /api/admin/ads requires media to live in the configured
        // Supabase Storage bucket, but the update path only called sanitizeUrl,
        // which accepts any https:// host. An ads_manager (ads:write, no
        // superadmin) could therefore repoint live ad creative at an arbitrary
        // third-party host, which every visitor's browser then loads - leaking
        // their IP and user agent to that host and defeating the control the
        // create path enforces. Apply the same allowlist here. An unchanged URL
        // is always accepted so legacy rows keep working.
        if (nextMediaUrl && nextMediaUrl !== existingAd.media_url) {
          const bucket = process.env.SUPABASE_ADS_BUCKET || "ad-media";
          const expectedPrefix = `${String(process.env.SUPABASE_URL || "").replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/`;
          if (!expectedPrefix || !nextMediaUrl.startsWith(expectedPrefix)) {
            return sendJson(400, { error: "Media must be uploaded through Supabase Storage." });
          }
        }
        updates.media_url = nextMediaUrl;
        updates.media_type = nextMediaUrl.match(/\.(mp4|webm|ogg)$/i) ? "video" : "image";
      }
      if (body.placement !== undefined) updates.placement = body.placement;
      if (body.rotation_seconds !== undefined) updates.rotation_seconds = Math.max(3, parseInt(body.rotation_seconds) || 12);
      if (body.priority !== undefined) updates.priority = parseInt(body.priority) || 1;
      if (body.active !== undefined) updates.active = !!body.active;
      if (body.body !== undefined) updates.body = String(body.body).trim();
      if (body.cta_text !== undefined) updates.cta_text = String(body.cta_text).trim().slice(0, 30);
      if (body.device_target !== undefined) updates.device_target = body.device_target;

      const updated = await supabase.updateAd(adId, updates);
      await supabase.logAction("AD_UPDATE", { adId, updates }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ad: updated });
    }

    // POST /api/admin/ads/:id/reset - Reset Impression & Click Counters
    const adResetMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/reset$/);
    if (adResetMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const adId = adResetMatch[1];
      const updated = await supabase.updateAd(adId, { impressions: 0, clicks: 0 });
      if (!updated) return sendJson(404, { error: "Ad not found" });
      await supabase.logAction("AD_RESET_STATS", { adId }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ad: updated });
    }

    // POST /api/admin/ads/:id/duplicate - Duplicate Ad Campaign
    const adDupMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/duplicate$/);
    if (adDupMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const adId = adDupMatch[1];
      const source = await supabase.getAdById(adId);
      if (!source) return sendJson(404, { error: "Ad not found" });

      const cloned = await supabase.addAd({
        title: `${source.title} (Copy)`,
        media_url: source.media_url,
        media_type: source.media_type,
        link_url: source.link_url,
        placement: source.placement,
        device_target: source.device_target || "all",
        rotation_seconds: source.rotation_seconds,
        priority: source.priority,
        body: source.body || "",
        cta_text: source.cta_text || "Learn more ↗",
        media_path: source.media_path || null,
        active: false,
        created_by: admin.username
      });
      await supabase.logAction("AD_DUPLICATE", { originalId: adId, newId: cloned.id }, admin.id, getClientIp(req));
      return sendJson(201, { success: true, ad: cloned });
    }

    // DELETE /api/admin/ads/:id - Delete Ad
    const adDeleteMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)$/);
    if (adDeleteMatch && req.method === "DELETE") {
      if (!hasPermission(admin.role, "ads:delete")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to delete ads." });
      }
      const adId = adDeleteMatch[1];
      const ad = await supabase.getAdById(adId);
      if (!ad) return sendJson(404, { error: "Ad not found" });
      await supabase.deleteAd(adId);
      if (ad.media_path) {
        await supabase.deleteAdMediaIfUnused(ad.media_path, adId);
      }
      await supabase.logAction("AD_DELETE", { adId, title: ad.title }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: "Ad deleted" });
    }

    // ==================================================
    // MODERATION & CONNECTIONS (RBAC: clients & reports)
    // ==================================================

    // GET /api/admin/connections - List active connections
    if (requestPath === "/api/admin/connections" && req.method === "GET") {
      if (!hasPermission(admin.role, "clients:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const list = [];
      for (const client of connectedClients) {
        list.push({
          id: client.id,
          ip: client.ip || "unknown",
          isReady: !!client.ready,
          isMatched: !!client.peer,
          peerId: client.peer ? client.peer.id : null,
          connectedAt: client.connectedAt,
          location: null
        });
      }
      list.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));

      // Resolve locations for each distinct IP (cached; first views may take a moment).
      const distinctIps = [...new Set(list.map((c) => c.ip))].slice(0, 60);
      const locations = new Map();
      await Promise.all(distinctIps.map(async (ip) => {
        locations.set(ip, await lookupGeo(ip));
      }));
      for (const entry of list) entry.location = locations.get(entry.ip) || "—";

      return sendJson(200, {
        onlineCount: getOnlineCount(),
        totalConnections: list.length,
        clients: list,
        // How the server sees THIS admin request. Helps diagnose proxy / IP issues.
        connectionDebug: {
          detectedIp: getClientIp(req),
          trustProxy: TRUST_PROXY,
          directPeer: String(req.socket?.remoteAddress || "unknown"),
          headers: {
            "x-forwarded-for": String(req.headers["x-forwarded-for"] || ""),
            "x-real-ip": String(req.headers["x-real-ip"] || ""),
            "cf-connecting-ip": String(req.headers["cf-connecting-ip"] || ""),
            "true-client-ip": String(req.headers["true-client-ip"] || "")
          }
        }
      });
    }

    // GET /api/admin/reports - List Reports
    if (requestPath === "/api/admin/reports" && req.method === "GET") {
      if (!hasPermission(admin.role, "reports:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const reports = await supabase.getReports({ limit: 500 });
      const ipAggregates = new Map();
      for (const report of reports) {
        const ip = String(report.reported_ip || "unknown");
        if (ip === "unknown") continue;
        let agg = ipAggregates.get(ip);
        if (!agg) agg = { reportCount: 0, reporters: new Set() };
        agg.reportCount += Number(report.report_count || 1);
        const reporterIps = Array.isArray(report.reporter_ips) ? report.reporter_ips : [];
        for (const reporterIp of reporterIps) {
          if (reporterIp && reporterIp !== "unknown") agg.reporters.add(String(reporterIp));
        }
        if (reporterIps.length === 0 && report.reporter_ip && report.reporter_ip !== "unknown") agg.reporters.add(String(report.reporter_ip));
        ipAggregates.set(ip, agg);
      }
      const enrichedReports = reports.map((report) => {
        const agg = ipAggregates.get(String(report.reported_ip || "unknown"));
        return {
          ...report,
          report_to_ip: String(report.reported_ip || "unknown"),
          ip_report_count: Number(report.ip_report_count || (agg ? agg.reportCount : report.report_count || 1)),
          ip_unique_reporters_count: Number(report.ip_unique_reporters_count || (agg ? agg.reporters.size : report.unique_reporters_count || 1))
        };
      });
      return sendJson(200, { reports: enrichedReports });
    }

    // POST /api/admin/reports/:id/status - Update Report Status
    const reportStatusMatch = requestPath.match(/^\/api\/admin\/reports\/([^/]+)\/status$/);
    if (reportStatusMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "reports:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const reportId = reportStatusMatch[1];
      const { status, notes } = await parseJsonBody(req);
      const updated = await supabase.updateReportStatus(reportId, status, notes);
      await supabase.logAction("REPORT_RESOLVE", { reportId, status }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, report: updated });
    }

    // GET /api/admin/bans - List Bans
    if (requestPath === "/api/admin/bans" && req.method === "GET") {
      if (!hasPermission(admin.role, "bans:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const bans = await supabase.getBans();
      return sendJson(200, { bans });
    }

    // POST /api/admin/reports/:id/ban - Atomic moderation action
    const reportBanMatch = requestPath.match(/^\/api\/admin\/reports\/([^/]+)\/ban$/);
    if (reportBanMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "bans:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to ban IPs." });
      }
      const reportId = reportBanMatch[1];
      const report = await supabase.getReportById(reportId);
      if (!report) return sendJson(404, { error: "Report not found" });
      const ip = String(report.reported_ip || "").trim();
      if (!ip || ip === "unknown" || !isIP(ip)) return sendJson(400, { error: "Report does not contain a valid IP address." });
      const reason = String(report.reason || "Violation report").slice(0, 200);
      await supabase.addBan({ ip, reason: `Violation report: ${reason}`, bannedBy: admin.username });
      await redis.addBannedIp(ip);
      cacheBanResult(ip, true);

      // Also ban the reported person's browser, so switching IP (VPN) does not
      // get them back in. Only possible when the server still remembers it.
      const reportedCid = reportedCidByReportId.get(String(reportId)) || null;
      if (reportedCid) {
        const cidKey = `cid:${reportedCid}`;
        await supabase.addBan({ ip: cidKey, reason: `Violation report: ${reason}`, bannedBy: admin.username });
        await redis.addBannedIp(cidKey);
        cacheBanResult(cidKey, true);
      }
      await supabase.markReportsBannedByIp(ip, `Banned by ${admin.username}: ${reason}`);

      for (const client of connectedClients) {
        if (client.ip === ip || (reportedCid && client.cid === reportedCid)) {
          const peer = client.peer;
          send(client, { type: "banned", reason: reason || "Suspended by moderator." });
          if (peer) {
            peer.peer = null;
            send(peer, { type: "peer-disconnected" });
            if (peer.ready) putInWaitingQueue(peer);
          }
          client.peer = null;
          client.ready = false;
          removeFromWaiting(client);
          try { client.close(); } catch (_) {}
        }
      }
      await supabase.logAction("BAN_IP_FROM_REPORT", { reportId, ip, reason }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ip, reportId, message: `IP ${ip} banned and related reports marked banned.` });
    }

    // POST /api/admin/ban - Ban IP
    if (requestPath === "/api/admin/ban" && req.method === "POST") {
      if (!hasPermission(admin.role, "bans:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to ban IPs." });
      }
      const { ip, reason, durationHours } = await parseJsonBody(req);
      if (!ip || !isIP(String(ip).trim())) return sendJson(400, { error: "A valid IP address is required" });
      const cleanIp = String(ip).trim();

      await supabase.addBan({ ip: cleanIp, reason, bannedBy: admin.username, durationHours });
      await redis.addBannedIp(cleanIp);
      cacheBanResult(cleanIp, true);
      await supabase.markReportsBannedByIp(cleanIp, `Manual ban by ${admin.username}`);

      // Disconnect any active sockets matching this banned IP
      for (const client of connectedClients) {
        if (client.ip === cleanIp) {
          send(client, { type: "banned", reason: reason || "Suspended by moderator." });
          if (client.peer) {
            send(client.peer, { type: "peer-disconnected" });
            client.peer.peer = null;
            if (client.peer.ready) putInWaitingQueue(client.peer);
          }
          client.peer = null;
          client.ready = false;
          removeFromWaiting(client);
          try { client.close(); } catch (e) {}
        }
      }

      await supabase.logAction("BAN_IP", { ip, reason, bannedBy: admin.username }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `IP ${cleanIp} banned successfully` });
    }

    // POST /api/admin/unban - Unban IP
    if (requestPath === "/api/admin/unban" && req.method === "POST") {
      if (!hasPermission(admin.role, "bans:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to unban IPs." });
      }
      const { ip } = await parseJsonBody(req);
      if (!ip || !isValidBanKey(ip)) return sendJson(400, { error: "A valid IP address is required" });
      const cleanIp = String(ip).trim();

      await supabase.removeBan(cleanIp);
      await redis.removeBannedIp(cleanIp);
      cacheBanResult(cleanIp, false);
      await supabase.logAction("UNBAN_IP", { ip }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `IP ${ip} unbanned` });
    }

    // POST /api/admin/reports/:id/delete - Permanently delete reports
    // Removes every report filed against that report's target IP, so nothing
    // keeps stacking up in the (free) database.
    const reportDeleteMatch = requestPath.match(/^\/api\/admin\/reports\/([^/]+)\/delete$/);
    if (reportDeleteMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "reports:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const reportId = reportDeleteMatch[1];
      const report = await supabase.getReportById(reportId);
      if (!report) return sendJson(404, { error: "Report not found" });
      const targetIp = String(report.reported_ip || "").trim();
      let deleted = 0;
      if (targetIp && targetIp !== "unknown") {
        deleted = await supabase.deleteReportsByIp(targetIp);
      } else {
        deleted = await supabase.deleteReportById(reportId);
      }
      return sendJson(200, { success: true, deleted, message: `${deleted} report(s) deleted.` });
    }

    // POST /api/admin/bans/delete - Permanently delete a banned IP
    // Lifts the ban AND erases its reports and its audit-log entries. This
    // action intentionally writes no new audit-log row of its own.
    if (requestPath === "/api/admin/bans/delete" && req.method === "POST") {
      if (!hasPermission(admin.role, "bans:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const { ip } = await parseJsonBody(req);
      if (!ip || !isValidBanKey(ip)) return sendJson(400, { error: "A valid IP address is required" });
      const cleanIp = String(ip).trim();

      await supabase.removeBan(cleanIp);
      await redis.removeBannedIp(cleanIp);
      cacheBanResult(cleanIp, false);
      const reportsDeleted = await supabase.deleteReportsByIp(cleanIp);
      const logsDeleted = await supabase.deleteLogsByIp(cleanIp);
      return sendJson(200, {
        success: true,
        reportsDeleted,
        logsDeleted,
        message: `IP ${cleanIp} deleted (${reportsDeleted} report(s), ${logsDeleted} log entr${logsDeleted === 1 ? "y" : "ies"}).`
      });
    }

    // POST /api/admin/logs/clear - Permanently delete the whole audit log
    // Superadmin only (no other role has the logs:delete permission).
    if (requestPath === "/api/admin/logs/clear" && req.method === "POST") {
      if (!hasPermission(admin.role, "logs:delete")) {
        return sendJson(403, { error: "Forbidden. Only a superadmin can clear the audit log." });
      }
      const deleted = await supabase.deleteAllLogs();
      return sendJson(200, { success: true, deleted, message: `${deleted} log entr${deleted === 1 ? "y" : "ies"} deleted.` });
    }

    // POST /api/admin/kick - Disconnect Client
    if (requestPath === "/api/admin/kick" && req.method === "POST") {
      if (!hasPermission(admin.role, "clients:kick")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const { clientId } = await parseJsonBody(req);
      let targetClient = null;
      for (const client of connectedClients) {
        if (client.id === Number(clientId)) {
          targetClient = client;
          break;
        }
      }

      if (targetClient) {
        if (targetClient.peer) {
          send(targetClient.peer, { type: "peer-disconnected" });
          targetClient.peer.peer = null;
          if (targetClient.peer.ready) putInWaitingQueue(targetClient.peer);
        }
        targetClient.peer = null;
        targetClient.ready = false;
        removeFromWaiting(targetClient);
        try { targetClient.close(); } catch (e) {}
        await supabase.logAction("KICK_CLIENT", { clientId }, admin.id, getClientIp(req));
        return sendJson(200, { success: true, message: `Client #${clientId} disconnected` });
      }
      return sendJson(404, { error: "Client not found" });
    }

    // GET /api/admin/announcements - List active announcement and history
    if (requestPath === "/api/admin/announcements" && req.method === "GET") {
      return sendJson(200, {
        active: activeAnnouncement,
        history: announcementHistory
      });
    }

    // POST /api/admin/broadcast or POST /api/admin/announcements - Publish Announcement & Optional Maintenance Lockout
    if ((requestPath === "/api/admin/broadcast" || requestPath === "/api/admin/announcements") && req.method === "POST") {
      if (!hasPermission(admin.role, "broadcast:send")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const body = await parseJsonBody(req);
      const message = (body.message || "").trim();
      if (!message) return sendJson(400, { error: "Message cannot be empty" });

      const lockout = !!body.lockout;
      const title = (body.title || "").trim() || (lockout ? "Website Maintenance & Update" : "System Announcement");

      activeAnnouncement = {
        id: "ann_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
        title,
        message: message.slice(0, 500),
        lockout,
        created_by: admin.username,
        created_at: new Date().toISOString()
      };

      announcementHistory.unshift(activeAnnouncement);
      if (announcementHistory.length > 50) announcementHistory.pop();

      // If lockout mode is turned on, cleanly terminate active peer calls and clear waiting queue
      if (lockout) {
        for (const client of connectedClients) {
          removeFromWaiting(client);
          if (client.peer) {
            send(client.peer, { type: "peer-disconnected" });
            client.peer.peer = null;
            client.peer.ready = false;
            client.peer = null;
          }
          client.ready = false;
        }
      }

      // Real-time broadcast to all connected WebSocket clients
      for (const client of connectedClients) {
        send(client, {
          type: "system_announcement",
          announcement: activeAnnouncement
        });
      }

      await supabase.logAction(
        lockout ? "MAINTENANCE_LOCK_ACTIVE" : "BROADCAST",
        { id: activeAnnouncement.id, title, message: activeAnnouncement.message, lockout },
        admin.id,
        getClientIp(req)
      );

      return sendJson(200, {
        success: true,
        announcement: activeAnnouncement,
        sentTo: connectedClients.size
      });
    }

    // DELETE /api/admin/announcements/:id or DELETE /api/admin/broadcast - Delete Announcement & Resume Website Access
    const annDeleteMatch = requestPath.match(/^\/api\/admin\/announcements\/([^/]+)$/);
    if ((annDeleteMatch || requestPath === "/api/admin/broadcast") && req.method === "DELETE") {
      if (!hasPermission(admin.role, "broadcast:send")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const targetId = annDeleteMatch ? annDeleteMatch[1] : (activeAnnouncement ? activeAnnouncement.id : null);
      if (!activeAnnouncement || (targetId !== "active" && targetId !== "current" && activeAnnouncement.id !== targetId)) {
        return sendJson(404, { error: "No active announcement matching that ID" });
      }

      const cleared = activeAnnouncement;
      activeAnnouncement = null;

      // Broadcast clearance to all clients to immediately unlock user interaction
      for (const client of connectedClients) {
        send(client, {
          type: "announcement_cleared",
          id: cleared.id
        });
      }

      await supabase.logAction(
        "MAINTENANCE_LOCK_CLEARED",
        { id: cleared.id, title: cleared.title },
        admin.id,
        getClientIp(req)
      );

      return sendJson(200, {
        success: true,
        message: "Announcement deleted and website unlocked for users."
      });
    }

    // ==================================================
    // ADMIN USER & ROLE MANAGEMENT (superadmin ONLY)
    // ==================================================

    // GET /api/admin/users - List Administrators
    if (requestPath === "/api/admin/users" && req.method === "GET") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to manage accounts." });
      }
      const admins = await supabase.getAdmins();
      return sendJson(200, { admins });
    }

    // POST /api/admin/users - Create New Administrator
    if (requestPath === "/api/admin/users" && req.method === "POST") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to create accounts." });
      }
      const { username, email, role, password } = await parseJsonBody(req);
      if (!username || !password) {
        return sendJson(400, { error: "Username and password required" });
      }
      // SECURITY: PUT /api/admin/users/:id/role validated the role against
      // ROLE_PERMISSIONS, but this creation path did not, so an arbitrary string
      // could be persisted as an account's role. Reject anything unrecognised so
      // an operator cannot silently create an account that has no permissions (or
      // one whose role only appears to work).
      const requestedRole = String(role || "moderator");
      if (!ROLE_PERMISSIONS[requestedRole]) {
        return sendJson(400, { error: "Invalid role specified" });
      }
      const trimmedUsername = String(username).trim();
      if (!trimmedUsername || trimmedUsername.length > 64) {
        return sendJson(400, { error: "Username must be between 1 and 64 characters" });
      }
      if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
        return sendJson(400, { error: "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol." });
      }
      const salt = bcrypt.genSaltSync(12);
      const hash = bcrypt.hashSync(password, salt);

      const created = await supabase.createAdminAccount({
        username: trimmedUsername,
        email: (email || "").trim(),
        role: requestedRole,
        password_hash: hash
      });

      await supabase.logAction("ADMIN_CREATED", { username: created.username, role: created.role }, admin.id, getClientIp(req));
      return sendJson(201, { success: true, admin: created });
    }

    // PUT /api/admin/users/:id/role - Update Admin Role
    const userRoleMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
    if (userRoleMatch && req.method === "PUT") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to edit roles." });
      }
      const targetId = userRoleMatch[1];
      const { role } = await parseJsonBody(req);
      if (!ROLE_PERMISSIONS[role]) {
        return sendJson(400, { error: "Invalid role specified" });
      }

      const updated = await supabase.updateAdminRole(targetId, role);
      await redis.bumpAdminSessionVersion(targetId);
      await supabase.logAction("ROLE_UPDATED", { targetId, newRole: role }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, admin: updated });
    }

    // POST /api/admin/change-password - Change own password
    if (requestPath === "/api/admin/change-password" && req.method === "POST") {
      const { currentPassword, newPassword } = await parseJsonBody(req);
      if (!currentPassword || !newPassword) {
        return sendJson(400, { error: "Current password and new password are required" });
      }
      if (newPassword.length < 12 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
        return sendJson(400, { error: "New password must be at least 12 characters and include uppercase, lowercase, number, and symbol." });
      }

      // Fetch user from DB/store, but keep the password change endpoint
      // responsive if the database is briefly slow.
      let user = null;
      try {
        user = await withTimeout(supabase.getAdminByUsername(admin.username), 2500, "Supabase admin password lookup");
      } catch (lookupError) {
        console.warn("[ADMIN] Password lookup unavailable/slow:", lookupError?.message || lookupError);
      }
      let isMatch = false;
      if (user && user.password_hash) {
        isMatch = bcrypt.compareSync(currentPassword, user.password_hash);
      } else if (admin.username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && ENV_ADMIN_PASSWORD_HASH) {
        isMatch = bcrypt.compareSync(currentPassword, ENV_ADMIN_PASSWORD_HASH);
      }

      if (!isMatch) {
        return sendJson(401, { error: "Current password is incorrect" });
      }

      const salt = bcrypt.genSaltSync(12);
      const newHash = bcrypt.hashSync(newPassword, salt);
      const updatedUser = await supabase.updateAdminPassword(admin.id, newHash);
      await redis.bumpAdminSessionVersion(admin.id);
      await redis.revokeAdminToken(admin.token, admin.exp);
      await supabase.logAction("PASSWORD_CHANGED", { username: admin.username, role: admin.role }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: "Password updated successfully" });
    }

    // DELETE /api/admin/users/:id - Superadmin delete account with safety measures
    const userDeleteMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userDeleteMatch && req.method === "DELETE") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to delete accounts." });
      }
      const targetId = userDeleteMatch[1];
      const targetUser = await supabase.getAdminById(targetId);
      if (!targetUser) {
        return sendJson(404, { error: "Account not found" });
      }

      // Safety check 1: Cannot delete own account
      if (targetUser.id === admin.id || targetUser.username.toLowerCase() === admin.username.toLowerCase()) {
        return sendJson(400, { error: "Safety violation: You cannot delete your own logged-in account." });
      }

      // Safety check 2: Cannot delete root admin
      if (targetUser.username.toLowerCase() === "admin" || targetUser.id === "admin-super-1") {
        return sendJson(400, { error: "Safety violation: The root system administrator account cannot be deleted." });
      }

      // Safety check 3: Ensure there is at least one active superadmin remaining
      if (targetUser.role === "superadmin") {
        const allAdmins = await supabase.getAdmins();
        const superadmins = allAdmins.filter(a => a.role === "superadmin" && a.id !== targetId);
        if (superadmins.length === 0) {
          return sendJson(400, { error: "Safety violation: Cannot delete the last remaining superadmin account." });
        }
      }

      await redis.bumpAdminSessionVersion(targetId);
      await supabase.deleteAdminAccount(targetId);
      await supabase.logAction("ADMIN_DELETED", { targetId, username: targetUser.username, role: targetUser.role }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `Account for ${targetUser.username} deleted successfully` });
    }

    // PUT /api/admin/users/:id/password - Superadmin reset staff password
    const userPassMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (userPassMatch && req.method === "PUT") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to reset passwords." });
      }
      const targetId = userPassMatch[1];
      const { newPassword } = await parseJsonBody(req);
      if (!newPassword || newPassword.length < 12 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
        return sendJson(400, { error: "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol." });
      }
      const targetUser = await supabase.getAdminById(targetId);
      if (!targetUser) {
        return sendJson(404, { error: "Account not found" });
      }
      const salt = bcrypt.genSaltSync(12);
      const hash = bcrypt.hashSync(newPassword, salt);
      await supabase.updateAdminPassword(targetId, hash);
      await redis.bumpAdminSessionVersion(targetId);
      await supabase.logAction("ADMIN_PASSWORD_RESET", { targetId, username: targetUser.username }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `Password reset for ${targetUser.username}` });
    }

    // GET /api/admin/logs - System Audit Logs
    if (requestPath === "/api/admin/logs" && req.method === "GET") {
      if (!hasPermission(admin.role, "logs:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const logs = await supabase.getLogs(100);
      return sendJson(200, { logs });
    }

    return sendJson(404, { error: "Admin endpoint not found" });
  }

  // --------------------------------------------------
  // PUBLIC ADS & ENGAGEMENT API (FOR USER index.html)
  // --------------------------------------------------

  // GET /api/health - Liveness probe for the hosting platform.
  //
  // Render polls healthCheckPath continuously. It must NOT point at
  // /api/rtc-config: that route is rate limited (RTC_CONFIG_LIMIT per
  // RTC_CONFIG_WINDOW_MS) and returns 429 once the budget is spent, which
  // makes Render cancel an otherwise healthy deploy. This endpoint is
  // deliberately cheap, unauthenticated and never rate limited. It exposes
  // no configuration, secrets or user data - only a liveness flag.
  if (requestPath === "/api/health" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    return sendJson(200, { status: "ok", uptime: Math.floor(process.uptime()) });
  }

  if (requestPath === "/api/online-count" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    return sendJson(200, { count: getOnlineCount() });
  }

  // GET /api/rtc-config - WebRTC ICE servers for the browser.
  //
  // TURN credentials must reach the client, so they are served from here
  // rather than being hardcoded in a public JS file. With TURN_SHARED_SECRET
  // configured this mints a short-lived credential per request; the shared
  // secret itself never leaves the server. Responds with STUN-only when no
  // relay is configured, which is the same behaviour as before this endpoint
  // existed, so video calling is never broken by missing configuration.
  if (requestPath === "/api/rtc-config" && req.method === "GET") {
    // SECURITY: bound how often TURN credentials can be minted (see
    // checkRtcConfigRate). Still far above what a real page load needs.
    if (!checkRtcConfigRate(getClientIp(req))) {
      return sendJson(429, { error: "Too many ICE configuration requests. Please slow down." });
    }
    res.setHeader("Cache-Control", "no-store");
    return sendJson(200, rtcConfig.getRtcConfiguration());
  }

  // GET /api/announcement - Get active announcement / maintenance status
  if (requestPath === "/api/announcement" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return sendJson(200, { announcement: activeAnnouncement });
  }

  // GET /api/ads - Get active ads for user dashboard with settings
  if (requestPath === "/api/ads" && req.method === "GET") {
    const settings = await supabase.getAdSettings();
    if (settings && settings.enabled === false) {
      return sendJson(200, { ads: [], settings });
    }
    const activeAds = await supabase.getActiveAds();
    // Return sanitized ads list for the frontend
    const sanitized = activeAds.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body || "",
      cta_text: a.cta_text || "Learn more ↗",
      media_url: a.media_url,
      media_type: a.media_type,
      link_url: a.link_url,
      placement: a.placement || settings.defaultPlacement || "stranger-overlay",
      device_target: a.device_target || "all",
      rotation_seconds: a.rotation_seconds || settings.rotationSeconds || 12,
      priority: a.priority || 1
    }));
    return sendJson(200, { ads: sanitized, settings });
  }

  // POST /api/ads/:id/impression - Record ad impression
  const adImpressionMatch = requestPath.match(/^\/api\/ads\/([^/]+)\/impression$/);
  if (adImpressionMatch && req.method === "POST") {
    const adId = adImpressionMatch[1];
    const ip = getClientIp(req);
    if (!checkAdEventRate(ip)) {
      return sendJson(429, { error: "Too many events. Please slow down." });
    }
    const ua = req.headers["user-agent"] || "";
    supabase.recordAdImpression(adId, ip, ua);
    redis.incrementMetric("adImpressions");
    return sendJson(200, { success: true });
  }

  // POST /api/ads/:id/click - Record ad click
  const adClickMatch = requestPath.match(/^\/api\/ads\/([^/]+)\/click$/);
  if (adClickMatch && req.method === "POST") {
    const adId = adClickMatch[1];
    const ip = getClientIp(req);
    if (!checkAdEventRate(ip)) {
      return sendJson(429, { error: "Too many events. Please slow down." });
    }
    const ua = req.headers["user-agent"] || "";
    supabase.recordAdClick(adId, ip, ua);
    redis.incrementMetric("adClicks");
    return sendJson(200, { success: true });
  }

  // --------------------------------------------------
  // STATIC FILE SERVING WITH SECURITY HARDENING
  // --------------------------------------------------

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  // Clean route for the video chat app (landing page owns the root URL).
  if (requestPath === "/app" || requestPath === "/app/") {
    requestPath = "/app.html";
  }

  // Extensionless routes for the landing page's sibling documents.
  const cleanDocumentRoutes = {
    "/about": "/about.html",
    "/contact": "/contact.html",
    "/privacy": "/privacy.html",
    "/terms": "/terms.html",
    "/guidelines": "/guidelines.html"
  };
  if (cleanDocumentRoutes[requestPath]) {
    requestPath = cleanDocumentRoutes[requestPath];
  }

  try {
    requestPath = decodeURIComponent(requestPath);
  } catch (error) {
    res.writeHead(400);
    return res.end("Bad request");
  }

  // Standard static file serving from publicDir
  const filePath = path.resolve(publicDir, "." + requestPath);

  // Prevent directory traversal outside the public folder
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  // Defence in depth against visitor PII ever being served. The contact log
  // contains real names, emails, IP addresses and message bodies, so even if a
  // copy is accidentally written into the web root it must never be served.
  // This exact file previously sat in public/ and was downloadable by anyone.
  const relativeToPublic = path.relative(publicDir, filePath);
  if (
    path.extname(relativeToPublic).toLowerCase() === ".jsonl" ||
    path.basename(relativeToPublic) === "contact-messages.jsonl" ||
    relativeToPublic === ".env" ||
    relativeToPublic.endsWith(".env")
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      // Fallback: if requesting index.html or not found, try serving public/index.html
      if (requestPath === "/index.html") {
        res.writeHead(404);
        return res.end("Application entry point missing");
      }

      // Serve the branded 404 page when it exists, plain text as fallback.
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      fs.readFile(path.join(publicDir, "404.html"), (notFoundError, notFoundData) => {
        if (notFoundError) return res.end("Not found");
        res.end(notFoundData);
      });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".webp": "image/webp"
    };

    const contentType = contentTypes[extension] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
});

// Harden HTTP connection handling against slow clients.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

// ==================================================
// WEBSOCKET SIGNALING SERVER (WEBRTC)
// ==================================================

const wss = new WebSocket.Server({
  server,
  maxPayload: 64 * 1024, // 64KB max payload (DoS protection)
  perMessageDeflate: false
});

// --------------------------------------------------
// WebSocket connection-abuse protection
// --------------------------------------------------
// Deliberately GENEROUS limits. Many real users share one public IP (mobile
// carrier NAT, campus and office networks), and WebRTC signaling is bursty
// (dozens of ICE candidates in a second), so these only trip on clear abuse
// such as a script opening thousands of sockets or flooding messages. All
// values can be tuned with environment variables without touching code.
const WS_MAX_CONN_PER_IP = Number(process.env.WS_MAX_CONN_PER_IP) || 60;
const WS_CONN_RATE_LIMIT = Number(process.env.WS_CONN_RATE_LIMIT) || 240; // new sockets per IP...
const WS_CONN_RATE_WINDOW_MS = 60 * 1000; // ...per minute
const WS_MSG_RATE_LIMIT = Number(process.env.WS_MSG_RATE_LIMIT) || 300; // messages per socket...
const WS_MSG_RATE_WINDOW_MS = 10 * 1000; // ...per 10 seconds (30/s sustained, bursts allowed)
const WS_MSG_ABUSE_STRIKES = 3; // consecutive over-limit windows before the socket is closed

const wsConnectionsByIp = new Map(); // ip -> open socket count
const wsConnectionAttempts = new Map(); // ip -> [timestamps]

// Returns true when the new socket may proceed. Counts it as open on success;
// the caller must call wsReleaseIp(ip) exactly once when the socket closes.
function wsAcceptConnection(ip) {
  if (!ip || ip === "unknown") return true; // cannot attribute: never throttle everyone together

  const now = Date.now();
  const recent = (wsConnectionAttempts.get(ip) || []).filter(
    (timestamp) => now - timestamp < WS_CONN_RATE_WINDOW_MS
  );
  if (recent.length >= WS_CONN_RATE_LIMIT) {
    wsConnectionAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  wsConnectionAttempts.set(ip, recent);
  enforceMapLimit(wsConnectionAttempts);

  const open = wsConnectionsByIp.get(ip) || 0;
  if (open >= WS_MAX_CONN_PER_IP) return false;
  wsConnectionsByIp.set(ip, open + 1);
  return true;
}

function wsReleaseIp(ip) {
  if (!ip || ip === "unknown") return;
  const open = (wsConnectionsByIp.get(ip) || 0) - 1;
  if (open > 0) wsConnectionsByIp.set(ip, open);
  else wsConnectionsByIp.delete(ip);
}

// Per-socket message limiter. Returns false when the message should be dropped.
// Normal signaling never comes near the limit; a socket that stays over it for
// several windows in a row is closed.
function wsMessageAllowed(socket) {
  const now = Date.now();
  if (!socket._msgWindowStart || now - socket._msgWindowStart >= WS_MSG_RATE_WINDOW_MS) {
    if (socket._msgOverLimit) {
      socket._msgStrikes = (socket._msgStrikes || 0) + 1;
    } else {
      socket._msgStrikes = 0;
    }
    socket._msgOverLimit = false;
    socket._msgWindowStart = now;
    socket._msgCount = 0;
  }

  socket._msgCount += 1;
  if (socket._msgCount <= WS_MSG_RATE_LIMIT) return true;

  socket._msgOverLimit = true;
  if ((socket._msgStrikes || 0) + 1 >= WS_MSG_ABUSE_STRIKES) {
    try { socket.close(1008, "Rate limit exceeded"); } catch (_) {}
  }
  return false;
}

// Heartbeat: phones that lose signal or close the browser often never send a
// proper close, leaving "ghost" sockets that inflate the online count and sit
// in the waiting queue. Ping everyone every 15s and drop any socket that did
// not answer the previous ping. Termination fires the normal close cleanup.
const wsHeartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      try { client.terminate(); } catch (_) {}
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch (_) {}
  }
}, 15 * 1000);
if (typeof wsHeartbeat.unref === "function") wsHeartbeat.unref();

// Drop expired connection-attempt records so the Map cannot grow forever.
const wsLimiterSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, stamps] of wsConnectionAttempts) {
    const fresh = stamps.filter((timestamp) => now - timestamp < WS_CONN_RATE_WINDOW_MS);
    if (fresh.length) wsConnectionAttempts.set(ip, fresh);
    else wsConnectionAttempts.delete(ip);
  }
}, 60 * 1000);
if (typeof wsLimiterSweep.unref === "function") wsLimiterSweep.unref();

function isAllowedWebSocketOrigin(request) {
  const origin = String(request.headers.origin || "").trim();
  if (!origin) return true; // non-browser clients / native clients

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (request.socket.encrypted ? "https" : "http");
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").trim();
  const sameOrigin = host ? `${protocol}://${host}` : "";

  if (sameOrigin && origin === sameOrigin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;

  try {
    const originUrl = new URL(origin);
    const hostWithoutPort = host.split(":")[0];
    if (originUrl.hostname === hostWithoutPort || originUrl.host === host) return true;

    // Always allow localhost & loopback addresses
    if (
      originUrl.hostname === "localhost" ||
      originUrl.hostname === "127.0.0.1" ||
      originUrl.hostname === "::1" ||
      originUrl.hostname.endsWith(".localhost")
    ) return true;

    // In development, allow common local/cloud preview hosts. In production,
    // do not trust arbitrary platform subdomains; explicitly configure them via
    // ALLOWED_ORIGINS instead. This prevents an unrelated Vercel/Railway site
    // from opening browser WebSocket connections to the production server.
    if (!IS_PRODUCTION && (
      originUrl.hostname.endsWith(".railway.app") ||
      originUrl.hostname.endsWith(".up.railway.app") ||
      originUrl.hostname.endsWith(".onrender.com") ||
      originUrl.hostname.endsWith(".fly.dev") ||
      originUrl.hostname.endsWith(".koyeb.app") ||
      originUrl.hostname.endsWith(".herokuapp.com") ||
      originUrl.hostname.endsWith(".vercel.app") ||
      originUrl.hostname.endsWith(".netlify.app") ||
      originUrl.hostname.endsWith(".zeabur.app")
    )) return true;

    // Support domain env vars (APP_URL, PUBLIC_URL, SERVER_URL, DOMAIN, etc.)
    const envUrls = [
      process.env.APP_URL,
      process.env.PUBLIC_URL,
      process.env.SERVER_URL,
      process.env.RENDER_EXTERNAL_URL,
      process.env.DOMAIN
    ].filter(Boolean);

    for (const envUrl of envUrls) {
      try {
        const u = new URL(envUrl.startsWith("http") ? envUrl : `https://${envUrl}`);
        if (u.hostname === originUrl.hostname) return true;
      } catch (_) {}
    }
  } catch (_) {}

  // SECURITY: this used to fail open. "if (ALLOWED_ORIGINS.size === 0) return
  // true" meant that a production deployment which never set ALLOWED_ORIGINS
  // accepted a WebSocket from ANY website, which is Cross-Site WebSocket
  // Hijacking: any page could open a socket to this server and read the traffic
  // it pushes. Fail closed in production instead - same-origin and loopback are
  // already handled above, so a normal deployment is unaffected and only a
  // genuinely cross-origin client now needs to be listed explicitly.
  return !IS_PRODUCTION;
}

let nextClientId = 1;
const waitingClients = [];
const connectedClients = new Set();
const reportThrottle = new Map();
const REPORT_LIMIT = 5;
const REPORT_WINDOW_MS = 10 * 60 * 1000;

function canSubmitReport(ip) {
  const now = Date.now();
  const current = reportThrottle.get(ip);
  if (!current || now - current.windowStart > REPORT_WINDOW_MS) {
    reportThrottle.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (current.count >= REPORT_LIMIT) return false;
  current.count += 1;
  return true;
}

// Online people = distinct browsers. Each browser sends a random anonymous id,
// so two tabs of the same browser count once, while different people who share
// one IP (mobile NAT, Wi-Fi) still count separately. Old clients without an id
// fall back to their IP.
function getOnlineCount() {
  const people = new Set();
  for (const client of connectedClients) {
    people.add(client.reporterKey || client.ip || String(client.id));
  }
  return people.size;
}

// --------------------------------------------------
// IP -> approximate location (admin "Online now" view only)
// --------------------------------------------------
// Looked up server-side with the free ipwho.is service, cached for 24h so each
// IP is looked up at most once a day. Location from an IP is approximate (it is
// usually the ISP / city, not the street). Set GEO_LOOKUP=off to disable it.
const GEO_LOOKUP_ENABLED = String(process.env.GEO_LOOKUP || "on").trim().toLowerCase() !== "off";
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_FAIL_TTL_MS = 10 * 60 * 1000;
const geoCache = new Map(); // ip -> { label, expires }

function isPrivateOrLocalIp(ip) {
  const v = String(ip || "");
  return (
    v === "unknown" || v === "::1" || v.startsWith("127.") || v.startsWith("10.") ||
    v.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(v) ||
    v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")
  );
}

async function lookupGeo(ip) {
  const cached = geoCache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.label;
  if (isPrivateOrLocalIp(ip)) return "Private / local network";
  if (!GEO_LOOKUP_ENABLED) return "Lookup disabled";

  let label = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(
      `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,region,city`,
      { signal: controller.signal, headers: { Accept: "application/json" } }
    );
    if (response.ok) {
      const data = await response.json();
      if (data && data.success) {
        label = [data.city, data.region, data.country].filter(Boolean).join(", ") || null;
      }
    }
  } catch (_) {
    // timeout / offline: show "Unknown" and retry later
  } finally {
    clearTimeout(timer);
  }

  geoCache.set(ip, {
    label: label || "Unknown",
    expires: Date.now() + (label ? GEO_TTL_MS : GEO_FAIL_TTL_MS)
  });
  if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value);
  return label || "Unknown";
}

function broadcastOnlineCount() {
  const message = {
    type: "online-count",
    count: getOnlineCount()
  };

  for (const client of connectedClients) {
    send(client, message);
  }
}

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
    } catch (e) {}
  }
}

function removeFromWaiting(socket) {
  const index = waitingClients.indexOf(socket);
  if (index !== -1) {
    waitingClients.splice(index, 1);
  }
}

function putInWaitingQueue(socket) {
  if (!socket || socket.readyState !== WebSocket.OPEN || socket.peer) {
    return;
  }

  if (!waitingClients.includes(socket)) {
    waitingClients.push(socket);
  }

  send(socket, { type: "waiting" });
}

function areMatchCompatible(clientA, clientB) {
  if (!clientA || !clientB) return false;
  if (clientA.peer || clientB.peer) return false;
  if (clientA.blockedPeerIps && clientA.ip && clientA.blockedPeerIps.has(clientB.ip)) return false;
  if (clientB.blockedPeerIps && clientB.ip && clientB.blockedPeerIps.has(clientA.ip)) return false;
  return true;
}

function tryMatchUsers() {
  for (let i = waitingClients.length - 1; i >= 0; i--) {
    const client = waitingClients[i];
    if (!client || client.readyState !== WebSocket.OPEN || client.peer) {
      waitingClients.splice(i, 1);
    }
  }

  while (waitingClients.length >= 2) {
    let pairA = -1;
    let pairB = -1;

    // First prefer compatible users who were not each other's immediate
    // previous peer. This makes Next feel like a real search when alternatives
    // exist, while never trapping two users in an endless wait.
    outerDifferent:
    for (let i = 0; i < waitingClients.length - 1; i++) {
      for (let j = i + 1; j < waitingClients.length; j++) {
        const a = waitingClients[i];
        const b = waitingClients[j];
        if (!areMatchCompatible(a, b)) continue;
        if (a.lastPeerId === b.id && b.lastPeerId === a.id) continue;
        pairA = i;
        pairB = j;
        break outerDifferent;
      }
    }

    // If everyone left in the queue was previously connected to the other
    // available person, match anyway. This is crucial for the two-user case:
    // A presses Next -> A and B are the only users -> A and B reconnect.
    if (pairA === -1) {
      outerAny:
      for (let i = 0; i < waitingClients.length - 1; i++) {
        for (let j = i + 1; j < waitingClients.length; j++) {
          const a = waitingClients[i];
          const b = waitingClients[j];
          if (areMatchCompatible(a, b)) {
            pairA = i;
            pairB = j;
            break outerAny;
          }
        }
      }
    }

    // Everyone currently waiting is mutually blocked, usually because a
    // report created a safety exclusion. Leave them waiting for someone else.
    if (pairA === -1) break;

    const clientB = waitingClients.splice(pairB, 1)[0];
    const clientA = waitingClients.splice(pairA, 1)[0];

    if (!areMatchCompatible(clientA, clientB)) continue;

    clientA.peer = clientB;
    clientB.peer = clientA;
    clientA.ready = true;
    clientB.ready = true;

    clientA.lastPeerId = clientB.id;
    clientB.lastPeerId = clientA.id;

    redis.incrementMetric("matchesCompleted");

    send(clientA, { type: "matched", role: "caller" });
    send(clientB, { type: "matched", role: "callee" });

    // Only the caller creates the offer.
    send(clientA, { type: "create-offer" });
  }
}

const adminRealtimeClients = new Set();
let adminRealtimeChannelStarted = false;

function broadcastAdminRealtime(payload) {
  const message = JSON.stringify({ type: "admin-realtime", ...payload });
  for (const client of adminRealtimeClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); } catch (_) {}
    }
  }
}

function initAdminSupabaseRealtime() {
  // Intentionally disabled in hosted/serverless runtimes. A persistent
  // server-side Supabase Realtime subscription is not a reliable lifecycle
  // primitive for Vercel Functions. The admin UI uses bounded polling instead.
  return null;
}

wss.on("connection", safeAsync(async (socket, request) => {
  if (!isAllowedWebSocketOrigin(request)) {
    try { socket.close(1008, "Origin not allowed"); } catch (_) {}
    return;
  }

  // Liveness: answer the server's ping so dead connections can be removed.
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  // Connection-abuse protection (generous limits, see the constants above).
  const limiterIp = getClientIp(request);
  if (!wsAcceptConnection(limiterIp)) {
    try { socket.close(1013, "Too many connections. Try again shortly."); } catch (_) {}
    return;
  }
  socket.once("close", () => wsReleaseIp(limiterIp));

  const requestPath = String(request.url || "").split("?")[0];
  if (requestPath === "/__admin-realtime") {
    socket.isAdminRealtime = true;
    socket.authenticatedAdmin = null;
    // SECURITY: the socket is deliberately NOT added to adminRealtimeClients
    // here. Adding it before authentication let anyone open a socket to this
    // path and receive every admin broadcast (new reports, bans, client
    // activity) without ever logging in. The socket is registered only after a
    // valid JWT is presented, and removed if auth never completes.
    let adminAuthTimeout = setTimeout(() => {
      try { socket.close(1008, "Authentication timeout"); } catch (_) {}
    }, 10_000);

    socket.on("message", safeAsync(async (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString());
        if (message?.type === "admin-auth" && !socket.authenticatedAdmin) {
          const token = typeof message.token === "string" ? message.token.trim() : "";
          const fakeReq = { headers: { authorization: `Bearer ${token}` } };
          const admin = await verifyAdminToken(fakeReq);
          if (!admin) {
            socket.send(JSON.stringify({ type: "admin-auth-failed" }));
            socket.close(1008, "Unauthorized");
            return;
          }
          socket.authenticatedAdmin = admin;
          clearTimeout(adminAuthTimeout);
          adminRealtimeClients.add(socket);
          socket.send(JSON.stringify({ type: "admin-auth-ok", user: { id: admin.id, username: admin.username, role: admin.role } }));
        }
      } catch (_) {}
    }, "Admin Realtime message"));

    socket.on("close", () => {
      clearTimeout(adminAuthTimeout);
      adminRealtimeClients.delete(socket);
    });
    socket.on("error", () => {
      adminRealtimeClients.delete(socket);
    });
    return;
  }

  // The ban check below is async (up to ~1.4s on a cold database). The browser
  // sends "ready" the instant the socket opens, and a message that arrives
  // before a listener exists is silently lost, which left users stuck on
  // "Seeking match" until something else nudged them. Buffer those messages
  // here and replay them once the real handler is attached.
  const earlyMessages = [];
  const bufferEarlyMessage = (data, isBinary) => {
    if (earlyMessages.length < 50) earlyMessages.push([data, isBinary]);
  };
  socket.on("message", bufferEarlyMessage);

  const clientIp = getClientIp(request);

  // Rapid ban verification. Use a short cache + bounded Redis/Supabase checks
  // so reconnect storms do not repeatedly hammer Supabase or kill the runtime.
  let connCid = null;
  try {
    const rawCid = new URL(request.url || "/", "http://localhost").searchParams.get("cid");
    if (rawCid && /^[A-Za-z0-9_-]{8,64}$/.test(rawCid)) connCid = rawCid;
  } catch (_) {}

  const banKeys = [clientIp];
  if (connCid) banKeys.push(`cid:${connCid}`);
  const banned = (await Promise.all(banKeys.map(checkBanKey))).some(Boolean);
  if (banned) {
    send(socket, { type: "banned", reason: "Access suspended due to community guidelines violation." });
    setTimeout(() => {
      try { socket.close(); } catch (e) {}
    }, 200);
    return;
  }

  socket.id = nextClientId++;
  socket.ip = clientIp;
  // Reports are de-duplicated per reporter. Using the IP alone merged every
  // reporter behind the same Wi-Fi / mobile NAT into one, so the unique-reporter
  // count could not rise above 1. The browser also sends a random anonymous id.
  socket.cid = connCid;
  socket.reporterKey = connCid ? `${clientIp}#${connCid.slice(0, 16)}` : clientIp;
  socket.connectedAt = Date.now();
  socket.ready = false;
  socket.peer = null;
  // Used only as a matchmaking preference: when alternatives exist, avoid
  // immediately returning a user to the same person after Next. If the two
  // are the only compatible waiting users, they are allowed to reconnect.
  socket.lastPeerId = null;
  socket.blockedPeerIps = new Set();

  connectedClients.add(socket);
  redis.trackClient(socket.id, socket.ip);
  broadcastOnlineCount();

  // If active announcement exists (lockout or banner notice), immediately send to this connection
  if (activeAnnouncement) {
    send(socket, {
      type: "system_announcement",
      announcement: activeAnnouncement
    });
  }

  socket.on("message", safeAsync(async (rawMessage) => {
    // Flood protection: drop messages beyond a generous per-socket rate.
    if (!wsMessageAllowed(socket)) return;

    let message;
    try {
      message = JSON.parse(rawMessage.toString());
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
    } catch (error) {
      return;
    }

    // If website is locked for maintenance, block interaction requests
    if (activeAnnouncement && activeAnnouncement.lockout) {
      if (["ready", "signal", "offer", "answer", "candidate", "skip", "chat"].includes(message.type)) {
        send(socket, {
          type: "system_announcement",
          announcement: activeAnnouncement
        });
        return;
      }
    }

    if (message.type === "ready") {
      // "ready" is intentionally idempotent. A client may already be marked
      // ready when its previous peer disconnects, but it still needs to be
      // placed back into the waiting queue for the next match.
      socket.ready = true;

      if (!socket.peer) {
        putInWaitingQueue(socket);
        tryMatchUsers();
      }

      return;
    }

    if (message.type === "stop") {
      removeFromWaiting(socket);
      const oldPeer = socket.peer;
      socket.ready = false;
      socket.peer = null;

      if (oldPeer && oldPeer.readyState === WebSocket.OPEN) {
        oldPeer.peer = null;

        // The remaining person is still actively using the service, so
        // immediately place them back into the matchmaking queue. The client
        // will also send "ready" after handling peer-disconnected; the ready
        // handler above is idempotent, so either path is safe.
        oldPeer.ready = true;
        putInWaitingQueue(oldPeer);

        send(oldPeer, { type: "peer-disconnected" });
      }

      tryMatchUsers();
      return;
    }

    if (message.type === "skip") {
      const oldPeer = socket.peer;
      socket.peer = null;

      if (oldPeer) {
        oldPeer.peer = null;
        // "Next" is not a safety block. When only two users are online they
        // must be able to reconnect to each other. tryMatchUsers() will prefer
        // different people when alternatives exist.
        send(oldPeer, { type: "peer-disconnected" });
        if (oldPeer.ready) {
          putInWaitingQueue(oldPeer);
        }
      }

      removeFromWaiting(socket);

      if (socket.readyState === WebSocket.OPEN && socket.ready) {
        waitingClients.unshift(socket);
        send(socket, { type: "waiting" });
      }

      tryMatchUsers();
      return;
    }

    if (message.type === "report") {
      if (!canSubmitReport(socket.ip)) {
        send(socket, { type: "report-rate-limited", message: "Too many reports. Please try again later." });
        return;
      }

      const reportedPeer = socket.peer;
      const reportData = {
        reporterId: socket.id,
        reportedId: reportedPeer ? reportedPeer.id : null,
        reporterIp: socket.reporterKey || socket.ip,
        reportedIp: reportedPeer ? reportedPeer.ip : "unknown",
        reason: (typeof message.reason === "string" ? message.reason.trim().slice(0, 100) : "Unspecified")
      };

      // Reporting always ends the current encounter for BOTH users. The two
      // peers are also prevented from immediately matching each other again.
      removeFromWaiting(socket);
      if (reportedPeer) {
        socket.peer = null;
        reportedPeer.peer = null;
        if (socket.blockedPeerIps && reportedPeer.ip) socket.blockedPeerIps.add(reportedPeer.ip);
        if (reportedPeer.blockedPeerIps && socket.ip) reportedPeer.blockedPeerIps.add(socket.ip);
        if (socket.blockedPeerIps && socket.blockedPeerIps.size > 100) socket.blockedPeerIps.delete(socket.blockedPeerIps.values().next().value);
        if (reportedPeer.blockedPeerIps && reportedPeer.blockedPeerIps.size > 100) reportedPeer.blockedPeerIps.delete(reportedPeer.blockedPeerIps.values().next().value);

        send(socket, { type: "peer-disconnected" });
        send(reportedPeer, { type: "peer-disconnected", reason: "The current encounter ended." });

        if (reportedPeer.ready && reportedPeer.readyState === WebSocket.OPEN) {
          putInWaitingQueue(reportedPeer);
        }
      }
      if (socket.ready && socket.readyState === WebSocket.OPEN) {
        putInWaitingQueue(socket);
      }

      let savedReport;
      try {
        savedReport = await supabase.saveReport(reportData);
      } catch (error) {
        console.error("[REPORT] Could not persist report:", error.message);
        send(socket, { type: "report-save-error", message: "The report could not be saved. You have still been moved to a new encounter." });
        tryMatchUsers();
        return;
      }

      if (reportedPeer && reportedPeer.cid) rememberReportedCid(savedReport.id, reportedPeer.cid);
      redis.publishEvent("reports:new", { ...reportData, ...savedReport });
      redis.incrementMetric("reportsReceived");

      const uniqueReporterCount = Number(savedReport.uniqueReportersCount || 1);
      const ipReportCount = Number(savedReport.ipReportCount || savedReport.reportCount || 1);
      const ipUniqueReporterCount = Number(savedReport.ipUniqueReportersCount || uniqueReporterCount || 1);
      const escalated = ipUniqueReporterCount >= 3;
      if (escalated) {
        try {
          await supabase.logAction("REPORT_ESCALATED", {
            reportedIp: reportData.reportedIp,
            reason: reportData.reason,
            reportCount: Number(savedReport.reportCount || 1),
            uniqueReporterCount
          }, "system", socket.ip || "unknown");
        } catch (logError) {
          console.warn("[REPORT] Escalation log failed:", logError.message);
        }
      }
      send(socket, {
        type: "report-received",
        duplicate: !!savedReport.duplicate,
        reportCount: Number(savedReport.reportCount || 1),
        uniqueReporterCount,
        uniqueReportersCount: uniqueReporterCount,
        ipReportCount,
        ipUniqueReporterCount,
        escalated
      });
      tryMatchUsers();
      return;
    }

    // Peer-to-peer relay. SECURITY: these messages used to be forwarded
    // verbatim, i.e. whatever JSON the peer sent. A malicious stranger could
    // therefore smuggle arbitrary extra properties into the victim's socket and
    // have the client act on them, because the browser dispatches purely on
    // message.type (system_announcement, announcement_cleared, banned, ...).
    // Rebuild each relayed message from an explicit field allowlist so a peer
    // can only ever deliver the one payload shape the protocol defines.
    const RELAY_FIELDS = {
      "record-request": [],
      "record-response": ["accept"],
      "recording-started": [],
      "recording-paused": [],
      "recording-stopped": [],
      "offer": ["offer"],
      "answer": ["answer"],
      "ice-candidate": ["candidate"]
    };

    const relayFields = Object.prototype.hasOwnProperty.call(RELAY_FIELDS, message.type)
      ? RELAY_FIELDS[message.type]
      : null;

    if (relayFields) {
      if (socket.peer && socket.peer.readyState === WebSocket.OPEN) {
        const relayed = { type: message.type };
        for (const field of relayFields) {
          if (message[field] !== undefined) relayed[field] = message[field];
        }
        send(socket.peer, relayed);
      }
      return;
    }
  }, "Public WebSocket message"));

  // Real handler is attached: stop buffering and replay anything that arrived
  // while the ban check was running.
  socket.off("message", bufferEarlyMessage);
  for (const [data, isBinary] of earlyMessages) {
    socket.emit("message", data, isBinary);
  }
  earlyMessages.length = 0;

  socket.on("error", () => {});

  socket.on("close", () => {
    connectedClients.delete(socket);
    redis.removeClient(socket.id);
    broadcastOnlineCount();

    removeFromWaiting(socket);
    const oldPeer = socket.peer;
    socket.peer = null;

    if (oldPeer) {
      oldPeer.peer = null;
      send(oldPeer, { type: "peer-disconnected" });
      if (oldPeer.ready) {
        putInWaitingQueue(oldPeer);
        tryMatchUsers();
      }
    }
  });
}, "Public WebSocket connection"));

// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("==================================================");
  console.log(" LELA WebRTC & Admin Control Center Online");
  console.log("==================================================");
  console.log(`Port: ${PORT} | Host: ${HOST}`);
  console.log(`User Dashboard:  http://localhost:${PORT}/`);
  if (ADMIN_ROUTE === "/admin") {
    console.log(`Admin Panel:     http://localhost:${PORT}/admin`);
  } else {
    console.log(`Public /admin:   404 Not Found`);
    console.log(`Private Admin:   configured (path hidden)`);
  }
  console.log(`Admin Auth:       Environment-backed credentials`);
  console.log("==================================================");
  console.log("");

  // SECURITY: the development fallbacks (admin/admin123 and the built-in JWT
  // signing key) activate whenever NODE_ENV is not "production" and no hosting
  // platform variable is detected. A self-hosted or bare-metal deploy that
  // forgets NODE_ENV therefore comes up quietly on a guessable password while
  // still printing "Environment-backed credentials", which reads like the secure
  // path was taken. Fail loudly so an operator notices before exposing the port.
  if (!IS_PRODUCTION) {
    console.warn(
      "\n" +
        "==================================================\n" +
        " [SECURITY] DEVELOPMENT MODE - INSECURE DEFAULTS ACTIVE\n" +
        "==================================================\n" +
        "  NODE_ENV is not 'production' and no hosting platform was detected,\n" +
        "  so the server is using its development fallbacks:\n" +
        (ADMIN_PASSWORD === DEV_FALLBACK_ADMIN_PASSWORD
          ? "    * admin password is the default 'admin123'\n"
          : "") +
        (JWT_SECRET === DEV_FALLBACK_JWT_SECRET
          ? "    * JWT signing key is the built-in development value\n"
          : "") +
        (ADMIN_ROUTE === "/admin"
          ? "    * admin dashboard is served at the guessable path /admin\n"
          : "") +
        (ALLOWED_ORIGINS.size === 0
          ? "    * no ALLOWED_ORIGINS configured (any origin may open a WebSocket)\n"
          : "") +
        "\n" +
        "  This is intended for local development only. Before exposing this\n" +
        "  server to a network, set NODE_ENV=production and provide\n" +
        "  ADMIN_PASSWORD, JWT_SECRET, ADMIN_PATH and SUPABASE_* variables;\n" +
        "  production startup then refuses to run with weak values.\n" +
        "==================================================\n"
    );
  }
});
