-- LELA release migration: run once in Supabase SQL Editor.
-- Safe to re-run.

ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS media_path TEXT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS unique_reporters_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_ips JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS last_reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ip_report_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ip_unique_reporters_count INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_settings(key,value) VALUES
('ad_settings','{"enabled":true,"defaultPlacement":"stranger-overlay","mobileDockStranger":true,"rotationSeconds":12,"allowDismiss":true,"redisplayOnRotate":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_reports_status_created ON public.reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target_reason ON public.reports(reported_ip, lower(reason));
CREATE INDEX IF NOT EXISTS idx_reports_reporter_ip_target_reason ON public.reports(reporter_ip, reported_ip, lower(reason));
CREATE INDEX IF NOT EXISTS idx_reports_last_reported_at ON public.reports(last_reported_at DESC);

CREATE OR REPLACE FUNCTION public.increment_ad_impressions(p_ad_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path=public AS $$
  UPDATE public.ads SET impressions=impressions+1, updated_at=NOW() WHERE id=p_ad_id;
$$;

CREATE OR REPLACE FUNCTION public.increment_ad_clicks(p_ad_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path=public AS $$
  UPDATE public.ads SET clicks=clicks+1, updated_at=NOW() WHERE id=p_ad_id;
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
  v_ip_count INT;
  v_ip_unique INT;
BEGIN
  -- Serialize all reports against one target IP so two concurrent clicks
  -- from the same reporter cannot both pass the duplicate check.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_reported_ip, 43));

  IF v_reported_ip <> 'unknown' AND v_reporter_ip <> 'unknown' THEN
    -- One reporter IP may only report a given target IP once, regardless of
    -- which reason they choose on later attempts.
    SELECT * INTO v_row
    FROM public.reports
    WHERE reported_ip = v_reported_ip
      AND COALESCE(reporter_ips, '[]'::jsonb) ? v_reporter_ip
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'duplicate', true,
        'report_id', v_row.id,
        'report_count', v_row.report_count,
        'unique_reporters_count', v_row.unique_reporters_count,
        'ip_report_count', COALESCE(v_row.ip_report_count, v_row.report_count),
        'ip_unique_reporters_count', COALESCE(v_row.ip_unique_reporters_count, v_row.unique_reporters_count)
      );
    END IF;
  END IF;

  SELECT * INTO v_row
  FROM public.reports
  WHERE reported_ip = v_reported_ip AND LOWER(reason) = LOWER(v_reason)
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.reports SET
      report_count = report_count + 1,
      unique_reporters_count = unique_reporters_count + 1,
      reporter_ips = COALESCE(reporter_ips, '[]'::jsonb) || jsonb_build_array(v_reporter_ip),
      last_reported_at = NOW(),
      reporter_id = COALESCE(reporter_id, p_reporter_id),
      reported_id = COALESCE(reported_id, p_reported_id)
    WHERE id = v_row.id
    RETURNING report_count, unique_reporters_count INTO v_count, v_unique;
  ELSE
    INSERT INTO public.reports(
      reporter_id, reported_id, reporter_ip, reported_ip, reason,
      report_count, unique_reporters_count, reporter_ips, last_reported_at, status,
      ip_report_count, ip_unique_reporters_count
    )
    VALUES(
      p_reporter_id, p_reported_id, v_reporter_ip, v_reported_ip, v_reason,
      1, 1, jsonb_build_array(v_reporter_ip), NOW(), 'pending', 1, 1
    )
    RETURNING * INTO v_row;
    v_count := 1;
    v_unique := 1;
  END IF;

  -- Maintain exact per-target aggregates across all reason rows.
  SELECT
    COALESCE(SUM(GREATEST(r.report_count, 1)), 0)::INT,
    COUNT(DISTINCT reporters.reporter_ip)::INT
  INTO v_ip_count, v_ip_unique
  FROM public.reports r
  LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(r.reporter_ips, '[]'::jsonb)) AS reporters(reporter_ip) ON TRUE
  WHERE r.reported_ip = v_reported_ip;

  UPDATE public.reports
  SET ip_report_count = v_ip_count,
      ip_unique_reporters_count = GREATEST(v_ip_unique, 1)
  WHERE reported_ip = v_reported_ip;

  RETURN jsonb_build_object(
    'duplicate', false,
    'report_id', COALESCE(v_row.id, (SELECT id FROM public.reports WHERE reported_ip=v_reported_ip AND LOWER(reason)=LOWER(v_reason) ORDER BY created_at ASC LIMIT 1)),
    'report_count', v_count,
    'unique_reporters_count', v_unique,
    'ip_report_count', v_ip_count,
    'ip_unique_reporters_count', GREATEST(v_ip_unique, 1)
  );
END; $$;

CREATE OR REPLACE FUNCTION public.get_ad_analytics_30d(p_days INT DEFAULT 30)
RETURNS TABLE(date DATE,daily_impressions BIGINT,daily_clicks BIGINT)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH days AS (SELECT generate_series(CURRENT_DATE-(LEAST(GREATEST(COALESCE(p_days,30),1),90)-1),CURRENT_DATE,INTERVAL '1 day')::DATE AS date)
  SELECT days.date,
    COUNT(*) FILTER(WHERE e.event_type='impression')::BIGINT,
    COUNT(*) FILTER(WHERE e.event_type='click')::BIGINT
  FROM days LEFT JOIN public.ad_events e
    ON e.created_at>=days.date::TIMESTAMPTZ AND e.created_at<(days.date+1)::TIMESTAMPTZ
  GROUP BY days.date ORDER BY days.date;
$$;

-- Remove duplicate aggregate rows before creating the uniqueness guard.
WITH ranked AS (
  SELECT id,ROW_NUMBER() OVER(PARTITION BY reported_ip,LOWER(reason) ORDER BY created_at ASC,id) rn
  FROM public.reports WHERE reported_ip IS NOT NULL AND reported_ip<>'unknown'
), agg AS (
  SELECT reported_ip,LOWER(reason) norm_reason,
    SUM(GREATEST(report_count,1))::INT total_count,
    COUNT(DISTINCT reporter_ip)::INT uniq_count,
    jsonb_agg(DISTINCT reporter_ip) FILTER(WHERE reporter_ip IS NOT NULL) ips
  FROM public.reports WHERE reported_ip IS NOT NULL AND reported_ip<>'unknown'
  GROUP BY reported_ip,LOWER(reason)
), ipagg AS (
  SELECT r.reported_ip,
    SUM(GREATEST(r.report_count,1))::INT ip_count,
    COUNT(DISTINCT reporters.reporter_ip)::INT ip_unique
  FROM public.reports r
  LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(r.reporter_ips, '[]'::jsonb)) AS reporters(reporter_ip) ON TRUE
  WHERE r.reported_ip IS NOT NULL AND r.reported_ip<>'unknown'
  GROUP BY r.reported_ip
)
UPDATE public.reports r SET report_count=a.total_count,unique_reporters_count=a.uniq_count,reporter_ips=COALESCE(a.ips,'[]'::jsonb),last_reported_at=NOW(),ip_report_count=ia.ip_count,ip_unique_reporters_count=GREATEST(ia.ip_unique,1)
FROM agg a JOIN ranked rr ON rr.reported_ip=a.reported_ip AND LOWER(rr.reason)=a.norm_reason AND rr.rn=1
JOIN ipagg ia ON ia.reported_ip=rr.reported_ip
WHERE r.id=rr.id;

DELETE FROM public.reports d USING (
  SELECT id,ROW_NUMBER() OVER(PARTITION BY reported_ip,LOWER(reason) ORDER BY created_at ASC,id) rn
  FROM public.reports WHERE reported_ip IS NOT NULL AND reported_ip<>'unknown'
) x WHERE d.id=x.id AND x.rn>1;

WITH ipagg AS (
  SELECT r.reported_ip, SUM(GREATEST(r.report_count,1))::INT ip_count, COUNT(DISTINCT reporters.reporter_ip)::INT ip_unique
  FROM public.reports r
  LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(r.reporter_ips, '[]'::jsonb)) AS reporters(reporter_ip) ON TRUE
  WHERE r.reported_ip IS NOT NULL AND r.reported_ip<>'unknown' GROUP BY r.reported_ip
)
UPDATE public.reports r SET ip_report_count=ipagg.ip_count, ip_unique_reporters_count=GREATEST(ipagg.ip_unique,1) FROM ipagg WHERE r.reported_ip=ipagg.reported_ip;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_target_reason_unique ON public.reports(reported_ip,lower(reason)) WHERE reported_ip IS NOT NULL AND reported_ip<>'unknown';

ALTER TABLE public.reports REPLICA IDENTITY FULL;
ALTER TABLE public.ads REPLICA IDENTITY FULL;
ALTER TABLE public.bans REPLICA IDENTITY FULL;
ALTER TABLE public.ad_events REPLICA IDENTITY FULL;

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN EXECUTE 'CREATE PUBLICATION supabase_realtime'; END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='reports') THEN EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.reports'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ads') THEN EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ads'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='bans') THEN EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.bans'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ad_events') THEN EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ad_events'; END IF;
END $$;

-- Verify Realtime in Supabase Dashboard: Database -> Replication -> supabase_realtime should include reports, ads, bans, ad_events.


-- v4: canonical report-to IP summary for admin analytics. Safe to re-run.
CREATE OR REPLACE VIEW public.report_ip_summary AS
SELECT
  reported_ip,
  SUM(GREATEST(report_count,1))::INT AS ip_report_count,
  COUNT(DISTINCT reporter_ip)::INT AS direct_reporter_ip_count,
  MAX(last_reported_at) AS last_reported_at
FROM public.reports
WHERE reported_ip IS NOT NULL AND reported_ip <> 'unknown'
GROUP BY reported_ip;
