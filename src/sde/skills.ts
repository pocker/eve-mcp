// Skill math and prerequisite trees. Pure functions: the database and ESI are read by the callers.

export type Req = { skill: number; level: number };
export type SkillNode = { id: number; name: string; rank: number; primary: number | null; secondary: number | null; reqs: Req[] };
export type Have = Map<number, { level: number; sp: number }>;
export type Attrs = Partial<Record<"charisma" | "intelligence" | "memory" | "perception" | "willpower", number>>;
export type Step = { skill_id: number; skill: string; from: number; to: number; sp: number; seconds: number };

// dogma attribute IDs: requiredSkillN and requiredSkillNLevel, skillTimeConstant (rank), primary/secondary attribute
export const REQ_ATTRS: [number, number][] = [[182, 277], [183, 278], [184, 279], [1285, 1286], [1289, 1287], [1290, 1288]];
export const RANK_ATTR = 275;
export const PRIMARY_ATTR = 180;
export const SECONDARY_ATTR = 181;
export const ATTR_NAMES: Record<number, keyof Attrs> = { 164: "charisma", 165: "intelligence", 166: "memory", 167: "perception", 168: "willpower" };

// Total SP at which level L is reached: 250 * rank * 32^((L-1)/2), rounded up (250, 1415, 8000, 45255, 256000 for rank 1).
export const spForLevel = (rank: number, level: number) => (level <= 0 ? 0 : Math.ceil(250 * rank * 32 ** ((level - 1) / 2)));

export function spPerMinute(n: SkillNode, a: Attrs): number {
  const p = n.primary ? a[ATTR_NAMES[n.primary]!] : undefined;
  const s = n.secondary ? a[ATTR_NAMES[n.secondary]!] : undefined;
  if (p === undefined || s === undefined) return 0;
  return p + s / 2;
}

export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

// Max required level per skill over the whole tree, prerequisites first. Skills missing from `nodes` are kept without prerequisites.
export function requiredLevels(roots: Req[], nodes: Map<number, SkillNode>): Map<number, number> {
  const need = new Map<number, number>();
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const r of nodes.get(id)?.reqs ?? []) visit(r.skill);
    order.push(id);
  };
  const raise = (id: number, level: number) => {
    if (level <= (need.get(id) ?? 0)) return;
    need.set(id, level);
  };
  const walk = (id: number, seenWalk: Set<number>) => {
    if (seenWalk.has(id)) return;
    seenWalk.add(id);
    for (const r of nodes.get(id)?.reqs ?? []) {
      raise(r.skill, r.level);
      walk(r.skill, seenWalk);
    }
  };
  const w = new Set<number>();
  for (const r of roots) {
    raise(r.skill, r.level);
    walk(r.skill, w);
  }
  for (const r of roots) visit(r.skill);
  return new Map(order.map((id) => [id, need.get(id)!]));
}

// What is still to train, in prerequisite order, with SP and time for each skill (time is 0 when attributes are unknown).
export function stepsFor(need: Map<number, number>, nodes: Map<number, SkillNode>, have: Have, attrs: Attrs): Step[] {
  const steps: Step[] = [];
  for (const [id, to] of need) {
    const n = nodes.get(id);
    const h = have.get(id);
    if (!n || (h?.level ?? 0) >= to) continue;
    const sp = Math.max(0, spForLevel(n.rank, to) - (h?.sp ?? 0));
    const rate = spPerMinute(n, attrs);
    steps.push({ skill_id: id, skill: n.name, from: h?.level ?? 0, to, sp, seconds: rate ? Math.round((sp / rate) * 60) : 0 });
  }
  return steps;
}
