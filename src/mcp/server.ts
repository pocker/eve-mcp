import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppError } from "../errors";
import { log } from "../log";
import type { Grant } from "./grant";
import { instructions } from "./instructions";
import { registerPrompts } from "./prompts";
import { tools } from "./tools";
import { toolError, toolOk, type Tool } from "./tools/util";

async function runTool(t: Tool, args: unknown, grant: Grant) {
  try {
    return toolOk(await t.run(args as never, grant));
  } catch (e) {
    if (!(e instanceof AppError)) log("error", "tool failed", { tool: t.name, err: e });
    return toolError(e);
  }
}

// One server per request, built for this grant. Nothing is kept between requests.
export function buildServer(grant: Grant): McpServer {
  const server = new McpServer({ name: "eve-mcp", version: "0.0.0" }, { instructions: instructions() });
  registerPrompts(server);
  for (const t of tools.filter((t) => !t.write || grant.allowWrite)) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: z.object(t.input), annotations: t.annotations },
      ((args: unknown) => runTool(t, args, grant)) as never,
    );
  }
  return server;
}
