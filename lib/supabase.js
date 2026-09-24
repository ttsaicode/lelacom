const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
let isConfigured = false;

// In-memory fallback store when Supabase is not configured
// Initialized with standard roles and starter ads
const inMemoryStore = {
  reports: [
    {
      id: "rep_sample_1",
      reporter_id: 104,
      reported_id: 109,
      reporter_ip: "192.168.1.102",
      reported_ip: "10.0.0.88",
      reason: "Spam / Advertising",
      status: "pending",
      action_notes: null,
      created_at: new Date(Date.now() - 1000 * 60 * 15).toISOString()
    }
  ],
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
      media_url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80",
      media_type: "image",
      link_url: "https://example.com/lela-pro",
      placement: "below-video",
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
      media_url: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=800&auto=format&fit=crop&q=80",
      media_type: "image",
      link_url: "https://example.com/audio-gear",
      placement: "corner",
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
      auth: { persistSession: false }
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
    }
  }

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
    }
  }
  return inMemoryStore.ads.find((a) => a.id === adId) || null;
}

async function addAd(adData) {
  const newAd = {
    id: "ad_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
    title: adData.title || "Untitled Ad",
    media_url: adData.media_url,
    media_type: adData.media_type || "image",
    link_url: adData.link_url || "",
    placement: adData.placement || "below-video",
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
    }
  }

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
    }
  }

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
    }
  }

  const index = inMemoryStore.ads.findIndex((a) => a.id === adId);
  if (index !== -1) {
    inMemoryStore.ads.splice(index, 1);
    return true;
  }
  return false;
}

async function recordAdImpression(adId, ip = "unknown", userAgent = "") {
  if (!adId) return;

  if (isConfigured && supabase) {
    try {
      // Async fire-and-forget for low latency
      supabase.rpc("increment_ad_impressions", { p_ad_id: adId }).catch(() => {});
      supabase
        .from("ad_events")
        .insert([{ ad_id: adId, event_type: "impression", client_ip: ip, user_agent: userAgent }])
        .catch(() => {});
    } catch (e) {}
  }

  const ad = inMemoryStore.ads.find((a) => a.id === adId);
  if (ad) {
    ad.impressions = (ad.impressions || 0) + 1;
  }
  inMemoryStore.ad_events.push({
    ad_id: adId,
    event_type: "impression",
    client_ip: ip,
    created_at: new Date().toISOString()
  });
  if (inMemoryStore.ad_events.length > 5000) {
    inMemoryStore.ad_events.splice(0, 1000);
  }
}

async function recordAdClick(adId, ip = "unknown", userAgent = "") {
  if (!adId) return;

  if (isConfigured && supabase) {
    try {
      supabase.rpc("increment_ad_clicks", { p_ad_id: adId }).catch(() => {});
      supabase
        .from("ad_events")
        .insert([{ ad_id: adId, event_type: "click", client_ip: ip, user_agent: userAgent }])
        .catch(() => {});
    } catch (e) {}
  }

  const ad = inMemoryStore.ads.find((a) => a.id === adId);
  if (ad) {
    ad.clicks = (ad.clicks || 0) + 1;
  }
  inMemoryStore.ad_events.push({
    ad_id: adId,
    event_type: "click",
    client_ip: ip,
    created_at: new Date().toISOString()
  });
}

// --------------------------------------------------
// ADMIN ACCOUNTS & RBAC
// --------------------------------------------------

async function getAdminByUsername(username) {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("admins")
        .select("*")
        .eq("username", username)
        .maybeSingle();
      if (!error && data) return data;
    } catch (err) {}
  }
  return inMemoryStore.admins.find((a) => a.username.toLowerCase() === username.toLowerCase()) || null;
}

async function getAdmins() {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("admins")
        .select("id, username, email, role, is_active, last_login, created_at")
        .order("created_at", { ascending: false });
      if (!error && data) return data;
    } catch (err) {}
  }
  return inMemoryStore.admins.map((a) => ({
    id: a.id,
    username: a.username,
    email: a.email,
    role: a.role,
    is_active: a.is_active,
    last_login: a.last_login,
    created_at: a.created_at
  }));
}

async function createAdminAccount({ username, email, role = "moderator", password_hash = "" }) {
  const newAdmin = {
    id: "adm_" + Date.now(),
    username,
    email,
    password_hash,
    role,
    is_active: true,
    last_login: null,
    created_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase.from("admins").insert([newAdmin]).select().single();
      if (!error && data) return data;
    } catch (err) {}
  }

  inMemoryStore.admins.push(newAdmin);
  return newAdmin;
}

async function getAdminById(id) {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase.from("admins").select("*").eq("id", id).single();
      if (!error && data) return data;
    } catch (err) {}
  }
  return inMemoryStore.admins.find((a) => a.id === id) || null;
}

async function deleteAdminAccount(id) {
  if (isConfigured && supabase) {
    try {
      const { error } = await supabase.from("admins").delete().eq("id", id);
      if (!error) return true;
    } catch (err) {}
  }
  const idx = inMemoryStore.admins.findIndex((a) => a.id === id);
  if (idx !== -1) {
    inMemoryStore.admins.splice(idx, 1);
    return true;
  }
  return false;
}

async function updateAdminRole(id, role) {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase.from("admins").update({ role }).eq("id", id).select().single();
      if (!error && data) return data;
    } catch (err) {}
  }
  const admin = inMemoryStore.admins.find((a) => a.id === id);
  if (admin) {
    admin.role = role;
    return admin;
  }
  return null;
}

async function updateAdminPassword(id, password_hash) {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase.from("admins").update({ password_hash }).eq("id", id).select().single();
      if (!error && data) return data;
    } catch (err) {}
  }
  const admin = inMemoryStore.admins.find((a) => a.id === id);
  if (admin) {
    admin.password_hash = password_hash;
    return admin;
  }
  return null;
}

// --------------------------------------------------
// REPORTS
// --------------------------------------------------

async function saveReport({ reporterId, reportedId, reporterIp, reportedIp, reason }) {
  const newReport = {
    id: "rep_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    reporter_id: reporterId || null,
    reported_id: reportedId || null,
    reporter_ip: reporterIp || "unknown",
    reported_ip: reportedIp || "unknown",
    reason: reason || "Unspecified",
    status: "pending",
    action_notes: null,
    created_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("reports")
        .insert([
          {
            reporter_id: reporterId,
            reported_id: reportedId,
            reporter_ip: reporterIp,
            reported_ip: reportedIp,
            reason: reason,
            status: "pending"
          }
        ])
        .select()
        .single();

      if (!error && data) return data;
    } catch (err) {}
  }

  inMemoryStore.reports.unshift(newReport);
  if (inMemoryStore.reports.length > 500) {
    inMemoryStore.reports.pop();
  }
  return newReport;
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
    } catch (err) {}
  }

  let list = inMemoryStore.reports;
  if (status && status !== "all") {
    list = list.filter((r) => r.status === status);
  }
  return list.slice(0, limit);
}

async function updateReportStatus(reportId, status, actionNotes = "") {
  if (isConfigured && supabase) {
    try {
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

      if (!error && data) return data;
    } catch (err) {}
  }

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

  const banRecord = {
    id: "ban_" + Date.now(),
    ip,
    reason: reason || "Violation of terms",
    banned_by: bannedBy,
    banned_at: new Date().toISOString(),
    expires_at: expiresAt
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bans")
        .upsert(
          {
            ip,
            reason: banRecord.reason,
            banned_by: bannedBy,
            banned_at: banRecord.banned_at,
            expires_at: expiresAt
          },
          { onConflict: "ip" }
        )
        .select()
        .single();

      if (!error && data) return data;
    } catch (err) {}
  }

  inMemoryStore.bans.set(ip, banRecord);
  return banRecord;
}

async function removeBan(ip) {
  if (isConfigured && supabase) {
    try {
      const { error } = await supabase.from("bans").delete().eq("ip", ip);
      if (!error) return true;
    } catch (err) {}
  }
  return inMemoryStore.bans.delete(ip);
}

async function getBans() {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bans")
        .select("*")
        .order("banned_at", { ascending: false });

      if (!error && data) return data;
    } catch (err) {}
  }
  return Array.from(inMemoryStore.bans.values());
}

async function isIpBanned(ip) {
  if (!ip) return false;

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bans")
        .select("id, expires_at")
        .eq("ip", ip)
        .maybeSingle();

      if (!error && data) {
        if (data.expires_at && new Date(data.expires_at) < new Date()) {
          await removeBan(ip);
          return false;
        }
        return true;
      }
    } catch (err) {}
  }

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
    admin_id: adminId,
    action,
    details,
    ip,
    created_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      await supabase.from("system_logs").insert([{ admin_id: adminId, action, details, ip }]);
      return;
    } catch (err) {}
  }

  inMemoryStore.logs.unshift(logItem);
  if (inMemoryStore.logs.length > 300) {
    inMemoryStore.logs.pop();
  }
}

async function getLogs(limit = 100) {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("system_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (!error && data) return data;
    } catch (err) {}
  }
  return inMemoryStore.logs.slice(0, limit);
}

module.exports = {
  isSupabaseConfigured,
  getAds,
  getActiveAds,
  getAdById,
  addAd,
  updateAd,
  updateAdStatus,
  deleteAd,
  recordAdImpression,
  recordAdClick,
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
