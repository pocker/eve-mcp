import { config } from "../../config";
import { CCP_NOTICE, NEVER_SENT, sources, sourceStatus } from "../../sources";
import { defineTool } from "./util";

export const aboutSources = {
  ...defineTool({
    name: "about_sources",
    description: "Which external systems this server talks to (EVE SSO, ESI, the static data export, the EVE University wiki, zKillboard): what each provides, how fresh it is, what is sent to it, which tools use it, and live status. Use when the user asks where data comes from. Cite the source name in your answer.",
    input: {},
    run: async () => ({ sources, status: await sourceStatus(), never_sent: NEVER_SENT, notice: CCP_NOTICE, page: `${config.publicUrl}/features` }),
  }),
  // Reads only our own database.
  annotations: { readOnlyHint: true, openWorldHint: false },
};
