const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// Bound all Supabase HTTP requests so a transient network problem cannot hang
// an admin login or WebSocket-related request for the lifetime of a Vercel invocation.
const SUPABASE_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.SUPABASE_FETCH_TIMEOUT_MS || 8000));
const nativeFetch = globalThis.fetch;
async function supabaseFetch(input, init = {}) {
  if (typeof nativeFetch !== "function") return nativeFetch(input, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS);
  try {
    const nextInit = { ...init, signal: init.signal || controller.signal };
    return await nativeFetch(input, nextInit);
  } finally {
    clearTimeout(timer);
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const isProduction =
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
const supabaseKey = isProduction
  ? process.env.SUPABASE_SERVICE_ROLE_KEY
  : (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

let supabase = null;
let isConfigured = false;
let adminRealtimeChannel = null;

// In-memory fallback store when Supabase is not configured
// Initialized with standard roles and starter ads
const inMemoryStore = {
  reports: [],
  bans: new Map(), // ip -> ban object
  admins: [
    {
      id: "admin-super",
      username: process.env.ADMIN_USERNAME || "admin",
      email: "admin@lela.chat",
      password_hash: null, // checked via ADMIN_PASSWORD in server.js or bcrypt
      role: "superadmin", // Roles: 'superadmin', 'admin', 'moderator', 'ads_manager'
      is_active: true,
      created_at: new Date().toISOString()
    },
    {
      id: "admin-mod-1",
      username: "moderator1",
      email: "mod@lela.chat",
      password_hash: null,
      role: "moderator",
      is_active: true,
      created_at: new Date().toISOString()
    },
    {
      id: "admin-ads-1",
      username: "growth_lead",
      email: "ads@lela.chat",
      password_hash: null,
      role: "ads_manager",
      is_active: true,
      created_at: new Date().toISOString()
    }
  ],
  ads: [
    {
      id: "ad_starter_1",
      title: "LELA Pro Streaming Pass",
      body: "Unlock HD 1080p video, spatial audio, and zero wait times.",
      cta_text: "Get Pass ↗",
      media_url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80",
      media_type: "image",
      link_url: "https://example.com/lela-pro",
      placement: "stranger-overlay",
      device_target: "all",
      rotation_seconds: 12,
      priority: 10,
      active: true,
      impressions: 1420,
      clicks: 86,
      created_by: "system",
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: "ad_starter_2",
      title: "Ultra Low-Latency Noise Cancelling Mic",
      body: "Crystal clear audio hardware tuned for video chatting.",
      cta_text: "Shop Now ↗",
      media_url: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800&auto=format&fit=crop&q=80",
      media_type: "image",
      link_url: "https://example.com/audio-gear",
      placement: "stranger-overlay",
      device_target: "all",
      rotation_seconds: 15,
      priority: 5,
      active: true,
      impressions: 890,
      clicks: 43,
      created_by: "system",
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
      updated_at: new Date().toISOString()
    }
  ],
  ad_settings: {
    enabled: true,
    defaultPlacement: "stranger-overlay", // 'stranger-overlay' | 'below-video' | 'corner'
    mobileDockStranger: true, // Auto-dock inside Stranger Video on mobile to never cover send button!
    rotationSeconds: 12,
    allowDismiss: true,
    redisplayOnRotate: true
  },
  ad_events: [],
  logs: [
    {
      id: "log_init",
      admin_id: "system",
      action: "SYSTEM_INITIALIZE",
      details: { message: "LELA engine online with RBAC & JWT security" },
      ip: "127.0.0.1",
      created_at: new Date().toISOString()
    }
  ]
};

if (supabaseUrl && supabaseKey && !supabaseUrl.includes("your-project")) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      global: { fetch: supabaseFetch }
    });
    isConfigured = true;
    console.log("[SUPABASE] Connected to database cluster:", supabaseUrl);
  } catch (error) {
    console.error("[SUPABASE] Initialization error:", error.message);
  }
} else {
  console.log("[SUPABASE] Running in-memory database store with full relational capabilities.");
}

function isSupabaseConfigured() {
  return isConfigured;
}

// --------------------------------------------------
// ADS MANAGEMENT (FAST QUERIES & ANALYTICS)
// --------------------------------------------------

async function getAds({ activeOnly = false } = {}) {
  if (isConfigured && supabase) {
    try {
      let query = supabase
        .from("ads")
        .select("*")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false });

      if (activeOnly) {
        query = query.eq("active", true);
      }

      const { data, error } = await query;
      if (!error && data) return data;
    } catch (err) {
      console.warn("[SUPABASE] getAds error:", err.message);
      if (isProduction) throw err;
    }
  }
  if (isProduction) return [];

  let list = inMemoryStore.ads;
  if (activeOnly) {
    list = list.filter((a) => a.active);
  }
  return [...list].sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

async function getActiveAds() {
  return getAds({ activeOnly: true });
}

async function getAdById(adId) {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("ads")
        .select("*")
        .eq("id", adId)
        .maybeSingle();
      if (!error && data) return data;
    } catch (err) {
      console.warn("[SUPABASE] getAdById error:", err.message);
      if (isProduction) throw err;
    }
  }
  if (isProduction) return null;
  return inMemoryStore.ads.find((a) => a.id === adId) || null;
}

async function addAd(adData) {
  const newAd = {
    id: crypto.randomUUID(),
    title: adData.title || "Untitled Ad",
    body: adData.body || "",
    cta_text: adData.cta_text || "Learn more ↗",
    media_url: adData.media_url,
    media_type: adData.media_type || "image",
    link_url: adData.link_url || "",
    placement: adData.placement || "stranger-overlay",
    device_target: adData.device_target || "all", // 'all' | 'mobile' | 'desktop'
    rotation_seconds: Math.max(3, parseInt(adData.rotation_seconds) || 12),
    priority: parseInt(adData.priority) || 1,
    active: adData.active !== false,
    impressions: 0,
    clicks: 0,
    created_by: adData.created_by || "admin",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("ads")
        .insert([newAd])
        .select()
        .single();
      if (!error && data) return data;
    } catch (err) {
      console.warn("[SUPABASE] addAd error:", err.message);
      if (isProduction) throw err;
    }
  }
  if (isProduction) throw new Error("Supabase is required in production");

  inMemoryStore.ads.unshift(newAd);
  return newAd;
}

async function updateAd(adId, updates) {
  const patch = {
    ...updates,
    updated_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("ads")
        .update(patch)
        .eq("id", adId)
        .select()
        .single();
      if (!error && data) return data;
    } catch (err) {
      console.warn("[SUPABASE] updateAd error:", err.message);
      if (isProduction) throw err;
    }
  }
  if (isProduction) return null;

  const ad = inMemoryStore.ads.find((a) => a.id === adId);
  if (ad) {
    Object.assign(ad, patch);
    return ad;
  }
  return null;
}

async function updateAdStatus(adId, active) {
  return updateAd(adId, { active });
}

async function deleteAd(adId) {
  if (isConfigured && supabase) {
    try {
      const { error } = await supabase.from("ads").delete().eq("id", adId);
      if (!error) return true;
    } catch (err) {
      console.warn("[SUPABASE] deleteAd error:", err.message);
      if (isProduction) throw err;
    }
  }
  if (isProduction) return false;

  const index = inMemoryStore.ads.findIndex((a) => a.id === adId);
  if (index !== -1) {
    inMemoryStore.ads.splice(index, 1);
    return true;
  }
  return false;
}

async function getAdSettings() {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase.from("system_settings").select("*").eq("key", "ad_settings").maybeSingle();
      if (error) throw error;
      if (data?.value) return data.value;
      return { ...inMemoryStore.ad_settings };
    } catch (err) {
      if (isProduction) throw err;
    }
  }
  if (isProduction) throw new Error("Supabase is required for ad settings");
  return { ...inMemoryStore.ad_settings };
}

async function updateAdSettings(updates) {
  const current = await getAdSettings();
  const merged = { ...current, ...updates, updated_at: new Date().toISOString() };

  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("system_settings")
      .upsert({ key: "ad_settings", value: merged })
      .select("key,value,updated_at")
      .single();
    if (error) throw error;
    return data?.value || merged;
  }

  if (isProduction) throw new Error("Supabase is required for ad settings");
  inMemoryStore.ad_settings = merged;
  return merged;
}

async function recordAdImpression(adId, ip = "unknown", userAgent = "") {
  if (!adId) return;

  if (isConfigured && supabase) {
    const { error } = await supabase.rpc("increment_ad_impressions", { p_ad_id: adId });
    if (error && isProduction) throw error;
    const { error: eventError } = await supabase
      .from("ad_events")
      .insert([{ ad_id: adId, event_type: "impression", client_ip: ip, user_agent: userAgent }]);
    if (eventError && isProduction) throw eventError;
    return;
  }

  if (isProduction) throw new Error("Supabase is required for ad analytics");
  const ad = inMemoryStore.ads.find((a) => a.id === adId);
  if (ad) ad.impressions = (ad.impressions || 0) + 1;
}

async function recordAdClick(adId, ip = "unknown", userAgent = "") {
  if (!adId) return;

  if (isConfigured && supabase) {
    const { error } = await supabase.rpc("increment_ad_clicks", { p_ad_id: adId });
    if (error && isProduction) throw error;
    const { error: eventError } = await supabase
      .from("ad_events")
      .insert([{ ad_id: adId, event_type: "click", client_ip: ip, user_agent: userAgent }]);
    if (eventError && isProduction) throw eventError;
    return;
  }

  if (isProduction) throw new Error("Supabase is required for ad analytics");
  const ad = inMemoryStore.ads.find((a) => a.id === adId);
  if (ad) ad.clicks = (ad.clicks || 0) + 1;
}

let adBucketReadyPromise = null;

async function ensureAdBucket(bucket) {
  if (adBucketReadyPromise) return adBucketReadyPromise;
  adBucketReadyPromise = (async () => {
    try {
      const { data, error } = await supabase.storage.getBucket(bucket);
      if (!error && data) return true;
      const message = String(error?.message || "").toLowerCase();
      const status = Number(error?.statusCode || error?.status || 0);
      if (!(status === 404 || message.includes("not found") || message.includes("does not exist"))) {
        throw error || new Error("Unable to inspect ad storage bucket");
      }
      const { error: createError } = await supabase.storage.createBucket(bucket, {
        public: true,
        fileSizeLimit: "20MB",
        allowedMimeTypes: [
          "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
          "video/mp4", "video/webm"
        ]
      });
      if (createError && !String(createError.message || "").toLowerCase().includes("already exists")) {
        throw createError;
      }
      return true;
    } catch (error) {
      adBucketReadyPromise = null;
      throw error;
    }
  })();
  return adBucketReadyPromise;
}

async function createSignedAdUpload(originalName, mimeType) {
  if (!isConfigured || !supabase) {
    if (isProduction) throw new Error("Supabase is required for ad media uploads");
    return null;
  }
  const bucket = process.env.SUPABASE_ADS_BUCKET || "ad-media";
  const ext = (require("path").extname(originalName || "").toLowerCase() || ".bin").replace(/[^.a-z0-9]/g, "");
  const objectPath = `ads/${crypto.randomUUID()}${ext}`;

  try {
    await ensureAdBucket(bucket);

    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(objectPath, { upsert: false });
    if (error) throw error;
    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    return {
      path: objectPath,
      token: data.token,
      signedUrl: data.signedUrl,
      publicUrl: publicData.publicUrl,
      bucket,
      mimeType
    };
  } catch (err) {
    console.warn("[SUPABASE] createSignedAdUpload:", err.message);
    throw err;
  }
}

async function deleteAdMediaIfUnused(mediaPath, deletedAdId) {
  if (!mediaPath || !isConfigured || !supabase) return false;
  const bucket = process.env.SUPABASE_ADS_BUCKET || "ad-media";
  try {
    const { data: refs, error: refError } = await supabase
      .from("ads")
      .select("id")
      .eq("media_path", mediaPath)
      .neq("id", deletedAdId);
    if (refError) throw refError;
    if (Array.isArray(refs) && refs.length > 0) return false;
    const { error } = await supabase.storage.from(bucket).remove([mediaPath]);
    return !error;
  } catch (err) {
    console.warn("[SUPABASE] deleteAdMediaIfUnused:", err.message);
    if (isProduction) throw err;
    return false;
  }
}

async function getAdAnalytics30d(days = 30) {
  if (!isConfigured || !supabase) {
    if (isProduction) throw new Error("Supabase is required for analytics");
    return { trends30Days: [] };
  }
  const { data, error } = await supabase.rpc("get_ad_analytics_30d", { p_days: Math.min(90, Math.max(1, Number(days) || 30)) });
  if (error) throw error;

  let cumulativeImpressions = 0;
  let cumulativeClicks = 0;
  const trends30Days = (Array.isArray(data) ? data : []).map((row, index) => {
    const dayImp = Number(row.daily_impressions || 0);
    const dayClicks = Number(row.daily_clicks || 0);
    cumulativeImpressions += dayImp;
    cumulativeClicks += dayClicks;
    const date = String(row.date);
    return {
      dayIndex: index,
      date,
      formattedDate: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      dailyImpressions: dayImp,
      cumulativeImpressions,
      dailyClicks: dayClicks,
      cumulativeClicks,
      ctr: dayImp > 0 ? ((dayClicks / dayImp) * 100).toFixed(2) + "%" : "0.00%"
    };
  });
  return { trends30Days };
}

// --------------------------------------------------
// ADMIN ACCOUNTS & RBAC
// --------------------------------------------------

async function getAdminByUsername(username) {
  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("admins")
      .select("*")
      .eq("username", username)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }
  if (isProduction) throw new Error("Supabase is required for admin authentication");
  return inMemoryStore.admins.find((a) => a.username.toLowerCase() === username.toLowerCase()) || null;
}

async function getAdmins() {
  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("admins")
      .select("id, username, email, role, is_active, last_login, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  if (isProduction) throw new Error("Supabase is required for admin data");
  return inMemoryStore.admins.map((a) => ({
    id:a.id, username:a.username, email:a.email, role:a.role, is_active:a.is_active, last_login:a.last_login, created_at:a.created_at
  }));
}

async function createAdminAccount({ username, email, role = "moderator", password_hash = "" }) {
  const newAdmin = {
    id: crypto.randomUUID(), username, email, password_hash, role, is_active: true,
    last_login: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  if (isConfigured && supabase) {
    const { data, error } = await supabase.from("admins").insert([newAdmin]).select().single();
    if (error) throw error;
    return data;
  }
  if (isProduction) throw new Error("Supabase is required for admin accounts");
  inMemoryStore.admins.push(newAdmin);
  return newAdmin;
}

async function getAdminById(id) {
  if (isConfigured && supabase) {
    const { data, error } = await supabase.from("admins").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  if (isProduction) throw new Error("Supabase is required for admin data");
  return inMemoryStore.admins.find((a) => a.id === id) || null;
}

async function deleteAdminAccount(id) {
  if (isConfigured && supabase) {
    const { error } = await supabase.from("admins").delete().eq("id", id);
    if (error) throw error;
    return true;
  }
  if (isProduction) throw new Error("Supabase is required for admin accounts");
  const idx = inMemoryStore.admins.findIndex((a) => a.id === id);
  if (idx !== -1) { inMemoryStore.admins.splice(idx, 1); return true; }
  return false;
}

async function updateAdminRole(id, role) {
  if (isConfigured && supabase) {
    const { data, error } = await supabase.from("admins").update({ role, updated_at:new Date().toISOString() }).eq("id", id).select().single();
    if (error) throw error;
    return data || null;
  }
  if (isProduction) throw new Error("Supabase is required for admin accounts");
  const admin = inMemoryStore.admins.find((a) => a.id === id);
  if (admin) { admin.role = role; return admin; }
  return null;
}

async function updateAdminPassword(id, password_hash) {
  if (isConfigured && supabase) {
    const { data, error } = await supabase.from("admins").update({ password_hash, updated_at:new Date().toISOString() }).eq("id", id).select().single();
    if (error) throw error;
    return data || null;
  }
  if (isProduction) throw new Error("Supabase is required for admin passwords");
  const admin = inMemoryStore.admins.find((a) => a.id === id);
  if (admin) { admin.password_hash = password_hash; return admin; }
  return null;
}



// --------------------------------------------------
// REPORTS
// --------------------------------------------------

async function saveReport({ reporterId, reportedId, reporterIp, reportedIp, reason }) {
  const normalizedReason = String(reason || "Unspecified").trim().slice(0, 100) || "Unspecified";
  if (isConfigured && supabase) {
    const cleanReporterIp = String(reporterIp || "unknown").trim() || "unknown";
    const cleanReportedIp = String(reportedIp || "unknown").trim() || "unknown";

    // Compatibility guard: do not allow one reporter IP to report the same
    // target IP more than once, even if they select a different reason.
    if (cleanReporterIp !== "unknown" && cleanReportedIp !== "unknown") {
      const { data: duplicateRows, error: duplicateError } = await supabase
        .from("reports")
        .select("id, report_count, unique_reporters_count")
        .eq("reported_ip", cleanReportedIp)
        .contains("reporter_ips", [cleanReporterIp])
        .limit(1);
      if (!duplicateError && duplicateRows && duplicateRows[0]) {
        return { id: duplicateRows[0].id, duplicate: true, reportCount: Number(duplicateRows[0].report_count || 1), uniqueReportersCount: Number(duplicateRows[0].unique_reporters_count || 1) };
      }
    }

    const { data, error } = await supabase.rpc("submit_report", {
      p_reporter_id: reporterId || null,
      p_reported_id: reportedId || null,
      p_reporter_ip: cleanReporterIp,
      p_reported_ip: cleanReportedIp,
      p_reason: normalizedReason
    });
    if (error) throw error;
    return {
      id: data?.report_id || null,
      duplicate: !!data?.duplicate,
      reportCount: Number(data?.report_count || 1),
      uniqueReportersCount: Number(data?.unique_reporters_count || 1),
      ipReportCount: Number(data?.ip_report_count || data?.report_count || 1),
      ipUniqueReportersCount: Number(data?.ip_unique_reporters_count || data?.unique_reporters_count || 1),
      reporterIp: cleanReporterIp,
      reportedIp: cleanReportedIp
    };
  }
  if (isProduction) throw new Error("Supabase is required for reports");

  const existing = inMemoryStore.reports.find((r) => r.reported_ip === (reportedIp || "unknown") && r.reason === normalizedReason);
  if (existing) {
    if (existing.reporter_ips?.includes(reporterIp)) {
      return { id: existing.id, duplicate: true, reportCount: existing.report_count, uniqueReportersCount: existing.unique_reporters_count };
    }
    existing.reporter_ips = [...(existing.reporter_ips || []), reporterIp];
    existing.report_count = (existing.report_count || 1) + 1;
    existing.unique_reporters_count = (existing.reporter_ips || []).length;
    existing.last_reported_at = new Date().toISOString();
    return { id: existing.id, duplicate: false, reportCount: existing.report_count, uniqueReportersCount: existing.unique_reporters_count };
  }

  const newReport = {
    id: crypto.randomUUID(),
    reporter_id: reporterId || null,
    reported_id: reportedId || null,
    reporter_ip: reporterIp || "unknown",
    reported_ip: reportedIp || "unknown",
    reason: normalizedReason,
    report_count: 1,
    unique_reporters_count: 1,
    reporter_ips: [reporterIp || "unknown"],
    status: "pending",
    action_notes: null,
    created_at: new Date().toISOString(),
    last_reported_at: new Date().toISOString()
  };
  inMemoryStore.reports.unshift(newReport);
  return { id: newReport.id, duplicate: false, reportCount: 1, uniqueReportersCount: 1 };
}

async function getReports({ status, limit = 50 } = {}) {
  if (isConfigured && supabase) {
    try {
      let query = supabase
        .from("reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (status && status !== "all") {
        query = query.eq("status", status);
      }

      const { data, error } = await query;
      if (!error && data) return data;
    } catch (err) {
      if (isProduction) throw err;
    }
  }
  if (isProduction) return [];

  let list = inMemoryStore.reports;
  if (status && status !== "all") {
    list = list.filter((r) => r.status === status);
  }
  return list.slice(0, limit);
}

async function updateReportStatus(reportId, status, actionNotes = "") {
  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("reports")
      .update({
        status,
        action_notes: actionNotes,
        resolved_at: new Date().toISOString()
      })
      .eq("id", reportId)
      .select()
      .single();
    if (error) throw error;
    return data || null;
  }
  if (isProduction) throw new Error("Supabase is required for report moderation");
  const report = inMemoryStore.reports.find((r) => r.id === reportId);
  if (report) {
    report.status = status;
    report.action_notes = actionNotes;
    report.resolved_at = new Date().toISOString();
    return report;
  }
  return null;
}

// --------------------------------------------------
// BANS
// --------------------------------------------------

async function addBan({ ip, reason, bannedBy = "admin", durationHours = null }) {
  const expiresAt = durationHours
    ? new Date(Date.now() + durationHours * 3600 * 1000).toISOString()
    : null;

  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("bans")
      .upsert(
        {
          ip,
          reason: reason || "Violation of terms",
          banned_by: bannedBy,
          banned_at: new Date().toISOString(),
          expires_at: expiresAt
        },
        { onConflict: "ip" }
      )
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  if (isProduction) throw new Error("Supabase is required for bans");
  const banRecord = {
    id: "ban_" + Date.now(), ip, reason: reason || "Violation of terms",
    banned_by: bannedBy, banned_at: new Date().toISOString(), expires_at: expiresAt
  };
  inMemoryStore.bans.set(ip, banRecord);
  return banRecord;
}

async function removeBan(ip) {
  if (isConfigured && supabase) {
    const { error } = await supabase.from("bans").delete().eq("ip", ip);
    if (error) throw error;
    return true;
  }
  if (isProduction) throw new Error("Supabase is required for bans");
  return inMemoryStore.bans.delete(ip);
}

async function getBans() {
  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("bans")
      .select("*")
      .order("banned_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  if (isProduction) throw new Error("Supabase is required for bans");
  return Array.from(inMemoryStore.bans.values());
}

async function isIpBanned(ip) {
  if (!ip) return false;

  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("bans")
      .select("id, expires_at")
      .eq("ip", ip)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      if (data.expires_at && new Date(data.expires_at) < new Date()) {
        await removeBan(ip);
        return false;
      }
      return true;
    }
    return false;
  }

  if (isProduction) throw new Error("Supabase is required for ban checks");
  const localBan = inMemoryStore.bans.get(ip);
  if (localBan) {
    if (localBan.expires_at && new Date(localBan.expires_at) < new Date()) {
      inMemoryStore.bans.delete(ip);
      return false;
    }
    return true;
  }
  return false;
}

// --------------------------------------------------
// AUDIT LOGS
// --------------------------------------------------

async function logAction(action, details = {}, adminId = "admin", ip = "unknown") {
  const logItem = {
    id: "log_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
    admin_id: adminId, action, details, ip, created_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    const { error } = await supabase.from("system_logs").insert([{ admin_id: adminId, action, details, ip }]);
    if (error) throw error;
    return;
  }
  if (isProduction) throw new Error("Supabase is required for audit logs");
  inMemoryStore.logs.unshift(logItem);
  if (inMemoryStore.logs.length > 300) inMemoryStore.logs.pop();
}

async function getLogs(limit = 100) {
  if (isConfigured && supabase) {
    const { data, error } = await supabase
      .from("system_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
  if (isProduction) throw new Error("Supabase is required for audit logs");
  return inMemoryStore.logs.slice(0, limit);
}

async function subscribeToAdminRealtime(onEvent) {
  if (!isConfigured || !supabase || typeof onEvent !== "function") return null;
  if (adminRealtimeChannel) return adminRealtimeChannel;

  adminRealtimeChannel = supabase
    .channel("lela-admin-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "reports" }, (payload) => onEvent({ table: "reports", eventType: payload.eventType, record: payload.new || null, oldRecord: payload.old || null }))
    .on("postgres_changes", { event: "*", schema: "public", table: "ads" }, (payload) => onEvent({ table: "ads", eventType: payload.eventType, record: payload.new || null, oldRecord: payload.old || null }))
    .on("postgres_changes", { event: "*", schema: "public", table: "bans" }, (payload) => onEvent({ table: "bans", eventType: payload.eventType, record: payload.new || null, oldRecord: payload.old || null }))
    .on("postgres_changes", { event: "*", schema: "public", table: "ad_events" }, (payload) => onEvent({ table: "ad_events", eventType: payload.eventType, record: payload.new || null, oldRecord: payload.old || null }))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("[SUPABASE] Admin Realtime subscribed.");
    });

  return adminRealtimeChannel;
}

async function getReportById(reportId) {
  if (isConfigured && supabase) {
    const { data, error } = await supabase.from("reports").select("*").eq("id", reportId).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  if (isProduction) throw new Error("Supabase is required for report lookup");
  return inMemoryStore.reports.find((r) => String(r.id) === String(reportId)) || null;
}

async function markReportsBannedByIp(ip, actionNotes = "") {
  const cleanIp = String(ip || "").trim();
  if (!cleanIp) return 0;
  if (isConfigured && supabase) {
    const { data, error } = await supabase.from("reports").update({ status: "banned", action_notes: actionNotes, resolved_at: new Date().toISOString() }).eq("reported_ip", cleanIp).select("id");
    if (error) throw error;
    return Array.isArray(data) ? data.length : 0;
  }
  if (isProduction) throw new Error("Supabase is required for report moderation");
  let count = 0;
  for (const report of inMemoryStore.reports) {
    if (report.reported_ip === cleanIp) {
      report.status = "banned";
      report.action_notes = actionNotes;
      report.resolved_at = new Date().toISOString();
      count++;
    }
  }
  return count;
}

module.exports = {
  isSupabaseConfigured,
  getAds,
  getActiveAds,
  createSignedAdUpload,
  deleteAdMediaIfUnused,
  getAdAnalytics30d,
  getAdById,
  addAd,
  updateAd,
  updateAdStatus,
  deleteAd,
  getAdSettings,
  updateAdSettings,
  recordAdImpression,
  recordAdClick,
  subscribeToAdminRealtime,
  getReportById,
  markReportsBannedByIp,
  getAdminByUsername,
  getAdminById,
  getAdmins,
  createAdminAccount,
  updateAdminRole,
  updateAdminPassword,
  deleteAdminAccount,
  saveReport,
  getReports,
  updateReportStatus,
  addBan,
  removeBan,
  getBans,
  isIpBanned,
  logAction,
  getLogs
};
