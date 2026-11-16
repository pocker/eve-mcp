import { Hono, type Context } from "hono";
import { z } from "zod";
import { sql } from "../db/db";
import { decrypt } from "../crypto";
import { config } from "../config";
import { purgeCharacterCache, unlinkCharacter } from "../auth/characters";
import { revokeEveToken } from "../auth/eve-sso";
import { destroySession, requireUser } from "../auth/session";
import type { AppEnv } from "../types";
import { KofiButton, Layout, Mark, REPO_URL } from "./layout";
import { MessagePage } from "./pages";
import { ActionRow, Button, Empty, Notice, PageHeader, Panel, RowActions } from "./ui";
import { EXAMPLES, features } from "../features";
import { CCP_NOTICE, NEVER_SENT, sources, sourceStatus, type SourceStatus } from "../sources";

export const routes = new Hono<AppEnv>();

const id = z.coerce.number().int().positive();
const fmt = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

routes.get("/", (c) => {
  const user = c.var.user;
  return c.html(
    <Layout title="Home" user={user}>
      <section class="hero">
        <svg class="sky" viewBox="0 0 400 260" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M20 200 90 140 170 170 250 80 330 110 380 30" stroke-width="1" />
          <path d="M90 140 120 50 250 80" stroke-width="1" />
          <g fill="currentColor" stroke="none">
            <circle cx="20" cy="200" r="3" /><circle cx="90" cy="140" r="4" /><circle cx="170" cy="170" r="2.5" /><circle cx="250" cy="80" r="4.5" />
            <circle cx="330" cy="110" r="3" /><circle cx="380" cy="30" r="2.5" /><circle cx="120" cy="50" r="2.5" />
            <circle cx="60" cy="60" r="1.5" /><circle cx="210" cy="230" r="1.5" /><circle cx="300" cy="200" r="2" /><circle cx="150" cy="100" r="1.5" /><circle cx="350" cy="190" r="1.5" />
          </g>
        </svg>
        <div>
          <h1>EVE data for your AI assistant</h1>
          <p class="lede">Link your EVE Online characters, then connect Claude, ChatGPT or another MCP client. It can read the characters you allow, and only if you opt in, create and delete fittings.</p>
          <ActionRow>
            {user ? (
              <Button variant="primary" href="/characters">Your characters</Button>
            ) : (
              <Button variant="primary" href="/auth/login?return_to=/characters">Sign in with EVE Online</Button>
            )}
            <Button href="/connect">How to connect</Button>
            <Button href="/features">What is available</Button>
          </ActionRow>
        </div>
        <div class="flow" aria-hidden="true">
          <div class="panel flow-step">
            <div class="faces">
              {[0, 1, 2].map(() => (
                <svg viewBox="0 0 40 40" aria-hidden="true">
                  <circle cx="20" cy="15" r="7" />
                  <path d="M6 38c0-9 6-14 14-14s14 5 14 14z" />
                </svg>
              ))}
            </div>
            <div><strong>Your characters</strong><span>You pick which ones</span></div>
          </div>
          <div class="flow-link"></div>
          <div class="panel accent flow-step">
            <Mark />
            <div><strong>EVE MCP</strong><span>Official ESI, your consent</span></div>
            <span class="pill flow-badge">Read-only by default</span>
          </div>
          <div class="flow-link"></div>
          <div class="panel flow-step">
            <div><strong>Claude, ChatGPT, any MCP client</strong><span>Asks, you approve</span></div>
          </div>
        </div>
      </section>
      <div class="grid-3">
        <Panel><h2>You choose</h2><p>Each app sees all your characters by default, or only the ones you tick. Change it any time on Apps.</p></Panel>
        <Panel><h2>Reads by default</h2><p>It reads your data from EVE's ESI and looks up guides on the EVE University wiki. It can save or delete fittings only if you allow it per app. No orders, no moves, no mail.</p></Panel>
        <Panel><h2>Revoke any time</h2><p>Disconnect an app or delete your account and the stored tokens go too.</p></Panel>
      </div>
    </Layout>,
  );
});

routes.get("/connect", (c) => {
  const url = `${config.publicUrl}/mcp`;
  return c.html(
    <Layout title="Connect" user={c.var.user} active="/connect">
      <PageHeader title="Connect an AI client" subtitle="The client sends you here to sign in and choose which characters it may read." />
      <Panel>
        <h2>Server URL</h2>
        <p class="url">
          <code>{url}</code>
        </p>
      </Panel>
      <div class="grid-3">
        <Panel>
          <h2>Claude</h2>
          <p>Settings, Connectors, Add custom connector. Paste the URL, then connect.</p>
        </Panel>
        <Panel>
          <h2>ChatGPT</h2>
          <p>Settings, Connectors, add a custom connector (developer mode). Paste the URL and choose OAuth.</p>
        </Panel>
        <Panel>
          <h2>Other MCP clients</h2>
          <p>Add a remote MCP server of type Streamable HTTP with the URL above. Authorization is OAuth 2.1, started by the client.</p>
        </Panel>
      </div>
      <p class="muted">
        Curious what it talks to? See <a href="/features">what is available</a>.
      </p>
    </Layout>,
  );
});

// Public, static files for crawlers, LLM agents and browser tabs. No DB, no outbound call.
const PUBLIC_PAGES = ["/", "/connect", "/features", "/privacy"];
const PUBLIC_CACHE = "public, max-age=3600";

routes.get("/robots.txt", (c) =>
  c.text(
    [
      "User-agent: *",
      "Allow: /",
      ...["/account", "/characters", "/apps", "/admin", "/auth/", "/oauth/", "/mcp"].map((p) => `Disallow: ${p}`),
      "",
      `Sitemap: ${config.publicUrl}/sitemap.xml`,
      "",
    ].join("\n"),
    200,
    { "Cache-Control": PUBLIC_CACHE },
  ),
);

routes.get("/sitemap.xml", (c) =>
  c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_PAGES.map((p) => `<url><loc>${config.publicUrl}${p}</loc></url>`).join("\n")}\n</urlset>\n`,
    200,
    { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": PUBLIC_CACHE },
  ),
);

routes.get("/llms.txt", (c) => {
  const base = config.publicUrl;
  const tools = features()
    .groups.map((g) => `### ${g.category}\n\n${g.tools.map((t) => `- \`${t.name}\`: ${t.summary}`).join("\n")}`)
    .join("\n\n");
  const text = `# EVE MCP

> A free, open-source MCP server for EVE Online. Sign in with EVE SSO, link your characters, and connect an LLM client that can then read the characters you allow.

MCP endpoint: ${base}/mcp (Streamable HTTP, OAuth 2.1; the client starts the sign-in).

The server is read-only by default. It can create and delete saved fittings only when the user opts in per app. It also offers static game data, market prices, route danger and EVE University wiki lookups that need no character.

## Connect

- Claude: Settings, Connectors, Add custom connector. Paste the endpoint URL, then connect.
- ChatGPT: Settings, Connectors, add a custom connector (developer mode). Paste the URL and choose OAuth.
- Other MCP clients: add a remote MCP server of type Streamable HTTP with the endpoint URL. Authorization is OAuth 2.1.

## Tools

${tools}

## Links

- [Connect an AI client](${base}/connect): step by step
- [Features](${base}/features): systems, tools, prompts and examples
- [Privacy](${base}/privacy): what is stored and for how long
- [Source code](${REPO_URL}): AGPL-3.0-or-later

${CCP_NOTICE} EVE MCP is an independent tool, not affiliated with CCP Games.
`;
  return c.body(text, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": PUBLIC_CACHE });
});

const staticFile = (file: string, type: string) => (c: Context) =>
  c.body(Bun.file(new URL(`./static/${file}`, import.meta.url)).stream(), 200, { "Content-Type": type, "Cache-Control": "public, max-age=2592000" });
routes.get("/favicon.ico", staticFile("favicon.ico", "image/x-icon"));
routes.get("/favicon.svg", staticFile("favicon.svg", "image/svg+xml"));

function StatusPill(props: { id: string; status: SourceStatus }) {
  const { sde, esi } = props.status;
  if (props.id === "sde") return sde.loaded ? <span class="pill">Build {sde.build_number}, imported {fmt(sde.imported_at)}</span> : <span class="pill warn">Not loaded yet</span>;
  if (props.id === "esi") return esi.state === "ok" ? <span class="pill">Error budget ok</span> : <span class="pill warn">Limited, resets in {esi.resets_in_seconds} s</span>;
  return null;
}

routes.get("/sources", (c) => c.redirect("/features", 301));

const TABS = [
  ["systems", "Connected systems"],
  ["tools", "Tools"],
  ["prompts", "Prompts"],
  ["examples", "Examples"],
] as const;
// Unknown or missing tab falls back to the first one.
const tabQuery = z.object({ tab: z.enum(["systems", "tools", "prompts", "examples"]).catch("systems") });

routes.get("/features", async (c) => {
  const { tab } = tabQuery.parse({ tab: c.req.query("tab") });
  const f = features();
  const status = tab === "systems" ? await sourceStatus() : null;
  const toolCount = f.groups.reduce((n, g) => n + g.tools.length, 0);
  return c.html(
    <Layout title="What's available" user={c.var.user} active="/features">
      <PageHeader title="What's available" subtitle={`Everything your AI assistant can use through this server: ${toolCount} tools, ${f.prompts.length} ready-made prompts and the systems behind them.`} actions={<KofiButton />} />
      <nav class="tabs" aria-label="What's available">
        {TABS.map(([key, label]) => (
          <a href={key === "systems" ? "/features" : `/features?tab=${key}`} aria-current={key === tab ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {tab === "systems" && status && (
        <section class="tabpane" aria-labelledby="systems-h">
          <h2 id="systems-h" class="sr">Connected systems</h2>
          <div class="grid-3">
            <div class="panel stat">
              <span class="muted">Game data (SDE)</span>
              <b>{status.sde.loaded ? `Build ${status.sde.build_number}` : "Not loaded yet"}</b>
              <small class="muted">{status.sde.loaded ? `Imported ${fmt(status.sde.imported_at)}` : "Waiting for the first import"}</small>
            </div>
            <div class="panel stat">
              <span class="muted">ESI error budget</span>
              <b>{status.esi.state === "ok" ? "OK" : "Limited"}</b>
              <small class="muted">{status.esi.state === "ok" ? "Calls to ESI are open" : `Resets in ${status.esi.resets_in_seconds} s`}</small>
            </div>
            <div class="panel stat">
              <span class="muted">Systems we call</span>
              <b>{sources.length}</b>
              <small class="muted">The fixed list below</small>
            </div>
          </div>
          <Notice>{NEVER_SENT}</Notice>
          <div class="grid-3">
            {sources.map((s) => (
              <Panel id={s.id}>
                <div>
                  <h3>{s.name}</h3>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">{s.host}</a>
                </div>
                <p>{s.purpose}</p>
                <ul>
                  {s.provides.map((p) => (
                    <li>{p}</li>
                  ))}
                </ul>
                <div class="tags">
                  <span class="pill plain">{s.freshness}</span>
                  <StatusPill id={s.id} status={status} />
                </div>
                <p><b>Sent to it:</b> {s.sends}</p>
                {s.tools.length > 0 && (
                  <details class="tools">
                    <summary>Used by {s.tools.length} tools</summary>
                    {s.tools.map((t) => (
                      <code>{t}</code>
                    ))}
                  </details>
                )}
                <small class="muted">{s.credit}</small>
              </Panel>
            ))}
          </div>
          <p class="muted">Your browser also loads character portraits from images.evetech.net (CCP's image server). {CCP_NOTICE}</p>
        </section>
      )}
      {tab === "tools" && (
        <section class="tabpane" aria-labelledby="tools-h">
          <h2 id="tools-h" class="sr">Tools</h2>
          <p class="muted">Your assistant picks these itself. "Needs a character" means it reads one of the characters you allowed.</p>
          <div class="grid-2">
            {f.groups.map((g) => (
              <section class={g.tools.length > 8 ? "panel tcat wide" : "panel tcat"} aria-labelledby={`cat-${g.category.replace(/\W+/g, "-")}`}>
                <h3 id={`cat-${g.category.replace(/\W+/g, "-")}`}>{g.category} <span class="pill plain">{g.tools.length}</span></h3>
                <ul>
                  {g.tools.map((t) => (
                    <li>
                      <code>{t.name}</code>
                      <span>{t.summary}</span>
                      <span class="tags">
                        {t.needs_character && <span class="pill plain">Needs a character</span>}
                        {t.changes_game_data && <span class="pill off">Changes game data</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
      )}
      {tab === "prompts" && (
        <section class="tabpane" aria-labelledby="prompts-h">
          <h2 id="prompts-h" class="sr">Prompts</h2>
          <p class="muted">Ready-made requests. In Claude, open the prompt menu (the + button, then the connector) and pick one; your client asks for the arguments.</p>
          <div class="grid-3">
            {f.prompts.map((p) => (
              <Panel>
                <h3>{p.title}</h3>
                <p>{p.description}</p>
                <small class="muted"><code>{p.name}</code> {p.arguments.join(", ")}</small>
              </Panel>
            ))}
          </div>
        </section>
      )}
      {tab === "examples" && (
        <section class="tabpane" aria-labelledby="examples-h">
          <h2 id="examples-h" class="sr">Example questions</h2>
          <p class="muted">Things you can ask once a client is connected.</p>
          <div class="grid-2">
            {EXAMPLES.map((e) => (
              <Panel>{e}</Panel>
            ))}
          </div>
        </section>
      )}
    </Layout>,
  );
});

routes.get("/characters", requireUser, async (c) => {
  const rows = await sql`select character_id, name, linked_at, needs_reauth from characters where user_id = ${c.var.user!.id} order by linked_at`;
  return c.html(
    <Layout title="Characters" user={c.var.user} active="/characters">
      <PageHeader
        title="Characters"
        subtitle={`${rows.length} linked. Re-link keeps a character in your connected apps. Remove also removes it from every connected app.`}
        actions={<Button variant="primary" href="/auth/login?add=1&return_to=/characters">Add character</Button>}
      />
      {rows.length === 0 ? (
        <Empty>No characters linked.</Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Character</th>
                <th>Status</th>
                <th class="act-h">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: { character_id: string; name: string; linked_at: Date; needs_reauth: boolean }) => (
                <tr>
                  <td>
                    <div class="who">
                      <img src={`https://images.evetech.net/characters/${r.character_id}/portrait?size=64`} width="64" height="64" alt={r.name} />
                      <div>
                        <b>{r.name}</b>
                        <small>Linked {fmt(r.linked_at)}</small>
                      </div>
                    </div>
                  </td>
                  <td data-label="Status">{r.needs_reauth ? <span class="pill warn">needs re-link</span> : <span class="pill">Active</span>}</td>
                  <td class="act">
                    <RowActions>
                      <Button small href="/auth/login?add=1&return_to=/characters">Re-link</Button>
                      <form method="post" action={`/characters/${Number(r.character_id)}/remove`}>
                        <Button small variant="danger" title="Also removes this character from every connected app">Remove</Button>
                      </form>
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>,
  );
});

routes.post("/characters/:id/remove", requireUser, async (c) => {
  const cid = id.safeParse(c.req.param("id"));
  const [own] = cid.success ? await sql`select 1 from characters where character_id = ${cid.data} and user_id = ${c.var.user!.id}` : [];
  if (!own) return c.html(<MessagePage title="Not found" message="No such character on your account." user={c.var.user} />, 404);
  await unlinkCharacter(cid.data!, "removed_by_user");
  return c.redirect("/characters");
});

// Every claim here is checked against the code: src/db/prune.ts, src/auth/session.ts, src/oauth/routes.tsx, deleteUser below.
function PrivacyText(props: { short?: boolean }) {
  return (
    <>
      <p>What we store about you:</p>
      <ul>
        <li>Your account id (no name, email or password).</li>
        <li>The EVE characters you link, with their EVE refresh tokens encrypted (AES-256-GCM).</li>
        <li>Hashes of your session and of the tokens we give to connected apps, never the tokens themselves.</li>
        <li>Your connected apps and which of your characters each one may see.</li>
        <li>A cache of ESI responses, so the same data is not fetched twice. Data from your characters is cached per character.</li>
        <li>An audit log of security events: account creation, character linking and unlinking, app grants and revokes, fitting writes and admin actions.</li>
      </ul>
      <p>How long we keep it:</p>
      <ul>
        <li>A session lasts 30 days and is renewed when you use it; expired ones are deleted. Sign-in states last 10 minutes.</li>
        <li>App access tokens last 1 hour and refresh tokens 30 days; expired ones are deleted.</li>
        <li>Cached ESI responses are deleted about a day after they expire, and at once when you remove a character or your account.</li>
        <li>The audit log is removed when you delete your account.</li>
        <li>When an app (MCP client) registers with us, we log its name and the IP address it registered from, for abuse checks. This is not tied to an account and is deleted after 90 days.</li>
        <li>Characters, tokens and app grants stay until you remove them or delete your account.</li>
      </ul>
      <p>We keep no usage tracking, analytics or ads. The outside systems we call are listed on <a href="/features">Features</a>.</p>
      {!props.short && <p>Deleting your account removes everything above and asks EVE to revoke the stored tokens. You can do this on the <a href="/account">Account</a> page.</p>}
    </>
  );
}

routes.get("/privacy", (c) =>
  c.html(
    <Layout title="Privacy" user={c.var.user}>
      <PageHeader title="Privacy" />
      <Panel>
        <PrivacyText />
      </Panel>
    </Layout>,
  ),
);

routes.get("/account", requireUser, async (c) => {
  return c.html(
    <Layout title="Account" user={c.var.user} active="/account">
      <PageHeader title="Account" />
      <Panel>
        <h2>Privacy</h2>
        <PrivacyText short />
      </Panel>
      <Panel tone="danger">
        <h2>Delete account</h2>
        <p>Deleting your account removes your characters, stored EVE tokens and connected apps. It cannot be undone.</p>
        <form method="post" action="/account/delete">
          <ActionRow>
            <Button variant="danger">Delete my account</Button>
          </ActionRow>
        </form>
      </Panel>
    </Layout>,
  );
});

// Revokes each character's EVE token (best effort), then deletes the user (cascade) and cached ESI data.
async function deleteUser(userId: number) {
  const rows = await sql`select character_id, refresh_token_enc from characters where user_id = ${userId}`;
  for (const r of rows) {
    if (!r.refresh_token_enc) continue;
    try {
      await revokeEveToken(await decrypt(r.refresh_token_enc));
    } catch {
      // best effort: the row is deleted below anyway
    }
  }
  await sql`delete from users where id = ${userId}`;
  await purgeCharacterCache(rows.map((r: { character_id: string }) => Number(r.character_id)));
}

routes.post("/account/delete", requireUser, async (c) => {
  await destroySession(c);
  await deleteUser(c.var.user!.id);
  return c.redirect("/");
});

const admin = new Hono<AppEnv>();
admin.use(requireUser);
admin.use(async (c, next) => {
  if (!c.var.user?.isAdmin) return c.html(<MessagePage title="Forbidden" message="Admins only." user={c.var.user} />, 403);
  await next();
});

type UserRow = { id: number; created_at: Date; disabled_at: Date | null; names: string[]; is_admin: boolean };
const loadUsers = (only: number | null = null) => sql`
  select u.id, u.created_at, u.disabled_at,
    coalesce(array_agg(ch.name order by ch.name) filter (where ch.name is not null), '{}') as names,
    coalesce(bool_or(ch.character_id = any(${sql.array(config.adminCharacterIds, "BIGINT")})), false) as is_admin
  from users u left join characters ch on ch.user_id = u.id
  where (${only}::bigint is null or u.id = ${only})
  group by u.id order by u.id` as Promise<UserRow[]>;

admin.get("/users", async (c) => {
  const rows = await loadUsers();
  const me = c.var.user!.id;
  const disabled = rows.filter((r) => r.disabled_at).length;
  return c.html(
    <Layout title="Users" user={c.var.user} active="/admin/users">
      <PageHeader
        title="Users"
        subtitle={`${rows.length} accounts`}
        actions={
          <>
            <span class="pill">{rows.length - disabled} active</span> <span class="pill off">{disabled} disabled</span>
          </>
        }
      />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Characters</th>
              <th>Created</th>
              <th>Status</th>
              <th class="act-h">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const self = Number(r.id) === me;
              return (
                <tr>
                  <td class="num" data-label="ID">{r.id}</td>
                  <td class="chars" data-label="Characters">
                    {r.names.length ? r.names.join(", ") : <span class="muted">none</span>}
                    {r.names.length > 1 && <small class="muted"> ({r.names.length})</small>}
                  </td>
                  <td class="nw" data-label="Created">{fmt(r.created_at)}</td>
                  <td data-label="Status">
                    <div class="tags">
                      {r.disabled_at ? <span class="pill off">disabled {fmt(r.disabled_at)}</span> : <span class="pill">active</span>}
                      {r.is_admin && <span class="pill plain">admin</span>}
                    </div>
                  </td>
                  <td class="act">
                    <RowActions>
                      {self ? (
                        <span />
                      ) : (
                        <form method="post" action={`/admin/users/${r.id}/${r.disabled_at ? "enable" : "disable"}`}>
                          <Button small>{r.disabled_at ? "Enable" : "Disable"}</Button>
                        </form>
                      )}
                      {self ? <span class="muted">you</span> : r.is_admin ? <span class="muted">admin</span> : <Button small variant="danger" href={`/admin/users/${r.id}/delete`}>Delete…</Button>}
                    </RowActions>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

// Confirm page: shows who goes away. The POST below re-checks everything.
admin.get("/users/:id/delete", async (c) => {
  const uid = id.safeParse(c.req.param("id"));
  if (!uid.success) return c.html(<MessagePage title="Not found" message="No such user." user={c.var.user} />, 404);
  if (uid.data === c.var.user!.id) return c.html(<MessagePage title="Refused" message="You cannot delete yourself here. Use your account page." user={c.var.user} />, 400);
  const [t] = await loadUsers(uid.data);
  if (!t) return c.html(<MessagePage title="Not found" message="No such user." user={c.var.user} />, 404);
  if (t.is_admin) return c.html(<MessagePage title="Refused" message="That user is an admin. Remove their character from ADMIN_CHARACTER_IDS first." user={c.var.user} />, 400);
  return c.html(
    <Layout title="Delete user" user={c.var.user} active="/admin/users">
      <PageHeader title={`Delete user ${t.id}?`} />
      <Panel tone="danger">
        <p>This removes the account, its {t.names.length} linked {t.names.length === 1 ? "character" : "characters"}, tokens, grants and sessions. It cannot be undone.</p>
        <p class="who-list">{t.names.length ? t.names.join(", ") : <span class="muted">No characters</span>}</p>
        <p class="muted">Created {fmt(t.created_at)}</p>
        <form method="post" action={`/admin/users/${t.id}/delete`}>
          <label>
            <input type="checkbox" name="confirm" value="yes" required /> Yes, delete this user for good
          </label>
          <ActionRow>
            <Button variant="danger">Delete user</Button>
            <Button variant="link" href="/admin/users">Cancel</Button>
          </ActionRow>
        </form>
      </Panel>
    </Layout>,
  );
});

for (const action of ["disable", "enable"] as const) {
  admin.post(`/users/:id/${action}`, async (c) => {
    const uid = id.safeParse(c.req.param("id"));
    if (!uid.success) return c.html(<MessagePage title="Not found" message="No such user." user={c.var.user} />, 404);
    if (uid.data === c.var.user!.id) return c.html(<MessagePage title="Refused" message="You cannot change your own status." user={c.var.user} />, 400);
    if (action === "disable") {
      await sql`update users set disabled_at = now() where id = ${uid.data}`;
      await sql`delete from sessions where user_id = ${uid.data}`;
    } else {
      await sql`update users set disabled_at = null where id = ${uid.data}`;
    }
    await sql`insert into audit_log (user_id, event, detail) values (${uid.data}, ${`user_${action}d`}, ${JSON.stringify({ by: c.var.user!.id })}::jsonb)`;
    return c.redirect("/admin/users");
  });
}

// CSRF: covered by the global csrf() and header checks in src/index.ts, like the routes above.
admin.post("/users/:id/delete", async (c) => {
  const uid = id.safeParse(c.req.param("id"));
  if (!uid.success) return c.html(<MessagePage title="Not found" message="No such user." user={c.var.user} />, 404);
  const body = await c.req.parseBody();
  if (!z.object({ confirm: z.literal("yes") }).safeParse(body).success) return c.html(<MessagePage title="Refused" message="Tick the confirm box to delete a user." user={c.var.user} />, 400);
  if (uid.data === c.var.user!.id) return c.html(<MessagePage title="Refused" message="You cannot delete yourself here. Use your account page." user={c.var.user} />, 400);
  const [target] = await sql`select exists(select 1 from characters where user_id = ${uid.data} and character_id = any(${sql.array(config.adminCharacterIds, "BIGINT")})) as is_admin from users where id = ${uid.data}`;
  if (!target) return c.html(<MessagePage title="Not found" message="No such user." user={c.var.user} />, 404);
  if (target.is_admin) return c.html(<MessagePage title="Refused" message="That user is an admin. Remove their character from ADMIN_CHARACTER_IDS first." user={c.var.user} />, 400);
  await deleteUser(uid.data);
  // audit_log rows cascade with the deleted user, so the event is kept under the admin.
  await sql`insert into audit_log (user_id, event, detail) values (${c.var.user!.id}, 'user_deleted', ${JSON.stringify({ by: c.var.user!.id, deleted_user: uid.data })}::jsonb)`;
  return c.redirect("/admin/users");
});
routes.route("/admin", admin);
