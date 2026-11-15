import type { Child } from "hono/jsx";

// Shared UI parts. Pages use these instead of hand-writing markup; app.css has the matching styles.
// Rules (also in ARCHITECTURE.md, "UI conventions"): one size per button, `small` only in table rows.

type Variant = "primary" | "secondary" | "danger" | "link";

export function Button(props: { variant?: Variant; small?: boolean; href?: string; name?: string; value?: string; title?: string; children?: Child }) {
  const cls = `btn btn-${props.variant ?? "secondary"}${props.small ? " btn-sm" : ""}`;
  if (props.href !== undefined) {
    return (
      <a class={cls} href={props.href}>
        {props.children}
      </a>
    );
  }
  return (
    <button type="submit" class={cls} name={props.name} value={props.value} title={props.title}>
      {props.children}
    </button>
  );
}

// Title and subtitle on the left, the page's one primary action (or status) top-right.
export function PageHeader(props: { title: string; subtitle?: Child; actions?: Child }) {
  return (
    <header class="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.subtitle && <p class="muted">{props.subtitle}</p>}
      </div>
      {props.actions && <div class="page-actions">{props.actions}</div>}
    </header>
  );
}

export function Panel(props: { tone?: "accent" | "warn" | "danger"; id?: string; children?: Child }) {
  return (
    <div class={props.tone ? `panel ${props.tone}` : "panel"} id={props.id}>
      {props.children}
    </div>
  );
}

// A short message above the content. Same look as a panel, tinted.
export function Notice(props: { tone?: "accent" | "warn"; children?: Child }) {
  return (
    <div class={`panel ${props.tone ?? "accent"}`}>
      <p>{props.children}</p>
    </div>
  );
}

// Form buttons: submit bottom-left, Cancel next to it.
export function ActionRow(props: { children?: Child }) {
  return <div class="actions">{props.children}</div>;
}

// Per-row actions in a table: two fixed slots at the right edge, safe action first, danger last.
export function RowActions(props: { children?: Child }) {
  return <div class="row-actions">{props.children}</div>;
}

export function Empty(props: { children?: Child }) {
  return (
    <div class="empty">
      <p>{props.children}</p>
    </div>
  );
}
