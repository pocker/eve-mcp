import type { Grant } from "./mcp/grant";

// Shared Hono env: every router is `new Hono<AppEnv>()`.
export type AppEnv = {
  Variables: {
    user?: { id: number; isAdmin: boolean };
    grant?: Grant;
  };
};
