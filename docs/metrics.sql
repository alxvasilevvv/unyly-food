-- Product metrics. Demo, Handoff and Live are always reported separately (column "mode").

-- 1. Successful assistant connections (OAuth grants), per week
SELECT date_trunc('week', created_at) AS week, count(*) AS connections, count(DISTINCT user_id) AS users
FROM audit_log WHERE action = 'mcp.connected' GROUP BY 1 ORDER BY 1;

-- 2. First prepared order (first checkout) per user and mode
SELECT mode, count(*) AS users_with_first_checkout
FROM (SELECT DISTINCT ON (user_id, mode) user_id, mode FROM audit_log WHERE action = 'checkout.prepared' ORDER BY user_id, mode, created_at) t
GROUP BY mode;

-- 3. Confirmation completion rate: approved / prepared
SELECT mode,
       count(*) FILTER (WHERE action = 'checkout.prepared') AS prepared,
       count(*) FILTER (WHERE action = 'checkout.approved') AS approved,
       round(100.0 * count(*) FILTER (WHERE action = 'checkout.approved') / NULLIF(count(*) FILTER (WHERE action = 'checkout.prepared'), 0), 1) AS pct
FROM audit_log WHERE action IN ('checkout.prepared', 'checkout.approved') GROUP BY mode;

-- 4. Provider-confirmed orders
SELECT mode, date_trunc('day', created_at) AS day, count(*) FROM orders GROUP BY 1, 2 ORDER BY 2 DESC;

-- 5. Repeat usage: users with orders on 2+ distinct days
SELECT mode, count(*) AS repeat_users FROM (
  SELECT user_id, mode FROM orders GROUP BY user_id, mode HAVING count(DISTINCT date_trunc('day', created_at)) >= 2
) t GROUP BY mode;

-- 6. Submission errors by code (incl. unknown outcomes)
SELECT mode, status, coalesce(error_code, '-') AS code, count(*)
FROM submission_attempts GROUP BY 1, 2, 3 ORDER BY 4 DESC;

-- 7. Handoff funnel (Unyly cannot observe completion inside Grab)
SELECT date_trunc('week', created_at) AS week, count(*) AS handoffs, count(DISTINCT user_id) AS users
FROM handoffs GROUP BY 1 ORDER BY 1;

-- 8. Orders by service (food, mart, ride, express)
SELECT mode, service, count(*) AS orders FROM orders GROUP BY 1, 2 ORDER BY 3 DESC;

-- Ops: unresolved unknown submissions (page on-call if any older than 10 minutes)
SELECT id, checkout_id, mode, started_at, reconcile_attempts, next_reconcile_at
FROM submission_attempts WHERE status IN ('unknown', 'in_flight') ORDER BY started_at;
