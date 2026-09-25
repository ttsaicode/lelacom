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

// Runtime Port & Host configuration
const PORT = parseInt(process.env.PORT, 10) || 3000;
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
    process.env.CONTAINER_APP_NAME ||
    process.env.ZEABUR_ENVIRONMENT
  );

const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();
const JWT_EXPIRY = String(process.env.JWT_EXPIRY || "1h").trim();
const JWT_ISSUER = "lela-admin";

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");

// In production the public /admin route is never used. The real admin route
// is supplied only through ADMIN_PATH. Local development may omit it.
const rawAdminPath = String(process.env.ADMIN_PATH || "").trim();
const ADMIN_ROUTE = rawAdminPath
  ? `/${rawAdminPath.replace(/^\/+|\/+$/g, "")}`
  : (IS_PRODUCTION ? null : "/admin");

if (IS_PRODUCTION) {
  const missing = [];
  if (!JWT_SECRET || JWT_SECRET.length < 32) missing.push("JWT_SECRET (32+ chars)");
  if (!ADMIN_USERNAME) missing.push("ADMIN_USERNAME");
  if (!ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  if (!ADMIN_ROUTE) missing.push("ADMIN_PATH");
  if (!supabase.isSupabaseConfigured()) missing.push("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    console.error(`[SECURITY] Missing required production configuration: ${missing.join(", ")}`);
    process.exit(1);
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
const tokenBlacklist = new Set();

// Rate limiting for administrative login attempts (Brute-Force Protection)
const loginAttempts = new Map(); // key -> { count, firstAttempt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Contact form: newest-first in-memory ring, durable JSONL log, per-IP window.
const contactMessages = [];
const contactAttempts = new Map(); // ip -> [timestamps]
const CONTACT_LIMIT = 5;
const CONTACT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const contactLogPath = path.join(dataDir, "contact-messages.jsonl");

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
    const state = await redis.getRateLimitState(`admin-login:${crypto.createHash("sha256").update(key).digest("hex")}`);
    if (state && state.count >= MAX_FAILED_ATTEMPTS && state.ttl > 0) {
      return { allowed: false, error: `Too many failed attempts. Locked for ${state.ttl}s.` };
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

// Helper: Client IP detection with proxy support
function getClientIp(req) {
  const headers = req?.headers || {};
  const candidates = [
    headers["x-vercel-forwarded-for"],
    headers["cf-connecting-ip"],
    headers["x-real-ip"],
    headers["x-forwarded-for"],
    headers["true-client-ip"]
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const first = String(raw).split(",")[0].trim();
    if (first) {
      const normalized = first.replace(/^\[|\]$/g, "");
      if (isIP(normalized)) return normalized;
    }
  }
  const remote = req?.socket?.remoteAddress || "unknown";
  return isIP(remote) ? remote : String(remote);
}

// Helper: JSON Body parser with size limit (DoS protection)
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error("Request body exceeds 1MB limit"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

// Helper: Verify JWT token from Authorization header, revocation store, and session version.
async function verifyAdminToken(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || tokenBlacklist.has(token)) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_ISSUER
    });

    // Revocation check is best-effort and strictly time-bounded. A slow Redis
    // connection must not make a valid JWT appear to expire.
    const revoked = await Promise.race([
      redis.isAdminTokenRevoked(token).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500))
    ]);
    if (revoked) return null;

    // Do not make JWT validity depend on a Redis session-version read.
    // Redis can become ready/ready-again after a token is issued, which can
    // otherwise cause valid sessions to be rejected ~20-30 seconds later.
    // JWT signature/expiry + explicit token revocation remain the auth boundary.
    return { ...decoded, token };
  } catch (err) {
    return null;
  }
}

// Helper: Sanitize external URLs against XSS / protocol manipulation
function sanitizeUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return "";
  const trimmed = urlString.trim();
  if (/^(https?:\/\/|\/)/i.test(trimmed)) {
    return trimmed;
  }
  return "";
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
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Origin-Agent-Cluster", "?1");
  res.setHeader("Cache-Control", isAdminRequest ? "no-store" : "no-cache");
  if (isHttps) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }

  const supabaseOrigin = (() => {
    try {
      return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : "";
    } catch (_) {
      return "";
    }
  })();

  const adminConnectSrc = ["'self'", supabaseOrigin].filter(Boolean).join(" ");

  const adminCsp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
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
    "frame-ancestors 'none'",
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
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(obj));
  };

  // --------------------------------------------------
  // ADMIN DASHBOARD HTML & AUTH
  // --------------------------------------------------

  // Never expose an admin login at the predictable /admin URL.
  if (requestPath === "/admin" || requestPath === "/admin/" || requestPath === "/admin/index.html") {
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
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });
      res.end(data);
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

      // Check database admins first, fallback to env ADMIN_USERNAME
      const dbAdmin = await supabase.getAdminByUsername(username);
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
        const token = jwt.sign(
          {
            id: adminId,
            username,
            email,
            role: userRole,
            permissions: ROLE_PERMISSIONS[userRole] || []
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
      return sendJson(400, { error: e.message || "Login request error" });
    }
  }

  // Admin Logout (Invalidates JWT Session)
  if (requestPath === "/api/admin/logout" && req.method === "POST") {
    const admin = await verifyAdminToken(req);
    if (admin && admin.token) {
      tokenBlacklist.add(admin.token);
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
        onlineCount: uniqueIps.size,
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
      if (body.title !== undefined) updates.title = String(body.title).trim() || "Untitled Campaign";
      if (body.link_url !== undefined) updates.link_url = sanitizeUrl(body.link_url);
      if (body.media_url !== undefined) {
        updates.media_url = sanitizeUrl(body.media_url);
        updates.media_type = updates.media_url.match(/\.(mp4|webm|ogg)$/i) ? "video" : "image";
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
          connectedAt: client.connectedAt
        });
      }
      return sendJson(200, { clients: list });
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
      await supabase.markReportsBannedByIp(ip, `Banned by ${admin.username}: ${reason}`);

      for (const client of connectedClients) {
        if (client.ip === ip) {
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
      if (!ip || !isIP(String(ip).trim())) return sendJson(400, { error: "A valid IP address is required" });
      const cleanIp = String(ip).trim();

      await supabase.removeBan(cleanIp);
      await redis.removeBannedIp(cleanIp);
      await supabase.logAction("UNBAN_IP", { ip }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `IP ${ip} unbanned` });
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
      if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
        return sendJson(400, { error: "Password must be at least 12 characters and include uppercase, lowercase, number, and symbol." });
      }
      const salt = bcrypt.genSaltSync(12);
      const hash = bcrypt.hashSync(password, salt);

      const created = await supabase.createAdminAccount({
        username: username.trim(),
        email: (email || "").trim(),
        role: role || "moderator",
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

      // Fetch user from DB/store
      const user = await supabase.getAdminByUsername(admin.username);
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
    const ua = req.headers["user-agent"] || "";
    supabase.recordAdClick(adId, ip, ua);
    redis.incrementMetric("adClicks");
    return sendJson(200, { success: true });
  }

  // --------------------------------------------------
  // CONTACT FORM (public)
  // --------------------------------------------------

  if (requestPath === "/api/contact" && req.method === "POST") {
    const clientIp = getClientIp(req);
    const now = Date.now();

    const priorAttempts = (contactAttempts.get(clientIp) || []).filter(
      (timestamp) => now - timestamp < CONTACT_WINDOW_MS
    );

    if (priorAttempts.length >= CONTACT_LIMIT) {
      return sendJson(429, { error: "Too many messages. Please wait a few minutes." });
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      return sendJson(400, { error: "Invalid request body" });
    }

    // Honeypot filled: acknowledge like success, store nothing.
    if (body.website) {
      return sendJson(200, { ok: true });
    }

    const topic = String(body.topic || "");
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();
    const name = String(body.name || "").trim();

    if (!["general", "broken", "press"].includes(topic)) {
      return sendJson(400, { error: "Choose what the message is about" });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(400, { error: "A valid reply address is required" });
    }

    if (message.length < 10 || message.length > 2000) {
      return sendJson(400, { error: "Message must be between 10 and 2000 characters" });
    }

    if (name.length > 100) {
      return sendJson(400, { error: "Name must be at most 100 characters" });
    }

    priorAttempts.push(now);
    contactAttempts.set(clientIp, priorAttempts);

    const record = {
      id: crypto.randomUUID(),
      topic,
      email,
      ...(name ? { name } : {}),
      message,
      ip: clientIp,
      receivedAt: new Date().toISOString()
    };

    contactMessages.unshift(record);
    if (contactMessages.length > 500) contactMessages.length = 500;

    // Durable copy outside public/, one JSON line per message.
    fs.appendFile(contactLogPath, JSON.stringify(record) + "\n", (writeError) => {
      if (writeError) {
        console.error("[contact] could not persist message:", writeError.message);
      }
    });
    console.log("[contact] message", record.id, "topic:", topic, "from:", email);

    return sendJson(200, { ok: true });
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

  if (ALLOWED_ORIGINS.size === 0) return true;
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

function broadcastOnlineCount() {
  const uniqueIps = new Set();
  for (const client of connectedClients) {
    if (client.ip) uniqueIps.add(client.ip);
    else uniqueIps.add(client.id);
  }

  const message = {
    type: "online-count",
    count: uniqueIps.size
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

    outer:
    for (let i = 0; i < waitingClients.length - 1; i++) {
      for (let j = i + 1; j < waitingClients.length; j++) {
        if (areMatchCompatible(waitingClients[i], waitingClients[j])) {
          pairA = i;
          pairB = j;
          break outer;
        }
      }
    }

    // Everyone currently waiting is mutually blocked (for example, two users
    // who just reported each other). Leave them waiting for a different user.
    if (pairA === -1) break;

    const clientB = waitingClients.splice(pairB, 1)[0];
    const clientA = waitingClients.splice(pairA, 1)[0];

    if (!areMatchCompatible(clientA, clientB)) continue;

    clientA.peer = clientB;
    clientB.peer = clientA;

    redis.incrementMetric("matchesCompleted");

    send(clientA, { type: "matched", role: "caller" });
    send(clientB, { type: "matched", role: "callee" });

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
  if (adminRealtimeChannelStarted || !supabase.isSupabaseConfigured()) return;
  adminRealtimeChannelStarted = true;
  const subscribe = supabase.subscribeToAdminRealtime((event) => {
    broadcastAdminRealtime(event);
  });
  if (subscribe && typeof subscribe.catch === "function") {
    subscribe.catch((error) => {
      adminRealtimeChannelStarted = false;
      console.warn("[SUPABASE] Admin Realtime subscription failed:", error.message);
    });
  }
}

wss.on("connection", async (socket, request) => {
  if (!isAllowedWebSocketOrigin(request)) {
    try { socket.close(1008, "Origin not allowed"); } catch (_) {}
    return;
  }

  const requestPath = String(request.url || "").split("?")[0];
  if (requestPath === "/__admin-realtime") {
    socket.isAdminRealtime = true;
    socket.authenticatedAdmin = null;
    adminRealtimeClients.add(socket);
    initAdminSupabaseRealtime();

    socket.on("message", async (rawMessage) => {
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
          socket.send(JSON.stringify({ type: "admin-auth-ok", user: { id: admin.id, username: admin.username, role: admin.role } }));
        }
      } catch (_) {}
    });

    socket.on("close", () => {
      adminRealtimeClients.delete(socket);
    });
    socket.on("error", () => {
      adminRealtimeClients.delete(socket);
    });
    return;
  }

  const clientIp = getClientIp(request);

  // Rapid ban verification. Redis is the fast path; Supabase is a bounded
  // secondary check so a transient DB outage never crashes the WebSocket.
  let banned = false;
  try {
    banned = await redis.isIpBannedFast(clientIp);
  } catch (_) {}
  if (!banned) {
    try {
      banned = await Promise.race([
        supabase.isIpBanned(clientIp).catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 1500))
      ]);
    } catch (_) {}
  }
  if (banned) {
    send(socket, { type: "banned", reason: "Access suspended due to community guidelines violation." });
    setTimeout(() => {
      try { socket.close(); } catch (e) {}
    }, 200);
    return;
  }

  socket.id = nextClientId++;
  socket.ip = clientIp;
  socket.connectedAt = Date.now();
  socket.ready = false;
  socket.peer = null;
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

  socket.on("message", async (rawMessage) => {
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
        if (socket.blockedPeerIps && oldPeer.ip) socket.blockedPeerIps.add(oldPeer.ip);
        if (oldPeer.blockedPeerIps && socket.ip) oldPeer.blockedPeerIps.add(socket.ip);
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
        reporterIp: socket.ip,
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

    if (
      message.type === "record-request" ||
      message.type === "record-response" ||
      message.type === "recording-started" ||
      message.type === "recording-paused" ||
      message.type === "recording-stopped" ||
      message.type === "offer" ||
      message.type === "answer" ||
      message.type === "ice-candidate"
    ) {
      if (socket.peer && socket.peer.readyState === WebSocket.OPEN) {
        send(socket.peer, message);
      }
      return;
    }
  });

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
});

// ==================================================
// START SERVER
// ==================================================

initAdminSupabaseRealtime();

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
});
