-- ============================================================
-- LELA WebRTC Video Chat - Optimized Database Schema
-- Optimized for Fast Queries, High-Throughput Analytics & Low Latency
-- ============================================================

-- 1. Admins Table with Role-Based Access Control (RBAC)
CREATE TABLE IF NOT EXISTS public.admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', -- 'superadmin', 'admin', 'moderator', 'ads_manager'
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username ON public.admins(username);
CREATE INDEX IF NOT EXISTS idx_admins_role ON public.admins(role);
CREATE INDEX IF NOT EXISTS idx_admins_is_active ON public.admins(is_active);

-- 2. Ads Table for Dynamic Sponsored Creative Management
CREATE TABLE IF NOT EXISTS public.ads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    media_url TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'image', -- 'image' or 'video'
    link_url TEXT,
    placement TEXT NOT NULL DEFAULT 'below-video', -- 'below-video', 'corner', 'top-banner', 'sidebar'
    rotation_seconds INT NOT NULL DEFAULT 12,
    priority INT NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT true,
    impressions BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,
    created_by TEXT DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Compound Index for fast active ad selection and prioritized rotation
CREATE INDEX IF NOT EXISTS idx_ads_active_priority ON public.ads(active, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_placement ON public.ads(placement) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_ads_created_at ON public.ads(created_at DESC);

-- 3. Ad Analytics Events Table (Time-Series Tracking)
CREATE TABLE IF NOT EXISTS public.ad_events (
    id BIGSERIAL PRIMARY KEY,
    ad_id UUID REFERENCES public.ads(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL, -- 'impression', 'click'
    client_ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Covering compound indexes for rapid aggregation of daily/hourly metrics
CREATE INDEX IF NOT EXISTS idx_ad_events_composite ON public.ad_events(ad_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_events_created_at ON public.ad_events(created_at DESC);

-- 4. User Violation Reports Table
CREATE TABLE IF NOT EXISTS public.reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id INT,
    reported_id INT,
    reporter_ip TEXT,
    reported_ip TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'reviewed', 'banned', 'dismissed'
    action_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- Fast filtering by status and descending timestamps for moderation triage
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON public.reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_ip ON public.reports(reported_ip);

-- 5. IP Bans Table
CREATE TABLE IF NOT EXISTS public.bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    banned_by TEXT DEFAULT 'admin',
    banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ -- NULL means permanent ban
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bans_ip ON public.bans(ip);
CREATE INDEX IF NOT EXISTS idx_bans_expires ON public.bans(expires_at) WHERE expires_at IS NOT NULL;

-- 6. System & Audit Logs Table
CREATE TABLE IF NOT EXISTS public.system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id TEXT,
    action TEXT NOT NULL, -- 'ADMIN_LOGIN', 'AD_CREATE', 'BAN_IP', 'DISMISS_REPORT', 'BROADCAST'
    details JSONB,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON public.system_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_action ON public.system_logs(action);

-- Enable Row Level Security (RLS)
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access to tables
CREATE POLICY "Service Role Full Access Admins" ON public.admins FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Ads" ON public.ads FOR ALL USING (true);
CREATE POLICY "Service Role Full Access AdEvents" ON public.ad_events FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Reports" ON public.reports FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Bans" ON public.bans FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Logs" ON public.system_logs FOR ALL USING (true);

-- Public Read-Only policy for active ads (cached & safe)
CREATE POLICY "Public Read Active Ads" ON public.ads FOR SELECT USING (active = true);
