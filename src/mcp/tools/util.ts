import { z } from "zod";
import { AppError } from "../../errors";
import { requireCharacter, type CharacterRow, type Grant } from "../grant";

export const MAX_OUTPUT_CHARS = 40_000;

export type Annotations = { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };

export type Tool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  run: (input: never, grant: Grant) => Promise<unknown>;
  write: boolean;
  annotations: Annotations;
};

// Set `write` on a tool that changes game data. It is then only listed for grants with allowWrite, and refuses at call time without it.
type WriteMode = { destructive: boolean };

export function defineTool<S extends z.ZodRawShape>(t: {
  name: string;
  description: string;
  input: S;
  write?: WriteMode;
  run: (input: z.infer<z.ZodObject<S>>, grant: Grant) => Promise<unknown>;
}): Tool {
  const { write, run, ...rest } = t;
  return {
    ...rest,
    write: !!write,
    annotations: write ? { readOnlyHint: false, destructiveHint: write.destructive, idempotentHint: false, openWorldHint: true } : { readOnlyHint: true, openWorldHint: true },
    run: async (i: never, grant: Grant) => {
      if (write && !grant.allowWrite) throw new AppError("write_not_allowed", "This connection may not change game data. Reconnect the app and tick the write permission.", 403);
      return run(i as z.infer<z.ZodObject<S>>, grant);
    },
  } as unknown as Tool;
}

// Every tool that reads one character's data goes through here, so requireCharacter cannot be forgotten.
export function characterTool<S extends z.ZodRawShape>(t: {
  name: string;
  description: string;
  input: S;
  write?: WriteMode;
  run: (input: z.infer<z.ZodObject<S>>, character: CharacterRow, grant: Grant) => Promise<unknown>;
}): Tool {
  const input = { character_id: z.number().int().positive().describe("EVE character ID, from list_characters"), ...t.input };
  return defineTool({
    ...t,
    input,
    run: async (i, grant) => t.run(i as z.infer<z.ZodObject<S>>, await requireCharacter(grant, (i as { character_id: number }).character_id), grant),
  });
}

// ESI free text (names, titles, descriptions) is untrusted: cap it and only ever return it as a data field.
export const clip = (s: unknown, n = 200) => (typeof s === "string" ? s.slice(0, n) : null);

export function cap<T>(items: T[], n: number) {
  return items.length > n ? { items: items.slice(0, n), truncated: `showing ${n} of ${items.length}` } : { items };
}

export function toText(v: unknown): string {
  const s = JSON.stringify(v);
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)} ...[output truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request]`;
}

export function toolError(e: unknown) {
  const message = e instanceof AppError ? e.message : "Internal error. Try again later.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export const toolOk = (v: unknown) => ({ content: [{ type: "text" as const, text: toText(v) }] });
