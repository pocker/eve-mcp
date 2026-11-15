-- Write permission is a separate, opt-in choice per grant (docs/SECURITY.md, 2026-11-15 decision). Old grants stay read-only.
alter table grants add column allow_write boolean not null default false;
