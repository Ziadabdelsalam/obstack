-- Retention, outer bound (D252): the table-level TTLs move from the flat 30
-- days to 90 — the PRD §10 maximum tier — and stop being the retention story.
-- Per-tier truth is the ingest retention sweep's (internal/retention), which
-- deletes each workspace's rows past its plan's retention_days; this TTL is the
-- never-past-here line behind it, so a sweep that stops running degrades to
-- over-delivery, never to unbounded growth.
--
-- Measured before ruling (2026-08-23, clickhouse-server:26.3.17.110): MODIFY
-- TTL alone does not re-evaluate existing parts at merge — the auto
-- MATERIALIZE TTL mutation this ALTER triggers is what recalculates them. All
-- live rows are ≤30 days old (written under the old TTL), so widening makes
-- nothing newly eligible and the materialize pass has nothing to drop. Rows
-- older than the table TTL are dropped at insert-time part formation, which is
-- why this migration is sequenced before the drain receivers: a late-stamped
-- payload aged 30–90 days must land, not silently vanish.
ALTER TABLE obstack.spans MODIFY TTL toDateTime(start_time) + INTERVAL 90 DAY;
ALTER TABLE obstack.logs MODIFY TTL toDateTime(timestamp) + INTERVAL 90 DAY;
ALTER TABLE obstack.trace_summaries MODIFY TTL max_seen_date + INTERVAL 90 DAY;
