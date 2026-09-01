-- The metrics cardinality drop reason (packet §2, D368): a data point that would
-- create a NEW series past the per-workspace 25k-active-series cap is dropped
-- and counted here rather than admitted, and it needs its own column for the
-- same reason dropped_quota and its siblings do (0005): the health UPSERT adds
-- rather than sets (D162), which cannot be expressed safely over a JSONB map, so
-- a new drop reason is an ordinary migration and not a document merge.
--
-- BIGINT NOT NULL DEFAULT 0 on both tables, same as every other drop column
-- here: a new reason never leaves an existing row's count NULL, and the DEFAULT
-- is safe for the cumulative and the windowed table alike since neither has a
-- row a value could silently drift onto (contrast 0006's explain_quota, which
-- had to refuse a catalog row with none stated instead).
ALTER TABLE api_key_health ADD COLUMN dropped_cardinality BIGINT NOT NULL DEFAULT 0;
ALTER TABLE api_key_health_windows ADD COLUMN dropped_cardinality BIGINT NOT NULL DEFAULT 0;
