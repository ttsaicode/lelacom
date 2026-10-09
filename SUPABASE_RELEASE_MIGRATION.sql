-- ============================================================
-- LELAConnect - Complete Supabase Setup / Migration
--
-- Purpose:
--   Creates the tables, indexes, moderation/report aggregation,
--   ad analytics functions, realtime publication, and ad-media
--   storage bucket needed by the current LELAConnect backend.
--
-- Safe to run more than once.
-- IMPORTANT:
--   Run this in Supabase SQL Editor as a project owner/admin.
--   The application should use the Supabase service/secret key
--   only from the server side, never from browser code.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1) ADMIN ACCOUNTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username ON public.admins(username);
CREATE INDEX IF NOT EXISTS idx_admins_role ON public.admins(role);
CREATE INDEX IF NOT EXISTS idx_admins_is_active ON public.admins(is_active);

-- ============================================================
-- 2) ADVERTISEMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    cta_text TEXT NOT NULL DEFAULT 'Learn more ↗',
    media_url TEXT NOT NULL,
    media_path TEXT,
    media_type TEXT NOT NULL DEFAULT 'image',
    link_url TEXT,
    placement TEXT NOT NULL DEFAULT 'stranger-overlay',
    device_target TEXT NOT NULL DEFAULT 'all',
    rotation_seconds INT NOT NULL DEFAULT 12,
    priority INT NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    impressions BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,
    created_by TEXT DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS cta_text TEXT NOT NULL DEFAULT 'Learn more ↗';
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS media_path TEXT;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS link_url TEXT;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'stranger-overlay';
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS device_target TEXT NOT NULL DEFAULT 'all';
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS rotation_seconds INT NOT NULL DEFAULT 12;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 1;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS impressions BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS clicks BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT 'admin';
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.ads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ads_active_priority
    ON public.ads(active, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_placement_active
    ON public.ads(placement) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ads_created_at
    ON public.ads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_media_path
    ON public.ads(media_path);

-- ============================================================
-- 3) AD EVENTS / ANALYTICS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ad_events (
    id BIGSERIAL PRIMARY KEY,
    ad_id UUID REFERENCES public.ads(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    client_ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ad_events_event_type_check
        CHECK (event_type IN ('impression', 'click'))
);

ALTER TABLE public.ad_events ADD COLUMN IF NOT EXISTS client_ip TEXT;
ALTER TABLE public.ad_events ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE public.ad_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_ad_events_ad_type_created
    ON public.ad_events(ad_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_events_created_at
    ON public.ad_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_events_type_created
    ON public.ad_events(event_type, created_at DESC);

-- ============================================================
-- 4) USER REPORTS / MODERATION
-- ============================================================

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

ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_id INT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reported_id INT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_ip TEXT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reported_ip TEXT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS unique_reporters_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_ips JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS last_reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ip_report_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ip_unique_reporters_count INT NOT NULL DEFAULT 1;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS action_notes TEXT;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Normalize legacy rows so reporter_ips always contains reporter_ip when known.
UPDATE public.reports
SET reporter_ips = CASE
    WHEN reporter_ip IS NULL OR reporter_ip = '' OR reporter_ip = 'unknown' THEN COALESCE(reporter_ips, '[]'::jsonb)
    WHEN COALESCE(reporter_ips, '[]'::jsonb) ? reporter_ip THEN reporter_ips
    ELSE COALESCE(reporter_ips, '[]'::jsonb) || jsonb_build_array(reporter_ip)
END
WHERE reporter_ip IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_status_created
    ON public.reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_ip
    ON public.reports(reported_ip);
CREATE INDEX IF NOT EXISTS idx_reports_target_reason
    ON public.reports(reported_ip, lower(reason));
CREATE INDEX IF NOT EXISTS idx_reports_reporter_target
    ON public.reports(reporter_ip, reported_ip);
CREATE INDEX IF NOT EXISTS idx_reports_last_reported_at
    ON public.reports(last_reported_at DESC);

-- ============================================================
-- 5) IP BANS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    banned_by TEXT DEFAULT 'admin',
    banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bans_ip ON public.bans(ip);
CREATE INDEX IF NOT EXISTS idx_bans_expires
    ON public.bans(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================
-- 6) AUDIT LOGS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id TEXT,
    action TEXT NOT NULL,
    details JSONB,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at
    ON public.system_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_action
    ON public.system_logs(action);

-- ============================================================
-- 7) GLOBAL SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_settings(key, value)
VALUES (
    'ad_settings',
    '{"enabled":true,"defaultPlacement":"stranger-overlay","mobileDockStranger":true,"rotationSeconds":12,"allowDismiss":true,"redisplayOnRotate":true}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 8) UPDATED_AT TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admins_updated_at ON public.admins;
CREATE TRIGGER trg_admins_updated_at
BEFORE UPDATE ON public.admins
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ads_updated_at ON public.ads;
CREATE TRIGGER trg_ads_updated_at
BEFORE UPDATE ON public.ads
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON public.system_settings;
CREATE TRIGGER trg_system_settings_updated_at
BEFORE UPDATE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 9) AD COUNTER FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_ad_impressions(p_ad_id UUID)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.ads
    SET impressions = impressions + 1,
        updated_at = NOW()
    WHERE id = p_ad_id;
$$;

CREATE OR REPLACE FUNCTION public.increment_ad_clicks(p_ad_id UUID)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.ads
    SET clicks = clicks + 1,
        updated_at = NOW()
    WHERE id = p_ad_id;
$$;

-- ============================================================
-- 10) REPORT SUBMISSION / DEDUPLICATION
--
-- Rules:
--   * Same reporter IP cannot report the same target IP twice,
--     even if they choose a different reason later.
--   * Same target IP + same reason is one database row.
--     Additional distinct reporters increment report_count.
--   * ip_report_count is the total count across ALL reasons for
--     that target IP.
--   * ip_unique_reporters_count is the number of distinct reporter
--     IPs across ALL reasons for that target IP.
-- ============================================================

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
    v_reason TEXT := LEFT(
        COALESCE(NULLIF(TRIM(p_reason), ''), 'Unspecified'),
        100
    );
    v_reporter_ip TEXT := COALESCE(NULLIF(TRIM(p_reporter_ip), ''), 'unknown');
    v_reported_ip TEXT := COALESCE(NULLIF(TRIM(p_reported_ip), ''), 'unknown');
    v_row public.reports%ROWTYPE;
    v_target_row public.reports%ROWTYPE;
    v_ip_count INT := 0;
    v_ip_unique INT := 0;
    v_report_count INT := 1;
    v_reason_unique INT := 1;
    v_reporter_ips JSONB := '[]'::jsonb;
BEGIN
    IF v_reported_ip = 'unknown' THEN
        -- Unknown target IPs cannot safely be aggregated with other unknowns.
        -- Still record the report, but do not use the IP as a unique key.
        INSERT INTO public.reports(
            reporter_id, reported_id, reporter_ip, reported_ip, reason,
            report_count, unique_reporters_count, reporter_ips,
            last_reported_at, ip_report_count, ip_unique_reporters_count,
            status
        )
        VALUES(
            p_reporter_id, p_reported_id, v_reporter_ip, v_reported_ip, v_reason,
            1, 1,
            CASE WHEN v_reporter_ip = 'unknown'
                 THEN '[]'::jsonb
                 ELSE jsonb_build_array(v_reporter_ip)
            END,
            NOW(), 1, 1, 'pending'
        )
        RETURNING * INTO v_row;

        RETURN jsonb_build_object(
            'duplicate', false,
            'report_id', v_row.id,
            'report_count', 1,
            'unique_reporters_count', 1,
            'ip_report_count', 1,
            'ip_unique_reporters_count', 1
        );
    END IF;

    -- Serialize all writes for the same target IP.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(v_reported_ip, 43)
    );

    -- One reporter IP may report a given target IP only once,
    -- regardless of reason.
    IF v_reporter_ip <> 'unknown' THEN
        SELECT r.*
        INTO v_row
        FROM public.reports r
        WHERE r.reported_ip = v_reported_ip
          AND (
              r.reporter_ip = v_reporter_ip
              OR COALESCE(r.reporter_ips, '[]'::jsonb) ? v_reporter_ip
          )
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT 1
        FOR UPDATE;

        IF FOUND THEN
            -- Recalculate the target-level aggregates so this response is
            -- immediately consistent with the database.
            SELECT
                COALESCE(SUM(GREATEST(r2.report_count, 1)), 0)::INT,
                COUNT(DISTINCT reporter_values.reporter_ip)::INT
            INTO v_ip_count, v_ip_unique
            FROM public.reports r2
            LEFT JOIN LATERAL jsonb_array_elements_text(
                CASE
                    WHEN r2.reporter_ips IS NULL OR jsonb_typeof(r2.reporter_ips) <> 'array'
                        THEN '[]'::jsonb
                    ELSE r2.reporter_ips
                END
            ) AS reporter_values(reporter_ip) ON TRUE
            WHERE r2.reported_ip = v_reported_ip
              AND reporter_values.reporter_ip <> 'unknown';

            UPDATE public.reports
            SET ip_report_count = GREATEST(v_ip_count, 1),
                ip_unique_reporters_count = GREATEST(v_ip_unique, 1)
            WHERE reported_ip = v_reported_ip;

            RETURN jsonb_build_object(
                'duplicate', true,
                'report_id', v_row.id,
                'report_count', v_row.report_count,
                'unique_reporters_count', v_row.unique_reporters_count,
                'ip_report_count', GREATEST(v_ip_count, 1),
                'ip_unique_reporters_count', GREATEST(v_ip_unique, 1)
            );
        END IF;
    END IF;

    -- One row per target-IP + normalized reason.
    SELECT r.*
    INTO v_row
    FROM public.reports r
    WHERE r.reported_ip = v_reported_ip
      AND LOWER(TRIM(r.reason)) = LOWER(v_reason)
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        v_reporter_ips := COALESCE(v_row.reporter_ips, '[]'::jsonb);

        IF v_reporter_ip <> 'unknown' AND NOT (v_reporter_ips ? v_reporter_ip) THEN
            v_reporter_ips := v_reporter_ips || jsonb_build_array(v_reporter_ip);
        END IF;

        SELECT COUNT(DISTINCT x)::INT
        INTO v_reason_unique
        FROM jsonb_array_elements_text(v_reporter_ips) AS j(x)
        WHERE x <> 'unknown';

        UPDATE public.reports
        SET report_count = report_count + 1,
            unique_reporters_count = GREATEST(v_reason_unique, 1),
            reporter_ips = v_reporter_ips,
            last_reported_at = NOW(),
            reporter_id = COALESCE(reporter_id, p_reporter_id),
            reported_id = COALESCE(reported_id, p_reported_id)
        WHERE id = v_row.id
        RETURNING * INTO v_row;
    ELSE
        INSERT INTO public.reports(
            reporter_id, reported_id, reporter_ip, reported_ip, reason,
            report_count, unique_reporters_count, reporter_ips,
            last_reported_at, ip_report_count, ip_unique_reporters_count,
            status
        )
        VALUES(
            p_reporter_id, p_reported_id, v_reporter_ip, v_reported_ip, v_reason,
            1, 1,
            CASE WHEN v_reporter_ip = 'unknown'
                 THEN '[]'::jsonb
                 ELSE jsonb_build_array(v_reporter_ip)
            END,
            NOW(), 1, 1, 'pending'
        )
        RETURNING * INTO v_row;
    END IF;

    -- Recalculate target-IP aggregates across every reason row.
    SELECT
        COALESCE(SUM(GREATEST(r.report_count, 1)), 0)::INT,
        COUNT(DISTINCT reporter_values.reporter_ip)::INT
    INTO v_ip_count, v_ip_unique
    FROM public.reports r
    LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN r.reporter_ips IS NULL OR jsonb_typeof(r.reporter_ips) <> 'array'
                THEN '[]'::jsonb
            ELSE r.reporter_ips
        END
    ) AS reporter_values(reporter_ip) ON TRUE
    WHERE r.reported_ip = v_reported_ip
      AND reporter_values.reporter_ip <> 'unknown';

    v_ip_count := GREATEST(v_ip_count, 1);
    v_ip_unique := GREATEST(v_ip_unique, 1);

    UPDATE public.reports
    SET ip_report_count = v_ip_count,
        ip_unique_reporters_count = v_ip_unique
    WHERE reported_ip = v_reported_ip;

    RETURN jsonb_build_object(
        'duplicate', false,
        'report_id', v_row.id,
        'report_count', v_row.report_count,
        'unique_reporters_count', v_row.unique_reporters_count,
        'ip_report_count', v_ip_count,
        'ip_unique_reporters_count', v_ip_unique
    );
END;
$$;

-- ============================================================
-- 11) ATOMIC BAN FROM REPORT
-- ============================================================

CREATE OR REPLACE FUNCTION public.ban_reported_ip(
    p_ip TEXT,
    p_reason TEXT DEFAULT 'Violation report',
    p_banned_by TEXT DEFAULT 'admin',
    p_duration_hours INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ip TEXT := NULLIF(TRIM(p_ip), '');
    v_expires TIMESTAMPTZ := NULL;
    v_ban public.bans%ROWTYPE;
    v_affected INT := 0;
BEGIN
    IF v_ip IS NULL THEN
        RAISE EXCEPTION 'IP address is required';
    END IF;

    IF p_duration_hours IS NOT NULL AND p_duration_hours > 0 THEN
        v_expires := NOW() + make_interval(hours => p_duration_hours);
    END IF;

    INSERT INTO public.bans(ip, reason, banned_by, banned_at, expires_at)
    VALUES(
        v_ip,
        LEFT(COALESCE(NULLIF(TRIM(p_reason), ''), 'Violation report'), 200),
        LEFT(COALESCE(NULLIF(TRIM(p_banned_by), ''), 'admin'), 100),
        NOW(),
        v_expires
    )
    ON CONFLICT (ip)
    DO UPDATE SET
        reason = EXCLUDED.reason,
        banned_by = EXCLUDED.banned_by,
        banned_at = NOW(),
        expires_at = EXCLUDED.expires_at
    RETURNING * INTO v_ban;

    UPDATE public.reports
    SET status = 'banned',
        action_notes = LEFT(
            COALESCE(NULLIF(TRIM(p_banned_by), ''), 'admin')
            || ' banned IP ' || v_ip,
            500
        ),
        resolved_at = NOW()
    WHERE reported_ip = v_ip;

    GET DIAGNOSTICS v_affected = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'ip', v_ban.ip,
        'ban_id', v_ban.id,
        'expires_at', v_ban.expires_at,
        'reports_marked_banned', v_affected
    );
END;
$$;

-- ============================================================
-- 12) AD ANALYTICS: LAST N DAYS
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_ad_analytics_30d(p_days INT DEFAULT 30)
RETURNS TABLE(
    date DATE,
    daily_impressions BIGINT,
    daily_clicks BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH days AS (
        SELECT generate_series(
            CURRENT_DATE - (
                LEAST(GREATEST(COALESCE(p_days, 30), 1), 90) - 1
            ),
            CURRENT_DATE,
            INTERVAL '1 day'
        )::DATE AS date
    )
    SELECT
        days.date,
        COUNT(e.id) FILTER (WHERE e.event_type = 'impression')::BIGINT,
        COUNT(e.id) FILTER (WHERE e.event_type = 'click')::BIGINT
    FROM days
    LEFT JOIN public.ad_events e
      ON e.created_at >= days.date::TIMESTAMPTZ
     AND e.created_at < (days.date + 1)::TIMESTAMPTZ
    GROUP BY days.date
    ORDER BY days.date;
$$;

-- ============================================================
-- 13) REPORT IP SUMMARY VIEW
--
-- One row per reported IP. This is useful for an admin panel that
-- wants "Report To", total IP report count, unique reporters, reasons,
-- and moderation status without displaying redundant rows.
-- ============================================================

CREATE OR REPLACE VIEW public.report_ip_summary
WITH (security_invoker = true)
AS
SELECT
    r.reported_ip AS report_to_ip,
    SUM(GREATEST(r.report_count, 1))::INT AS ip_report_count,
    COUNT(DISTINCT reporter_values.reporter_ip)
        FILTER (WHERE reporter_values.reporter_ip <> 'unknown')::INT
        AS ip_unique_reporters_count,
    MIN(r.created_at) AS first_reported_at,
    MAX(r.last_reported_at) AS last_reported_at,
    ARRAY_AGG(DISTINCT r.reason ORDER BY r.reason) AS reasons,
    BOOL_OR(r.status = 'banned') AS is_banned
FROM public.reports r
LEFT JOIN LATERAL jsonb_array_elements_text(
    CASE
        WHEN r.reporter_ips IS NULL OR jsonb_typeof(r.reporter_ips) <> 'array'
            THEN '[]'::jsonb
        ELSE r.reporter_ips
    END
) AS reporter_values(reporter_ip) ON TRUE
WHERE r.reported_ip IS NOT NULL
  AND r.reported_ip <> 'unknown'
GROUP BY r.reported_ip;

-- Keep row-level aggregate columns synchronized for existing records.
WITH target_agg AS (
    SELECT
        r.reported_ip,
        SUM(GREATEST(r.report_count, 1))::INT AS total_reports,
        COUNT(DISTINCT reporter_values.reporter_ip)
            FILTER (WHERE reporter_values.reporter_ip <> 'unknown')::INT
            AS unique_reporters
    FROM public.reports r
    LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN r.reporter_ips IS NULL OR jsonb_typeof(r.reporter_ips) <> 'array'
                THEN '[]'::jsonb
            ELSE r.reporter_ips
        END
    ) AS reporter_values(reporter_ip) ON TRUE
    WHERE r.reported_ip IS NOT NULL
      AND r.reported_ip <> 'unknown'
    GROUP BY r.reported_ip
)
UPDATE public.reports r
SET ip_report_count = GREATEST(a.total_reports, 1),
    ip_unique_reporters_count = GREATEST(a.unique_reporters, 1)
FROM target_agg a
WHERE r.reported_ip = a.reported_ip;

-- Merge legacy duplicate rows before adding the unique guard.
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY reported_ip, LOWER(TRIM(reason))
            ORDER BY created_at ASC, id ASC
        ) AS rn
    FROM public.reports
    WHERE reported_ip IS NOT NULL
      AND reported_ip <> 'unknown'
), aggregate_reason AS (
    SELECT
        reported_ip,
        LOWER(TRIM(reason)) AS norm_reason,
        SUM(GREATEST(report_count, 1))::INT AS total_count,
        COUNT(DISTINCT reporter_values.reporter_ip)
            FILTER (WHERE reporter_values.reporter_ip <> 'unknown')::INT
            AS unique_count,
        COALESCE(
            jsonb_agg(DISTINCT reporter_values.reporter_ip)
                FILTER (WHERE reporter_values.reporter_ip <> 'unknown'),
            '[]'::jsonb
        ) AS reporter_ip_list
    FROM public.reports r
    LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN r.reporter_ips IS NULL OR jsonb_typeof(r.reporter_ips) <> 'array'
                THEN '[]'::jsonb
            ELSE r.reporter_ips
        END
    ) AS reporter_values(reporter_ip) ON TRUE
    WHERE r.reported_ip IS NOT NULL
      AND r.reported_ip <> 'unknown'
    GROUP BY reported_ip, LOWER(TRIM(reason))
), ip_aggregate AS (
    SELECT
        r.reported_ip,
        SUM(GREATEST(r.report_count, 1))::INT AS total_ip_count,
        COUNT(DISTINCT reporter_values.reporter_ip)
            FILTER (WHERE reporter_values.reporter_ip <> 'unknown')::INT
            AS total_ip_unique
    FROM public.reports r
    LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN r.reporter_ips IS NULL OR jsonb_typeof(r.reporter_ips) <> 'array'
                THEN '[]'::jsonb
            ELSE r.reporter_ips
        END
    ) AS reporter_values(reporter_ip) ON TRUE
    WHERE r.reported_ip IS NOT NULL
      AND r.reported_ip <> 'unknown'
    GROUP BY r.reported_ip
)
UPDATE public.reports r
SET report_count = a.total_count,
    unique_reporters_count = GREATEST(a.unique_count, 1),
    reporter_ips = a.reporter_ip_list,
    last_reported_at = GREATEST(r.last_reported_at, r.created_at),
    ip_report_count = GREATEST(i.total_ip_count, 1),
    ip_unique_reporters_count = GREATEST(i.total_ip_unique, 1)
FROM aggregate_reason a
JOIN ip_aggregate i
  ON i.reported_ip = a.reported_ip
WHERE r.id = (
    SELECT r2.id
    FROM public.reports r2
    WHERE r2.reported_ip = a.reported_ip
      AND LOWER(TRIM(r2.reason)) = a.norm_reason
    ORDER BY r2.created_at ASC, r2.id ASC
    LIMIT 1
);

DELETE FROM public.reports d
USING (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY reported_ip, LOWER(TRIM(reason))
            ORDER BY created_at ASC, id ASC
        ) AS rn
    FROM public.reports
    WHERE reported_ip IS NOT NULL
      AND reported_ip <> 'unknown'
) x
WHERE d.id = x.id
  AND x.rn > 1;

-- Enforce one row per target IP + reason.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_target_reason_unique
    ON public.reports(reported_ip, lower(TRIM(reason)))
    WHERE reported_ip IS NOT NULL
      AND reported_ip <> 'unknown';

-- ============================================================
-- 14) REALTIME
-- ============================================================

ALTER TABLE public.reports REPLICA IDENTITY FULL;
ALTER TABLE public.ads REPLICA IDENTITY FULL;
ALTER TABLE public.bans REPLICA IDENTITY FULL;
ALTER TABLE public.ad_events REPLICA IDENTITY FULL;
ALTER TABLE public.system_logs REPLICA IDENTITY FULL;
ALTER TABLE public.system_settings REPLICA IDENTITY FULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        EXECUTE 'CREATE PUBLICATION supabase_realtime';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'reports'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.reports';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'ads'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ads';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'bans'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.bans';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'ad_events'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.ad_events';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'system_logs'
    ) THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.system_logs';
    END IF;
END
$$;

-- ============================================================
-- 15) ROW-LEVEL SECURITY
--
-- The application server uses the Supabase service/secret key.
-- We intentionally do NOT create broad anon/authenticated write
-- policies for moderation/admin tables.
-- ============================================================

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Remove legacy overly-broad policies if they exist.
DROP POLICY IF EXISTS "Service Role Full Access Admins" ON public.admins;
DROP POLICY IF EXISTS "Service Role Full Access Ads" ON public.ads;
DROP POLICY IF EXISTS "Service Role Full Access AdEvents" ON public.ad_events;
DROP POLICY IF EXISTS "Service Role Full Access Reports" ON public.reports;
DROP POLICY IF EXISTS "Service Role Full Access Bans" ON public.bans;
DROP POLICY IF EXISTS "Service Role Full Access Logs" ON public.system_logs;
DROP POLICY IF EXISTS "Service Role Full Access System Settings" ON public.system_settings;
DROP POLICY IF EXISTS "Public Read Active Ads" ON public.ads;

-- No anon/authenticated CRUD policies are created here.
-- Supabase service/secret keys bypass RLS for the server-side app.

-- Lock down SECURITY DEFINER functions to the backend role.
REVOKE ALL ON FUNCTION public.increment_ad_impressions(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_ad_impressions(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.increment_ad_impressions(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ad_impressions(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.increment_ad_clicks(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_ad_clicks(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.increment_ad_clicks(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ad_clicks(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.submit_report(INT, INT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_report(INT, INT, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.submit_report(INT, INT, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_report(INT, INT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.ban_reported_ip(TEXT, TEXT, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ban_reported_ip(TEXT, TEXT, TEXT, INT) FROM anon;
REVOKE ALL ON FUNCTION public.ban_reported_ip(TEXT, TEXT, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ban_reported_ip(TEXT, TEXT, TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.get_ad_analytics_30d(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_ad_analytics_30d(INT) FROM anon;
REVOKE ALL ON FUNCTION public.get_ad_analytics_30d(INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_ad_analytics_30d(INT) TO service_role;

-- The summary view is backend-only.
REVOKE ALL ON public.report_ip_summary FROM PUBLIC;
REVOKE ALL ON public.report_ip_summary FROM anon;
REVOKE ALL ON public.report_ip_summary FROM authenticated;
GRANT SELECT ON public.report_ip_summary TO service_role;

-- ============================================================
-- 16) SUPABASE STORAGE: AD MEDIA BUCKET
--
-- Actual ad files live here, not in Railway/Vercel application
-- storage. The backend creates signed upload URLs.
-- ============================================================

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'ad-media',
    'ad-media',
    TRUE,
    20971520,
    ARRAY[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'video/mp4',
        'video/webm',
        'video/quicktime'
    ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- END
-- ============================================================
-- After running this file:
--   1) Verify tables exist under Table Editor.
--   2) Verify reports/ad_events/reports/ads are in Database >
--      Publications > supabase_realtime.
--   3) Verify Storage > ad-media exists.
--   4) Keep SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY only
--      on the server. Never expose it in public JS.
-- ============================================================
