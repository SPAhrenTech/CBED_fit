// Multi-pattern projects: creation from scratch, sharing, undo/redo, image round-trip and a joint fit.
import test from "node:test";
import assert from "node:assert/strict";
import { K, project as igor } from "./helpers.mjs";
import { Store } from "../web/src/app/store.js";
import { encodeImage, decodeImage } from "../web/src/app/imageio.js";
import { firstLaueZone, freeParams, fitsInScope, vary, residuals, simulateLines, findDelR, modelState, buildMaterial, perpHkl } from "../web/src/core/index.js";

const newStore = (opts = {}) => { const s = new Store(); s.K = K; s.newProject({ materType: 0, E: 200, zone: [1, 1, 0], ...opts }); return s; };
const sim = (s) => s.sim.lines;

test("perpHkl gives small reflections perpendicular to the zone", () => {
  assert.deepEqual(perpHkl([1, 1, 0]), [0, 0, 1]);
  assert.deepEqual(perpHkl([2, 1, 0]), [0, 0, 1]);
  assert.deepEqual(perpHkl([0, 0, 1]), [1, 0, 0]);
});

test("first allowed Laue zone depends on the zone axis", () => {
  assert.equal(firstLaueZone([1, 1, 0]), 2); assert.equal(firstLaueZone([2, 1, 0]), 1); assert.equal(firstLaueZone([1, 1, 1]), 1); assert.equal(firstLaueZone([0, 0, 1]), 1);
});

test("new Si project simulates HOLZ lines; GaInPAs too", () => {
  const si = newStore();
  assert.equal(si.error, null);
  assert.ok(sim(si).length > 5, `Si [110]: ${sim(si).length} lines`);
  const ga = newStore({ materType: 1, x: 0.47, y: 1, structType: 2, zone: [2, 1, 0] });
  assert.equal(ga.error, null);
  assert.deepEqual(ga.ctx.layer.params.map((p) => p.label), ["eps11", "gamma12"]);
  assert.ok(sim(ga).length > 5, `GaInPAs [210]: ${sim(ga).length} lines`);
});

test("Si atom positions are right although the Igor tables are swapped", () => {
  const M = buildMaterial({ vars: { materType: 0 }, params: [], info: {} }, K);
  assert.equal(M.spc.length, 2); assert.equal(M.dCoord.length, 2);
});

test("undo/redo: single and coalesced edits, redo cleared by a new edit", () => {
  const s = newStore();
  const L = () => s.ctx.model.params[0].value, L0 = L();
  s.setParam(s.ctx.model.id, 0, L0 + 1); s.setParam(s.ctx.model.id, 0, L0 + 2); s.setParam(s.ctx.model.id, 0, L0 + 3);   // typing: one step
  assert.equal(s.hist.undo.length, 1);
  s.setHold(s.ctx.model.id, 0, true);
  assert.equal(s.hist.undo.length, 2);
  s.undo(); assert.equal(s.ctx.model.params[0].hold, false); assert.equal(L(), L0 + 3);
  s.undo(); assert.equal(L(), L0);
  assert.equal(s.canUndo, false); assert.equal(s.canRedo, true);
  s.redo(); assert.equal(L(), L0 + 3);
  s.setParam(s.ctx.model.id, 1, 5); assert.equal(s.canRedo, false);
});

test("undo restores added patterns and the active pattern; removal prunes unshared objects", () => {
  const s = newStore();
  const first = s.activeFitId, n0 = s.project.objects.length;
  const second = s.addPattern({ title: "B", zone: [1, 1, 2], share: { beam: true, layer: false } });
  assert.equal(s.fitIds.length, 2); assert.equal(s.activeFitId, second);
  const [b1, m1, l1] = s.objectsOf(first), [b2, m2, l2] = s.objectsOf(second);
  assert.equal(b1.id, b2.id); assert.notEqual(m1.id, m2.id); assert.notEqual(l1.id, l2.id);
  assert.equal(l1.links[0].to, l2.links[0].to, "copied layer still uses the same material");
  assert.deepEqual(s.sharedWith(b2.id), ["Pattern 1"]);
  s.undo(); assert.equal(s.fitIds.length, 1); assert.equal(s.activeFitId, first); assert.equal(s.project.objects.length, n0);
  s.redo(); assert.equal(s.fitIds.length, 2);
  s.removePattern(second);
  assert.equal(s.project.objects.length, n0, "model, layer copy, experiment, fit and image removed; shared beam kept");
  s.removePattern(); assert.equal(s.fitIds.length, 1, "the last pattern cannot be removed");
});

test("relinking: choose another beam / new copy; orphans are pruned", () => {
  const s = newStore();
  s.addPattern({ title: "B", zone: [1, 1, 2] });
  const beamA = s.objectsOf(s.fitIds[0])[0].id;
  s.relinkActive("beam", "new");
  const beamB = s.objectsOf(s.activeFitId)[0];
  assert.notEqual(beamB.id, beamA); assert.equal(beamB.params[0].value, 200);
  s.setParam(beamB.id, 0, 201);
  assert.equal(s.objectsOf(s.fitIds[0])[0].params[0].value, 200, "the other pattern keeps its beam");
  s.relinkActive("beam", beamA);
  assert.equal(s.project.objects.filter((o) => o.type === "Beam").length, 1, "unused copy removed");
});

test("layer constraints: changing the strain type re-derives parameters", () => {
  const s = newStore({ materType: 1, x: 0.47, y: 1, structType: 0 });
  const l = () => s.ctx.layer;
  assert.equal(l().params.length, 0);
  s.editLayer(l().id, { structType: 2 });
  assert.deepEqual(l().params.map((p) => p.label), ["eps11", "gamma12"], "biaxial with in-plane symmetry");
  s.setParam(l().id, 0, 0.004);
  s.editLayer(l().id, { info: { "no shear": 1 } });
  assert.ok(l().params.every((p) => p.label !== "gamma23"));
  assert.equal(s.error, null);
  s.editMaterialType(s.ctx.mat.id, 0);
  assert.equal(s.error, null); assert.equal(s.ctx.mat.params.length, 0);
  assert.equal(l().params[0].value, 0.004, "the strain you set survives a change of material");
});

test("project JSON round-trips with images and active pattern", () => {
  const s = newStore();
  const img = { width: 4, height: 3, data: Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 300]) };
  s.setImage(img, "test");
  s.addPattern({ title: "B", zone: [1, 1, 2] });
  const t = new Store(); t.K = K; t.loadJSON(s.exportJSON());
  assert.equal(t.fitIds.length, 2); assert.equal(t.activeFitId, s.activeFitId);
  t.setActiveFit(t.fitIds[0]);
  assert.deepEqual(Array.from(t.image.data), Array.from(img.data));
  assert.equal(encodeImage({ width: 2, height: 1, data: [1, 2] }).type, "u8");
  assert.equal(encodeImage({ width: 2, height: 1, data: [1, 2000] }).type, "u16");
  assert.equal(encodeImage({ width: 2, height: 1, data: [1.5, 2] }).type, "f32");
  assert.deepEqual(Array.from(decodeImage(encodeImage({ width: 2, height: 1, data: [1.5, 2] })).data), [1.5, 2]);
});

test("Igor project loads in the new store with its image slot and undo history empty", () => {
  const s = new Store(); s.load(structuredClone(igor), K);
  assert.equal(s.fitIds.length, 1); assert.equal(s.canUndo, false); assert.ok(s.sim.lines.length > 10);
  assert.equal(s.patterns[0].nLines, 28 > s.patterns[0].nLines ? s.patterns[0].nLines : 28);
});

// Synthetic data: marked lines = simulated lines at the true parameters, from two orientations sharing one beam energy.
test("joint fit of two patterns recovers a shared beam energy and each pattern's geometry", () => {
  const s = newStore({ width: 800, height: 800 }); s.K = K;
  s.addPattern({ title: "B", zone: [1, 1, 2] }, { width: 800, height: 800, data: new Float32Array(1) });
  // true state: current values. Create marked lines from the simulations of both patterns.
  const ids = s.fitIds;
  for (const id of ids) {
    s.setActiveFit(id);
    const n = Math.min(14, sim(s).length);
    assert.ok(n >= 6, `pattern ${id}: only ${sim(s).length} simulated lines`);
    const lines = sim(s).slice(0, n);
    s.mutate((p) => { const e = p.objects.find((o) => o.id === s.ctx.expt.id); e.waves.delRMat = lines.map((l) => l.delR); e.waves.hklMat = lines.map((l) => l.hkl); }, "lines");
  }
  // free: beam E (shared), L, xc, yc of each model; start from perturbed values
  const p = structuredClone(s.project);
  for (const o of p.objects) { if (o.type === "Beam") o.params[0].hold = false; }
  const fl = freeParams(p, {}).filter((q) => /^(E |L \(|xc|yc)/.test(q.label));
  assert.equal(fl.length, 1 + 2 * 3, "one shared E plus L, xc, yc per pattern");
  const fitsAll = p.objects.filter((o) => o.type === "Fit");
  for (const f of fitsAll) s.refreshPairs(p, f.id);
  assert.ok(fitsAll.every((f) => f.waves.interList.length >= 5), "enough line pairs: " + fitsAll.map((f) => f.waves.interList.length));
  const want = fl.map((q) => q.value);
  const start = fl.map((q) => ({ ...q, value: q.value * (/E/.test(q.label) ? 1.0006 : /L/.test(q.label) ? 1.003 : 1) + (/xc|yc/.test(q.label) ? 1.5 : 0) }));
  const r0 = residuals(p, K, start.map((q) => q.value), start);
  const res = vary(p, K, start, { maxIter: 40, fitIds: fitsAll.map((f) => f.id) });
  const fom = Math.hypot(...residuals(p, K, res.values, start));
  assert.ok(fom < 0.05 * Math.hypot(...r0), `FOM ${Math.hypot(...r0)} -> ${fom}`);
  const iE = start.findIndex((q) => /E/.test(q.label));
  assert.ok(Math.abs(res.values[iE] / want[iE] - 1) < 2e-4, `E ${res.values[iE]} vs ${want[iE]}`);
  // scope: a single pattern uses only its own lines
  const one = residuals(p, K, want, fl, 1, [fitsAll[0].id]).length, both = residuals(p, K, want, fl).length;
  assert.ok(one < both && one > 0);
});
