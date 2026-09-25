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
    media_path TEXT,
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
    report_count INT NOT NULL DEFAULT 1,
    unique_reporters_count INT NOT NULL DEFAULT 1,
    reporter_ips JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_report_count INT NOT NULL DEFAULT 1,
    ip_unique_reporters_count INT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    action_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- Fast filtering by status and descending timestamps for moderation triage
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON public.reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_ip ON public.reports(reported_ip);
CREATE INDEX IF NOT EXISTS idx_reports_target_reason ON public.reports(reported_ip, lower(reason));
CREATE INDEX IF NOT EXISTS idx_reports_reporter_ip_target_reason ON public.reports(reporter_ip, reported_ip, lower(reason));
CREATE INDEX IF NOT EXISTS idx_reports_last_reported_at ON public.reports(last_reported_at DESC);

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

-- 7. Global system settings (ad delivery configuration, etc.)
CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_settings(key, value)
VALUES ('ad_settings', '{"enabled":true,"defaultPlacement":"stranger-overlay","mobileDockStranger":true,"rotationSeconds":12,"allowDismiss":true,"redisplayOnRotate":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Enable Row Level Security (RLS)
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access to tables
CREATE POLICY "Service Role Full Access Admins" ON public.admins FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Ads" ON public.ads FOR ALL USING (true);
CREATE POLICY "Service Role Full Access AdEvents" ON public.ad_events FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Reports" ON public.reports FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Bans" ON public.bans FOR ALL USING (true);
CREATE POLICY "Service Role Full Access Logs" ON public.system_logs FOR ALL USING (true);
CREATE POLICY "Service Role Full Access System Settings" ON public.system_settings FOR ALL USING (true);

-- Public Read-Only policy for active ads (cached & safe)
CREATE POLICY "Public Read Active Ads" ON public.ads FOR SELECT USING (active = true);


-- ============================================================
-- Production migration helpers / aggregation / Realtime
-- ============================================================

ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS unique_reporters_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_ips JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS last_reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS media_path TEXT;

CREATE OR REPLACE FUNCTION public.increment_ad_impressions(p_ad_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.ads SET impressions = impressions + 1, updated_at = NOW() WHERE id = p_ad_id;
$$;

CREATE OR REPLACE FUNCTION public.increment_ad_clicks(p_ad_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.ads SET clicks = clicks + 1, updated_at = NOW() WHERE id = p_ad_id;
$$;

CREATE OR REPLACE FUNCTION public.submit_report(
  p_reporter_id INT,
  p_reported_id INT,
  p_reporter_ip TEXT,
  p_reported_ip TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason TEXT := LEFT(COALESCE(NULLIF(TRIM(p_reason), ''), 'Unspecified'), 100);
  v_reporter_ip TEXT := COALESCE(NULLIF(TRIM(p_reporter_ip), ''), 'unknown');
  v_reported_ip TEXT := COALESCE(NULLIF(TRIM(p_reported_ip), ''), 'unknown');
  v_row public.reports%ROWTYPE;
  v_count INT;
  v_unique INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(v_reported_ip || '|' || LOWER(v_reason), 42));

  SELECT * INTO v_row
  FROM public.reports
  WHERE reported_ip = v_reported_ip AND LOWER(reason) = LOWER(v_reason)
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF COALESCE(v_row.reporter_ips, '[]'::jsonb) ? v_reporter_ip THEN
      RETURN jsonb_build_object(
        'duplicate', true,
        'report_id', v_row.id,
        'report_count', v_row.report_count,
        'unique_reporters_count', v_row.unique_reporters_count
      );
    END IF;

    UPDATE public.reports
    SET report_count = report_count + 1,
        unique_reporters_count = unique_reporters_count + 1,
        reporter_ips = COALESCE(reporter_ips, '[]'::jsonb) || jsonb_build_array(v_reporter_ip),
        last_reported_at = NOW(),
        reporter_id = COALESCE(reporter_id, p_reporter_id),
        reported_id = COALESCE(reported_id, p_reported_id)
    WHERE id = v_row.id
    RETURNING report_count, unique_reporters_count INTO v_count, v_unique;

    RETURN jsonb_build_object(
      'duplicate', false,
      'report_id', v_row.id,
      'report_count', v_count,
      'unique_reporters_count', v_unique
    );
  END IF;

  INSERT INTO public.reports(
    reporter_id, reported_id, reporter_ip, reported_ip, reason,
    report_count, unique_reporters_count, reporter_ips, last_reported_at, status
  )
  VALUES(
    p_reporter_id, p_reported_id, v_reporter_ip, v_reported_ip, v_reason,
    1, 1, jsonb_build_array(v_reporter_ip), NOW(), 'pending'
  )
  RETURNING id INTO v_row.id;

  RETURN jsonb_build_object(
    'duplicate', false,
    'report_id', v_row.id,
    'report_count', 1,
    'unique_reporters_count', 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_ad_analytics_30d(p_days INT DEFAULT 30)
RETURNS TABLE(date DATE, daily_impressions BIGINT, daily_clicks BIGINT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH days AS (
    SELECT generate_series(
      CURRENT_DATE - (LEAST(GREATEST(COALESCE(p_days, 30), 1), 90) - 1),
      CURRENT_DATE,
      INTERVAL '1 day'
    )::DATE AS date
  )
  SELECT
    days.date,
    COUNT(*) FILTER (WHERE e.event_type = 'impression')::BIGINT AS daily_impressions,
    COUNT(*) FILTER (WHERE e.event_type = 'click')::BIGINT AS daily_clicks
  FROM days
  LEFT JOIN public.ad_events e
    ON e.created_at >= days.date::TIMESTAMPTZ
   AND e.created_at < (days.date + 1)::TIMESTAMPTZ
  GROUP BY days.date
  ORDER BY days.date;
$$;

-- Clean up any duplicate report rows before enforcing uniqueness.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY reported_ip, LOWER(reason) ORDER BY created_at ASC, id) AS rn,
         COUNT(*) OVER (PARTITION BY reported_ip, LOWER(reason)) AS total_rows
  FROM public.reports
  WHERE reported_ip IS NOT NULL AND reported_ip <> 'unknown'
), agg AS (
  SELECT r.reported_ip, LOWER(r.reason) AS norm_reason,
         SUM(GREATEST(r.report_count,1))::INT AS total_count,
         COUNT(DISTINCT r.reporter_ip)::INT AS uniq_count,
         jsonb_agg(DISTINCT r.reporter_ip) FILTER (WHERE r.reporter_ip IS NOT NULL) AS ips
  FROM public.reports r
  WHERE r.reported_ip IS NOT NULL AND r.reported_ip <> 'unknown'
  GROUP BY r.reported_ip, LOWER(r.reason)
)
UPDATE public.reports r
SET report_count = a.total_count,
    unique_reporters_count = a.uniq_count,
    reporter_ips = COALESCE(a.ips, '[]'::jsonb),
    last_reported_at = GREATEST(r.last_reported_at, r.created_at)
FROM agg a
WHERE r.reported_ip = a.reported_ip AND LOWER(r.reason) = a.norm_reason
  AND r.id = (SELECT ranked.id FROM ranked WHERE ranked.reported_ip = r.reported_ip AND ranked.rn = 1 LIMIT 1);

DELETE FROM public.reports d
USING (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY reported_ip, LOWER(reason) ORDER BY created_at ASC, id) AS rn
  FROM public.reports
  WHERE reported_ip IS NOT NULL AND reported_ip <> 'unknown'
) x
WHERE d.id = x.id AND x.rn > 1;

ALTER TABLE public.reports REPLICA IDENTITY FULL;
ALTER TABLE public.ads REPLICA IDENTITY FULL;
ALTER TABLE public.bans REPLICA IDENTITY FULL;
ALTER TABLE public.ad_events REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='reports') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.reports';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ads') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ads';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='bans') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.bans';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ad_events') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ad_events';
  END IF;
END $$;


-- Moderation summary view used by server-side dashboards.
CREATE OR REPLACE VIEW public.report_moderation_summary AS
SELECT
  reported_ip,
  LOWER(reason) AS reason,
  MAX(report_count) AS report_count,
  MAX(unique_reporters_count) AS unique_reporters_count,
  MAX(status) AS status,
  MAX(last_reported_at) AS last_reported_at
FROM public.reports
GROUP BY reported_ip, LOWER(reason);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_target_reason_unique ON public.reports(reported_ip, lower(reason)) WHERE reported_ip IS NOT NULL AND reported_ip <> 'unknown';
