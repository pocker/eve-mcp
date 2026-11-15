import { readFileSync } from "node:fs";
import type { Child } from "hono/jsx";
import { sha256 } from "../crypto";
import { CCP_NOTICE } from "../sources";
import { Button } from "./ui";

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
            <a href="https://github.com/pocker/eve-mcp" rel="noopener noreferrer">Source</a>
          </span>
        </footer>
      </body>
    </html>
  );
}
