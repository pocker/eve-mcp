-- ESI per-route-group rate limits (token buckets per app and character). Shared by all replicas.
-- Two row kinds: a bucket "<group>#<character_id|public>" holds the last seen limit state;
-- a route row "route:<METHOD> <path template>" remembers which group that route belongs to (grp).
-- Only a cache of limits: losing it on a Postgres crash is fine.
create unlogged table esi_buckets (
  bucket       text primary key,
  grp          text,
  remaining    int,
  lim          int,
  reset_at     timestamptz,
  paused_until timestamptz,
  updated_at   timestamptz not null default now()
);
create index esi_buckets_updated_at_idx on esi_buckets (updated_at);
