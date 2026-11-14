import { readFileSync } from "node:fs";
const R = (f) => JSON.parse(readFileSync(new URL(`../web/data/${f}`, import.meta.url)));
export const project = R("project.json");
export const K = R("constants.json");
export const byId = (id) => project.objects.find((o) => o.id === id);
export const link = (o, f) => byId(o.links.find((l) => l.field === f).to);
export function maxDiff(a, b) {
  if (Array.isArray(a)) return Math.max(0, ...a.map((x, i) => maxDiff(x, b[i])));
  return Math.abs(a - b);
}
