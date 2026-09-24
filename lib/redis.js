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
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy(times) {
        if (times > 1) {
          console.warn("[REDIS] Operating with optimized in-memory store.");
          return null;
        }
        return 200;
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
  publishEvent
};
