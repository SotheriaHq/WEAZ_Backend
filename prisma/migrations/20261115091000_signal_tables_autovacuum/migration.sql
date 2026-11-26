BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Table-local settings only. Immutable snapshots and unrelated tables retain
-- their existing settings. The deployment preflight records previous reloptions.
ALTER TABLE public.user_feed_signals SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.user_seen_items SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.market_section_signals SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.suggestion_signals SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.market_item_features SET (autovacuum_vacuum_scale_factor = 0.05);

COMMIT;
