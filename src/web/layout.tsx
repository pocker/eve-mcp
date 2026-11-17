import { readFileSync } from "node:fs";
import type { Child } from "hono/jsx";
import { sha256 } from "../crypto";
import { CCP_NOTICE } from "../sources";
import { Button } from "./ui";

export const REPO_URL = "https://github.com/pocker/eve-mcp";

// git archive fills src/version.txt with the commit hash (export-subst). Unreplaced or empty means local dev.
const raw = readFileSync(new URL("../version.txt", import.meta.url), "utf8").trim();
const commit = /^[0-9a-f]{40}$/.test(raw) ? raw : null;

// Content hash in the URL lets the stylesheet be cached forever (Cloudflare included) yet change on deploy.
export const cssVersion = sha256(readFileSync(new URL("./app.css", import.meta.url), "utf8")).slice(0, 10);

// Our own mark: a ring with a link node, not CCP artwork.
export function Mark() {
  return (
    <svg class="mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
      <circle cx="16" cy="16" r="11" />
      <path d="M5 16h7M20 16h7" />
      <circle cx="16" cy="16" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function KofiButton() {
  return (
    <a class="btn btn-secondary" href="https://ko-fi.com/pamera" rel="noopener noreferrer">
      Buy me a coffee
    </a>
  );
}

export function Layout(props: { title: string; user?: { id: number; isAdmin: boolean } | null; active?: string; children?: Child }) {
  const { title, user, active, children } = props;
  const link = (href: string, label: string) => (
    <a href={href} aria-current={active === href ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} - EVE MCP</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="stylesheet" href={`/static/app.css?v=${cssVersion}`} />
      </head>
      <body>
        <header class="bar">
          <div class="bar-in">
            <a class="brand" href="/">
              <Mark />
              EVE MCP
            </a>
            <nav class="nav" aria-label="Main">
              {user && (
                <>
                  {link("/characters", "Characters")}
                  {link("/apps", "Apps")}
                  {link("/connect", "Connect")}
                  {link("/account", "Account")}
                  {user.isAdmin && link("/admin/users", "Users")}
                </>
              )}
              {link("/features", "Features")}
            </nav>
            {user && (
              <form class="logout" method="post" action="/auth/logout">
                <Button variant="link">Log out</Button>
              </form>
            )}
          </div>
        </header>
        <main>{children}</main>
        <footer class="foot">EVE MCP is an independent tool, not affiliated with CCP Games. {CCP_NOTICE}
          <br />
          <span class="support">
            <KofiButton />
            <span>Free to use. Donations are voluntary, help cover hosting and unlock nothing.</span>
            <a href="/privacy">Privacy</a>
            <a href={REPO_URL} rel="noopener noreferrer">Source</a>
            {commit ? <a href={`${REPO_URL}/commit/${commit}`} rel="noopener noreferrer">Version {commit.slice(0, 7)}</a> : <span>Version dev</span>}
          </span>
        </footer>
      </body>
    </html>
  );
}
