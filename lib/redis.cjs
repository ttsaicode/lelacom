const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL;

let redisClient = null;
let isConfigured = false;

// Fast in-memory fallback with indexing
const inMemoryCache = {
  bannedIps: new Set(),
  activeClients: new Map(), // clientId -> { id, ip, connectedAt }
  stats: {
    totalConnectionsEver: 0,
    matchesCompleted: 0,
    chatMessagesSent: 0,
    reportsReceived: 0,
    adImpressions: 0,
    adClicks: 0
  }
};

if (redisUrl && !redisUrl.includes("example")) {
  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 3) {
          console.warn("[REDIS] Max retries reached. Operating with optimized in-memory store.");
          return null;
        }
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true
    });

    redisClient
      .connect()
      .then(() => {
        isConfigured = true;
        console.log("[REDIS] Connected to Redis cluster/instance.");
      })
      .catch((err) => {
        console.warn("[REDIS] Connection failed:", err.message, "- using optimized in-memory store.");
      });

    redisClient.on("error", (err) => {
      // Prevent unhandled exception
    });
  } catch (error) {
    console.warn("[REDIS] Initialization failed:", error.message);
  }
} else {
  console.log("[REDIS] REDIS_URL not configured. Running high-performance in-memory cache.");
}

function isRedisConfigured() {
  return isConfigured && redisClient && redisClient.status === "ready";
}


function hashValue(value) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function getRateLimitState(key) {
  if (isRedisConfigured()) {
    try {
      const [count, ttl] = await Promise.all([
        redisClient.get(key),
        redisClient.ttl(key)
      ]);
      return { count: Number(count || 0), ttl: Number(ttl || 0) };
    } catch (e) {}
  }
  return null;
}

async function recordRateLimitFailure(key, windowSeconds = 900) {
  if (!isRedisConfigured()) return;
  try {
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, windowSeconds);
    }
  } catch (e) {}
}

async function resetRateLimit(key) {
  if (!isRedisConfigured()) return;
  try { await redisClient.del(key); } catch (e) {}
}

const localRevokedTokens = new Map();
const localSessionVersions = new Map();

async function revokeAdminToken(token, exp) {
  if (!token) return;
  const hash = hashValue(token);
  const ttl = Math.max(1, Number(exp || 0) - Math.floor(Date.now() / 1000));
  localRevokedTokens.set(hash, Date.now() + ttl * 1000);
  if (isRedisConfigured()) {
    try { await redisClient.set(`admin:revoked:${hash}`, "1", "EX", ttl); } catch (e) {}
  }
}

async function isAdminTokenRevoked(token) {
  if (!token) return true;
  const hash = hashValue(token);
  const localExpiry = localRevokedTokens.get(hash);
  if (localExpiry) {
    if (Date.now() < localExpiry) return true;
    localRevokedTokens.delete(hash);
  }
  if (isRedisConfigured()) {
    try {
      const value = await redisClient.get(`admin:revoked:${hash}`);
      if (value) return true;
    } catch (e) {}
  }
  return false;
}

async function getAdminSessionVersion(adminId) {
  const key = `admin:session-version:${adminId || "admin-root"}`;
  if (isRedisConfigured()) {
    try {
      const value = await redisClient.get(key);
      if (value === null) {
        await redisClient.set(key, "1");
        return 1;
      }
      return Math.max(1, Number(value) || 1);
    } catch (e) {}
  }
  if (!localSessionVersions.has(key)) localSessionVersions.set(key, 1);
  return localSessionVersions.get(key);
}

async function bumpAdminSessionVersion(adminId) {
  const key = `admin:session-version:${adminId || "admin-root"}`;
  if (isRedisConfigured()) {
    try {
      const next = await redisClient.incr(key);
      return next;
    } catch (e) {}
  }
  const next = (localSessionVersions.get(key) || 1) + 1;
  localSessionVersions.set(key, next);
  return next;
}

async function addBannedIp(ip) {
  if (!ip) return;
  inMemoryCache.bannedIps.add(ip);
  if (isRedisConfigured()) {
    try {
      await redisClient.sadd("bans:ip", ip);
    } catch (e) {
      console.warn("[REDIS] sadd error:", e.message);
    }
  }
}

async function removeBannedIp(ip) {
  if (!ip) return;
  inMemoryCache.bannedIps.delete(ip);
  if (isRedisConfigured()) {
    try {
      await redisClient.srem("bans:ip", ip);
    } catch (e) {
      console.warn("[REDIS] srem error:", e.message);
    }
  }
}

async function isIpBannedFast(ip) {
  if (!ip) return false;
  if (inMemoryCache.bannedIps.has(ip)) return true;

  if (isRedisConfigured()) {
    try {
      const isMember = await redisClient.sismember("bans:ip", ip);
      if (isMember) {
        inMemoryCache.bannedIps.add(ip);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function trackClient(clientId, ip) {
  const info = { id: clientId, ip, connectedAt: Date.now() };
  inMemoryCache.activeClients.set(clientId, info);
  inMemoryCache.stats.totalConnectionsEver++;

  if (isRedisConfigured()) {
    try {
      await redisClient.hset("clients:active", clientId, JSON.stringify(info));
      await redisClient.incr("stats:totalConnectionsEver");
    } catch (e) {}
  }
}

async function removeClient(clientId) {
  inMemoryCache.activeClients.delete(clientId);

  if (isRedisConfigured()) {
    try {
      await redisClient.hdel("clients:active", clientId);
    } catch (e) {}
  }
}

async function getActiveClients() {
  if (isRedisConfigured()) {
    try {
      const hash = await redisClient.hgetall("clients:active");
      const list = Object.values(hash).map((val) => {
        try {
          return JSON.parse(val);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return list;
    } catch (e) {}
  }
  return Array.from(inMemoryCache.activeClients.values());
}

function incrementMetric(metricName, amount = 1) {
  if (inMemoryCache.stats[metricName] !== undefined) {
    inMemoryCache.stats[metricName] += amount;
  }
  if (isRedisConfigured()) {
    try {
      redisClient.incrby(`stats:${metricName}`, amount).catch(() => {});
    } catch (e) {}
  }
}

function getEngagementMetrics() {
  return { ...inMemoryCache.stats };
}

async function publishEvent(channel, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  if (isRedisConfigured()) {
    try {
      await redisClient.publish(channel, payload);
    } catch (e) {}
  }
}

module.exports = {
  isRedisConfigured,
  addBannedIp,
  removeBannedIp,
  isIpBannedFast,
  trackClient,
  removeClient,
  getActiveClients,
  incrementMetric,
  getEngagementMetrics,
  publishEvent,
  getRateLimitState,
  recordRateLimitFailure,
  resetRateLimit,
  revokeAdminToken,
  isAdminTokenRevoked,
  getAdminSessionVersion,
  bumpAdminSessionVersion
};
