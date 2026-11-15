-- One row per MCP tool call, for the user's own usage view. No arguments, no results (they can hold private data).
create table mcp_usage (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  user_id  int not null references users (id) on delete cascade,
  grant_id int references grants (id) on delete set null,
  tool     text not null,
  ok       boolean not null,
  ms       int not null
);
create index mcp_usage_user_at_idx on mcp_usage (user_id, at);
