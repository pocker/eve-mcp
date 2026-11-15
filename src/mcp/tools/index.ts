import * as c from "./character";
import { theraConnections } from "./evescout";
import * as cm from "./character-more";
import * as m from "./market";
import * as f from "./fittings";
import * as i from "./intel";
import * as n from "./news";
import * as s from "./sde";
import { aboutSources } from "./sources";
import * as u from "./universe";
import * as w from "./wiki";
import * as z from "./zkill";
import type { Tool } from "./util";

// The tool list (ARCHITECTURE.md, "Tools"). Character tools are built with characterTool(). Write tools are only served to grants with allowWrite.
export const tools: Tool[] = [
  c.listCharacters,
  c.characterOverview,
  c.getSkills,
  c.getSkillQueue,
  c.getWalletJournal,
  c.getAssets,
  c.getMarketOrders,
  c.getIndustryJobs,
  f.getFittings,
  f.createFitting,
  f.deleteFitting,
  u.resolveNames,
  s.getTypeInfo,
  u.planRoute,
  u.getServerStatus,
  i.systemInfo,
  i.routeSafety,
  i.incursions,
  i.sovereignty,
  i.factionWarfare,
  i.militaryCampaigns,
  theraConnections,
  z.zkillStats,
  z.zkillKills,
  z.killmailDetail,
  w.wikiSearchTool,
  w.wikiPageTool,
  s.skillRequirements,
  s.canFly,
  s.skillPlan,
  s.blueprintInfo,
  m.hubPrices,
  m.priceHistory,
  m.appraiseAssets,
  cm.getContracts,
  cm.getContractItems,
  cm.getClones,
  cm.getKillmails,
  cm.getWalletTransactions,
  cm.getStandings,
  cm.getLoyaltyPoints,
  cm.getMiningLedger,
  cm.getPlanets,
  cm.getAttributes,
  cm.getMilitaryParticipation,
  n.ccpNews,
  n.sdeChangesTool,
  aboutSources,
];
