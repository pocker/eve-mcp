import { Layout } from "../web/layout";
import { ActionRow, Button, Empty, Notice, PageHeader, Panel, RowActions } from "../web/ui";

type User = { id: number; isAdmin: boolean };

export type CharRow = { id: number; name: string; needsReauth: boolean };

export type AuthzFields = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  state?: string;
};

export function ErrorPage(props: { message: string; user?: User }) {
  return (
    <Layout title="Cannot authorize" user={props.user}>
      <PageHeader title="Cannot authorize" />
      <Panel tone="danger">
        <p>{props.message}</p>
      </Panel>
    </Layout>
  );
}

// Shown after the consent POST. A 302 to the client would be blocked by the form-action CSP, so the browser follows a link or meta refresh instead.
export function RedirectPage(props: { url: string; user?: User }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="refresh" content={`0;url=${props.url}`} />
        <title>Returning to the app - EVE MCP</title>
      </head>
      <body>
        <p>
          Returning to the app. If nothing happens, <a href={props.url}>continue</a>.
        </p>
      </body>
    </html>
  );
}

// Shared by the consent page and the manage page: which characters, and the separate fitting-write box.
function GrantFields(props: { characters: CharRow[]; all: boolean; allowWrite: boolean; picked?: Set<number> }) {
  return (
    <>
      <fieldset class="panel">
        <legend>Characters this app may read</legend>
        <label>
          <input type="radio" name="all_characters" value="1" checked={props.all} /> All my characters, including ones I link later
        </label>
        <label>
          <input type="radio" name="all_characters" value="0" checked={!props.all} /> Only the characters I tick below
        </label>
        {props.characters.map((c) => (
          <label>
            <input type="checkbox" name="characters" value={String(c.id)} checked={props.picked?.has(c.id) ?? false} />{" "}
            <img src={`https://images.evetech.net/characters/${c.id}/portrait?size=64`} width="64" height="64" alt={c.name} />
            <span>
              {c.name}
              {c.needsReauth && <small class="muted"> (needs sign-in again, data will not load until you re-link it)</small>}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset class="panel warn">
        <legend>Changes</legend>
        <label>
          <input type="checkbox" name="allow_write" value="1" checked={props.allowWrite} /> Allow this app to create and delete fittings (changes in-game data)
        </label>
      </fieldset>
    </>
  );
}

// The name is chosen by the app, so it is never the identity: show where the user lands first, then who vouches for the name.
export function ConsentPage(props: { user: User; clientId: string; clientName: string; redirectHost: string; localhost: boolean; fields: AuthzFields; characters: CharRow[] }) {
  const { fields, characters } = props;
  return (
    <Layout title="Connect an app" user={props.user}>
      <PageHeader title="Connect an app" />
      <Notice>
        An app at <strong>{props.redirectHost}</strong> wants to read your EVE data through EVE MCP. After you allow, you return to <strong>{props.redirectHost}</strong>.
      </Notice>
      {props.clientId.startsWith("https://") ? (
        <p class="muted">
          App identity: <strong>{new URL(props.clientId).host}</strong> (the app calls itself "{props.clientName}").
        </p>
      ) : (
        <Notice tone="warn">
          <strong>Unverified app.</strong> It calls itself "{props.clientName}".
        </Notice>
      )}
      {props.localhost && <Notice tone="warn">This app runs on your own computer. Only continue if you just started it yourself.</Notice>}
      {characters.length === 0 ? (
        <Empty>
          You have no characters yet. <a href="/characters">Add one</a>, then come back.
        </Empty>
      ) : (
        <form method="post" action="/oauth/authorize">
          <input type="hidden" name="client_id" value={fields.client_id} />
          <input type="hidden" name="redirect_uri" value={fields.redirect_uri} />
          <input type="hidden" name="code_challenge" value={fields.code_challenge} />
          <input type="hidden" name="resource" value={fields.resource} />
          {fields.state !== undefined && <input type="hidden" name="state" value={fields.state} />}
          <GrantFields characters={characters} all={true} allowWrite={false} />
          <ActionRow>
            <Button variant="primary" name="decision" value="allow">Allow</Button>
            <Button name="decision" value="deny">Deny</Button>
          </ActionRow>
        </form>
      )}
    </Layout>
  );
}

export type AppRow = { id: number; name: string; all: boolean; allowWrite: boolean; characters: string[]; createdAt: string; lastUsedAt: string | null };

export function AppsPage(props: { user: User; apps: AppRow[]; saved?: string }) {
  return (
    <Layout title="Apps" user={props.user} active="/apps">
      <PageHeader title="Connected apps" />
      {props.saved && (
        <Notice>
          Saved changes to <strong>{props.saved}</strong>.
        </Notice>
      )}
      {props.apps.length === 0 ? (
        <Empty>No apps are connected.</Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th>Characters</th>
                <th>Access</th>
                <th>Connected</th>
                <th>Last used</th>
                <th class="act-h">Actions</th>
              </tr>
            </thead>
            <tbody>
              {props.apps.map((a) => (
                <tr>
                  <td class="name">{a.name}</td>
                  <td class="chars" data-label="Characters">{a.all ? "All characters" : a.characters.join(", ") || "None"}</td>
                  <td data-label="Access">{a.allowWrite ? <span class="pill warn">can write fittings</span> : <span class="pill plain">read only</span>}</td>
                  <td class="nw" data-label="Connected">{a.createdAt}</td>
                  <td class="nw" data-label="Last used">{a.lastUsedAt ?? "never"}</td>
                  <td class="act">
                    <RowActions>
                      <Button small href={`/apps/${a.id}`}>Manage</Button>
                      <form method="post" action={`/apps/${a.id}/revoke`}>
                        <Button small variant="danger">Revoke</Button>
                      </form>
                    </RowActions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}

export function ManagePage(props: { user: User; app: { id: number; name: string; all: boolean; allowWrite: boolean }; characters: CharRow[]; picked: Set<number>; error?: string }) {
  const { app } = props;
  return (
    <Layout title="Manage app" user={props.user} active="/apps">
      <PageHeader title={`Manage ${app.name}`} subtitle="Changes apply at once, also to tokens the app already holds." />
      {props.error && <Notice tone="warn">{props.error}</Notice>}
      {props.characters.length === 0 ? (
        <Empty>
          You have no characters. <a href="/characters">Add one</a>.
        </Empty>
      ) : (
        <form method="post" action={`/apps/${app.id}`}>
          <GrantFields characters={props.characters} all={app.all} allowWrite={app.allowWrite} picked={props.picked} />
          <ActionRow>
            <Button variant="primary">Save</Button>
            <Button variant="link" href="/apps">Cancel</Button>
          </ActionRow>
        </form>
      )}
    </Layout>
  );
}
