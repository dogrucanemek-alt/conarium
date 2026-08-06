-- scripts/pg-snapshot.sql
-- Produces one conarium-dbsnapshot/0.1 JSON document for conarium-reconcile.
--
-- Prerequisites:
--   * pg_stat_statements enabled (Supabase: on by default)
--   * Conarium connects with a DEDICATED role (e.g. conarium_c2) so the
--     role's counters contain Conarium traffic and nothing else. Reconciling
--     a shared role's counters will blame Conarium for other clients' queries.
--
-- Usage: replace :role, run, save the single-row output as before.json /
-- after.json. Take `before` at window start and `after` at window end.
-- If pg_stat_statements is reset mid-window, conarium-reconcile refuses the
-- window (exit 20) — take fresh snapshots instead of arguing with it.
select json_build_object(
  'v', 'conarium-dbsnapshot/0.1',
  'ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'role', :'role',
  'source', 'pg_stat_statements',
  'entries', coalesce(json_agg(json_build_object(
    'queryid', s.queryid::text,
    'query', s.query,
    'calls', s.calls
  )), '[]'::json)
) as snapshot
from pg_stat_statements s
join pg_roles r on r.oid = s.userid
where r.rolname = :'role';
