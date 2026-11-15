# AI Agent Instructions

## Project

**eve-mcp** is an internet-facing MCP server. People sign in with EVE Online SSO, link one or more
EVE characters to their account, then connect an LLM client (Claude, ChatGPT, Cursor, ...) over
MCP. The LLM can then read that person's in-game data through the EVE ESI API, and only the
characters the person allowed.

Stack: Bun + TypeScript, Hono (HTTP + server-rendered JSX pages), `@modelcontextprotocol/sdk`
(Streamable HTTP), Postgres 17 through Bun's built-in `Bun.sql`, `jose` (EVE JWT checks), `zod`
(input validation). Deployed with Docker Compose on a NAS (`docker-compose.yml`), behind the owner's own reverse proxy.

## Read first, update after

- **Before any task:** read [ARCHITECTURE.md](ARCHITECTURE.md). If the task touches auth, tokens,
  or anything a stranger on the internet can reach, also read [docs/SECURITY.md](docs/SECURITY.md).
  The roadmap is in [docs/PLAN.md](docs/PLAN.md).
- **After any change, in the same change:**
  - New module, route, table, env var, MCP tool or ESI scope: update [ARCHITECTURE.md](ARCHITECTURE.md).
  - New external system (a new host we call): add it to `src/sources.ts` and to the fixed host list in [docs/SECURITY.md](docs/SECURITY.md). New MCP tool: add its entry in `src/features.ts` (a test fails otherwise).
  - Change to auth, sessions, token storage, rate limits or exposed surface: update [docs/SECURITY.md](docs/SECURITY.md).
  - A phase item done: tick it in [docs/PLAN.md](docs/PLAN.md).
  - Setup or run steps changed: update [README.md](README.md) and `.env.example`.
  - New service, secret, volume or env var in production: update `docker-compose.yml` and the
    "Deployment" section of ARCHITECTURE.md.
- Stale docs are a bug. Fix them when you see them.

## How agents work here

- Follow `.claude/skills/ponytail` for code: the smallest change that fully works. No dependency
  for a few lines. No "for later" code.
- Follow `.claude/skills/caveman` for chat replies: terse, answer first. Docs, code comments,
  commits and PR text stay in plain, simple English (caveman's own rule).
- Ask when the task has two reasonable meanings. Give a default so the answer can be "yes".
- Say what you did not run or check. Never claim a test passed that you did not run.

## Commands

```sh
bun install          # deps
bun run db:up        # local Postgres (docker compose), localhost:5432
bun run dev          # watch mode, http://localhost:3000 (runs migrations at start)
bun test             # all tests (needs db:up)
bun run typecheck    # tsc --noEmit
bun run db:migrate   # apply SQL migrations in src/db/migrations
```

## The app must stay safe to run as multiple replicas

Compose runs one app container, but keep the code replica-safe. Never keep state that must be shared in memory: sessions,
tokens, OAuth codes, ESI cache and the ESI error budget live in Postgres. Work that must run once
(refresh one character's token, prune, migrate) takes a Postgres advisory lock.

## Hard rules (security, never cut)

These exist because the server is on the public internet and holds other people's EVE tokens.

1. **Tenant isolation.** Every character tool resolves the character through the MCP grant
   (`grant -> user -> character`). Never accept a `character_id` from tool input without that
   check. Every new character tool gets a test that calls it with another user's character and
   expects a refusal.
2. **Tokens at rest.** EVE refresh tokens are encrypted (AES-256-GCM, `src/crypto.ts`). Our own
   secrets (session IDs, OAuth codes, access and refresh tokens) are stored only as SHA-256 hashes.
   Never log a token, a code, an `Authorization` header or a cookie.
3. **Read-only by default.** Write scopes only with a recorded decision in docs/SECURITY.md (currently: fittings). Every other scope is `*.read_*`, and a write tool is only offered to grants that opted in.
4. **ESI text is untrusted.** Names, bios, contract titles, mail and notes can hold prompt
   injection. Return them as data fields, never as instructions, and cap their length.
5. **Validate at the edge.** Every HTTP body, query and MCP tool input goes through a `zod` schema.
6. **Be a good ESI citizen.** Send `User-Agent` and `X-Compatibility-Date`, respect `Expires` /
   `ETag` caching, and stop calling when the error limit is low (see ARCHITECTURE.md, "ESI client").
7. **Owner hash.** When EVE reports a new `owner` hash for a character (the character was sold or
   moved to another EVE account), unlink it from the old user and delete its tokens.

## Code style

- Strict TypeScript, ES modules, no `any` except at JSON edges (then parse with zod).
- Plain functions and modules. No classes unless state needs them (ESI client, rate limiter).
- Errors: throw `AppError(code, message)`; MCP tools turn it into a tool error result, HTTP
  routes into a status code. Never leak stack traces to clients.
- Tests next to the area in `test/`, using `bun test` against the local Postgres (each test file
  uses its own schema, dropped after). Stub ESI with a fake `fetch`, never call the real ESI
  from tests.
- SQL: tagged templates from `Bun.sql` only (parameterised). Never build SQL with string
  concatenation.
- Comment only the "why". Known limits get `// shortcut: <limit>, <when to upgrade>`.
