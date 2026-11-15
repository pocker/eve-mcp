-- Full v1 schema. See ARCHITECTURE.md "Data model".
-- EVE IDs are bigint. Our own IDs (users, grants) are int.

create table users (
  id          int generated always as identity primary key,
  created_at  timestamptz not null default now(),
  disabled_at timestamptz,
  is_admin    boolean not null default false
);

create table characters (
  character_id      bigint primary key,
  user_id           int not null references users (id) on delete cascade,
  name              text not null,
  owner_hash        text not null,
  scopes            text[] not null default '{}',
  refresh_token_enc bytea,
  access_token_enc  bytea,
  access_expires_at timestamptz,
  needs_reauth      boolean not null default false,
  linked_at         timestamptz not null default now()
);
create index characters_user_id_idx on characters (user_id);

create table sessions (
  id_hash    text primary key,
  user_id    int not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table sso_states (
  state      text primary key,
  purpose    text not null check (purpose in ('login', 'add', 'oauth')),
  user_id    int references users (id) on delete cascade,
  return_to  text not null default '/',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sso_states_user_id_idx on sso_states (user_id);
create index sso_states_expires_at_idx on sso_states (expires_at);

create table oauth_clients (
  client_id     text primary key,
  name          text not null,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

create table grants (
  id             int generated always as identity primary key,
  user_id        int not null references users (id) on delete cascade,
  client_id      text not null references oauth_clients (client_id) on delete cascade,
  all_characters boolean not null default false,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);
create index grants_user_id_idx on grants (user_id);
create index grants_client_id_idx on grants (client_id);

create table grant_characters (
  grant_id     int not null references grants (id) on delete cascade,
  character_id bigint not null references characters (character_id) on delete cascade,
  primary key (grant_id, character_id)
);
create index grant_characters_character_id_idx on grant_characters (character_id);

create table oauth_codes (
  code_hash      text primary key,
  client_id      text not null references oauth_clients (client_id) on delete cascade,
  grant_id       int not null references grants (id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);
create index oauth_codes_grant_id_idx on oauth_codes (grant_id);
create index oauth_codes_client_id_idx on oauth_codes (client_id);
create index oauth_codes_expires_at_idx on oauth_codes (expires_at);

create table oauth_tokens (
  token_hash  text primary key,
  kind        text not null check (kind in ('access', 'refresh')),
  grant_id    int not null references grants (id) on delete cascade,
  resource    text not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  replaced_by text -- token_hash of the refresh token that replaced this one
);
create index oauth_tokens_grant_id_idx on oauth_tokens (grant_id);
create index oauth_tokens_expires_at_idx on oauth_tokens (expires_at);

-- Shared by all replicas. Losing it on a Postgres crash is fine: it is only a cache.
create unlogged table esi_cache (
  key        text primary key,
  etag       text,
  expires_at timestamptz not null,
  body       jsonb not null
);
create index esi_cache_expires_at_idx on esi_cache (expires_at);

-- Single row (id = 1): last seen ESI error limit, shared by all replicas.
create table esi_status (
  id                   smallint primary key default 1 check (id = 1),
  error_limit_remain   int,
  error_limit_reset_at timestamptz
);
insert into esi_status (id) values (1);

create table audit_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  user_id int references users (id) on delete cascade,
  event   text not null,
  detail  jsonb not null default '{}'
);
create index audit_log_user_id_idx on audit_log (user_id);
create index audit_log_at_idx on audit_log (at);
