import { houghWindow } from "./hough.js";
import { modelState, freeParams, fitsInScope, simulateLines, findDelR, canonicalizeProject, interPairs, lineList, buildMaterial } from "../core/index.js";
import * as F from "../core/factory.js";
import { encodeImage, decodeImage } from "./imageio.js";

const { find, linkOf } = F;
const clone = (x) => structuredClone(x);
const COALESCE_MS = 1500;     // edits of the same field within this window share one undo step
const MAX_UNDO = 200;

export class Store {
  constructor() {
    this.listeners = new Set();
    this.project = null; this.K = null;
    this.images = new Map();        // image ref -> {width,height,data,...}; kept outside the project so undo snapshots stay small
    this.activeFitId = null;
    this.scope = "active";          // what "Run fit" fits: this pattern only, or all included patterns jointly
    this.sim = null;                // {m, lines:[{hkl, delR, magU2}], atoms}
    this.fit = { running: false, log: [], status: "idle", fom: null, nData: 0 };
    this.results = new Map();       // fit id -> {fom, project} from the last fit that included it
    this.selectedLine = -1;
    this.error = null;
    this.hist = { undo: [], redo: [], key: null, time: 0 };
    this._n = 0;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind = "all") { for (const fn of this.listeners) fn(kind); }

  // ---- loading ----
  /** opts: {images: Map, activeFitId, canonical: re-express layer strain in strain components (for Igor imports)} */
  load(project, K, { images = new Map(), activeFitId = null, canonical = true } = {}) {
    this.K = K;
    this.project = canonical ? canonicalizeProject(project, K) : project;
    this.images = images;
    const fits = this.fitIds;
    this.activeFitId = fits.includes(activeFitId) ? activeFitId : fits[0] ?? null;
    this.selectedLine = -1; this.results.clear(); this.clearHistory();
    this.fit = { running: false, log: [], status: "idle", fom: null, nData: 0 };
    this.recompute();
    this.emit("all");
  }
  loadJSON(text) {
    const { images = {}, activeFitId = null, ...project } = JSON.parse(text);
    const map = new Map(Object.entries(images).map(([ref, enc]) => [ref, decodeImage(enc)]));
    this.load(project, this.K, { images: map, activeFitId });
  }
  newProject(opts, image = null) {
    const ref = image ? this.registerImage(image) : null;
    const { project, fitId } = F.newProject(this.K, { ...opts, width: image?.width, height: image?.height, imageRef: ref });
    this.load(project, this.K, { images: this.images, activeFitId: fitId, canonical: false });
  }
  exportJSON() {
    const images = {};
    for (const o of this.project.objects) if (o.type === "Image" && o.vars.ref && this.images.has(o.vars.ref)) images[o.vars.ref] = encodeImage(this.images.get(o.vars.ref));
    return JSON.stringify({ ...this.project, activeFitId: this.activeFitId, images }, null, 1);
  }

  // ---- images ----
  registerImage(img) { const ref = `img${Date.now().toString(36)}${this._n++}`; this.images.set(ref, img); return ref; }
  imageObj(fitId = this.activeFitId) { return this.project?.objects.find((o) => o.type === "Image" && o.links.some((l) => l.field === "fitKey" && l.to === fitId)); }
  get image() { const ref = this.imageObj()?.vars.ref; return ref ? this.images.get(ref) ?? null : null; }
  /** Set the image of the active pattern. */
  setImage(image, name = null) {
    const ref = this.registerImage(image), fitId = this.activeFitId;
    this.mutate((p) => {
      const o = p.objects.find((x) => x.type === "Image" && x.links.some((l) => l.to === fitId));
      if (o) { o.vars.ref = ref; if (name) o.title = name; }
      else p.objects.push(F.makeImage(F.nextKey(p, "Image"), name ?? "Image", fitId, ref));
    }, "image");
  }

  // ---- context ----
  get ctx() {
    const p = this.project, fit = p && find(p, this.activeFitId);
    if (!fit) return null;
    const model = linkOf(p, fit, "modelKey"), expt = linkOf(p, fit, "exptKey");
    const layer = linkOf(p, model, "layerKey"), beam = linkOf(p, model, "beamKey"), mat = linkOf(p, layer, "materKey");
    return { fit, model, expt, layer, beam, mat };
  }
  get fitIds() { return this.project ? this.project.objects.filter((o) => o.type === "Fit").map((o) => o.id) : []; }
  /** One row per pattern for the navigation strip. */
  get patterns() {
    const p = this.project;
    return this.fitIds.map((id) => {
      const fit = find(p, id), expt = linkOf(p, fit, "exptKey"), model = linkOf(p, fit, "modelKey");
      const hkl = expt.waves.hklMat, r = this.results.get(id);
      return {
        id, title: fit.title, include: !!fit.info.include, hasImage: !!this.images.get(this.imageObj(id)?.vars.ref),
        nLines: hkl.length, nAssigned: hkl.filter((h) => h.some((x) => x !== 0)).length, nPairs: (fit.info.method === 1 ? fit.waves.interList?.length : fit.waves.delList?.length) ?? 0,
        zone: model.waves.uvwzVect, fom: r?.fom ?? null, stale: r ? r.project !== this.project : false,
      };
    });
  }
  setActiveFit(id) { if (!this.fitIds.includes(id)) return; this.activeFitId = id; this.candidates = []; this.selectedLine = -1; this.recompute(); this.emit("pattern"); }
  stepPattern(dir) { const ids = this.fitIds, i = ids.indexOf(this.activeFitId); this.setActiveFit(ids[(i + dir + ids.length) % ids.length]); }
  /** Objects that share `id` with other patterns: titles of the other patterns using it. */
  sharedWith(id) {
    const p = this.project, out = [];
    for (const f of p.objects.filter((o) => o.type === "Fit" && o.id !== this.activeFitId)) {
      const m = linkOf(p, f, "modelKey"), l = linkOf(p, m, "layerKey");
      if ([f.id, m.id, linkOf(p, m, "beamKey").id, l.id, linkOf(p, l, "materKey").id].includes(id)) out.push(f.title);
    }
    return out;
  }

  /** Beam, model, layer and material of one pattern. */
  objectsOf(fitId) {
    const p = this.project, fit = find(p, fitId), model = linkOf(p, fit, "modelKey"), layer = linkOf(p, model, "layerKey");
    return [linkOf(p, model, "beamKey"), model, layer, linkOf(p, layer, "materKey")].filter(Boolean);
  }
  activeObjects() { return this.activeFitId && this.project ? this.objectsOf(this.activeFitId) : []; }
  scopeFitIds(scope = this.scope) { return scope === "all" ? fitsInScope(this.project).map((f) => f.id) : [this.activeFitId]; }
  /** Free parameters of the fit scope: each shared object contributes once. */
  freeList(scope = this.scope) {
    const only = new Set(this.scopeFitIds(scope).flatMap((id) => this.objectsOf(id).map((o) => o.id)));
    return freeParams(this.project, { only });
  }
  nDataOf(fit) { return (fit.info.method === 1 ? fit.waves.interList?.length : fit.waves.delList?.length) * 2 || 0; }

  // ---- derived state ----
  recompute() {
    const c = this.ctx;
    this.error = null;
    if (!c) { this.sim = null; return; }
    try {
      const m = modelState(this.project, this.K, c.model);
      const M = buildMaterial(c.mat, this.K);
      const atoms = { spc: M.spc, occ: M.occ, dCoord: M.dCoord };
      const { Nzmin, Nzmax } = c.fit.info;
      const r = simulateLines(m, atoms, this.K.eDiff, { Nmin: Nzmin, Nmax: Nzmax, maxLines: 100 });
      const excess = c.expt?.info.excess ?? 0;
      this.sim = { m, atoms, lines: r.hkl.map((h, i) => ({ hkl: h, delR: findDelR(m, h, excess), magU2: r.magU2[i] })) };
    } catch (e) { this.sim = null; this.error = e.message; }
  }

  /** Marked lines with the model prediction for their hkl (null if unassigned). */
  markedLines() {
    const c = this.ctx;
    if (!c?.expt) return [];
    const { hklMat, delRMat } = c.expt.waves;
    return delRMat.map((d, i) => {
      const hkl = hklMat[i], assigned = hkl.some((x) => x !== 0);
      let pred = null, resid = null;
      if (assigned && this.sim) { pred = findDelR(this.sim.m, hkl, c.expt.info.excess); resid = Math.hypot(pred[0] - d[0], pred[1] - d[1]); }
      return { i, hkl, delR: d, assigned, pred, resid };
    });
  }

  // ---- undo / redo ----
  clearHistory() { this.hist = { undo: [], redo: [], key: null, time: 0 }; }
  get canUndo() { return this.hist.undo.length > 0 && !this.fit.running; }
  get canRedo() { return this.hist.redo.length > 0 && !this.fit.running; }
  snapshot() { return { project: this.project, activeFitId: this.activeFitId }; }
  /** Record the state before an edit. Edits with the same `key` in quick succession (typing, arrow clicks) share one step. */
  pushHistory(key = null) {
    const h = this.hist, now = performance.now();
    if (key && key === h.key && now - h.time < COALESCE_MS) { h.time = now; h.redo = []; return; }
    h.undo.push(this.snapshot());
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo = []; h.key = key; h.time = now;
  }
  restore(s) {
    this.project = s.project;
    this.activeFitId = this.fitIds.includes(s.activeFitId) ? s.activeFitId : this.fitIds[0] ?? null;
    this.selectedLine = -1; this.hist.key = null;
    this.recompute(); this.emit("all");
  }
  undo() { if (!this.canUndo) return; this.hist.redo.push(this.snapshot()); this.restore(this.hist.undo.pop()); }
  redo() { if (!this.canRedo) return; this.hist.undo.push(this.snapshot()); this.restore(this.hist.redo.pop()); }

  // ---- edits ----
  /** Apply `fn` to a copy of the project. opts: {coalesce: key, history: false to skip the undo record}. */
  mutate(fn, kind = "values", { coalesce = null, history = true } = {}) {
    if (history) this.pushHistory(coalesce);
    this.project = clone(this.project);
    fn(this.project);
    if (!find(this.project, this.activeFitId)) this.activeFitId = this.fitIds[0] ?? null;
    this.recompute();
    this.emit(kind);
  }
  obj(p, id) { return find(p, id); }
  setParam(id, idx, v) { this.mutate((p) => { find(p, id).params[idx].value = v; }, "values", { coalesce: `param:${id}:${idx}` }); }
  setHold(id, idx, hold) { this.mutate((p) => { find(p, id).params[idx].hold = hold; }, "structure"); }
  setStep(id, idx, exp) { this.mutate((p) => { const q = find(p, id).params[idx]; q.step = exp; q.increment = 10 ** exp; }, "structure", { coalesce: `step:${id}:${idx}` }); }
  stepParam(id, idx, dir) {
    const q = find(this.project, id).params[idx];
    const inc = q.increment ?? 10 ** (q.step ?? -3);
    this.setParam(id, idx, +(q.value + dir * inc).toPrecision(12));
  }
  setInfo(id, key, v) { this.mutate((p) => { find(p, id).info[key] = v; }, "structure", { coalesce: `info:${id}:${key}` }); }
  setWave(id, name, v) { this.mutate((p) => { find(p, id).waves[name] = v; }, "structure", { coalesce: `wave:${id}:${name}` }); }
  /** Orientation of the active pattern's model: zone axis uvw and the reflection hklx drawn along x. */
  setZone(modelId, uvw, hklx) { this.mutate((p) => { F.setZone(p, modelId, uvw, hklx); this.fitIds.forEach((id) => this.refreshPairs(p, id)); }, "structure", { coalesce: `zone:${modelId}` }); }
  /** Laue-zone range simulated for a pattern (pass null to keep one end). */
  setLaueZones(fitId, nmin, nmax) {
    this.mutate((p) => { const f = find(p, fitId); if (nmin != null) f.info.Nzmin = Math.round(nmin); if (nmax != null) f.info.Nzmax = Math.round(nmax); this.refreshPairs(p, fitId); }, "structure", { coalesce: `nz:${fitId}` });
  }
  setTitle(id, title) { this.mutate((p) => { find(p, id).title = title; }, "structure", { coalesce: `title:${id}` }); }

  // ---- layers / materials / sharing ----
  editLayer(layerId, patch) { this.mutate((p) => F.editLayer(p, this.K, layerId, patch), "structure"); }
  editMaterialType(matId, type) { this.mutate((p) => F.editMaterialType(p, this.K, matId, type), "structure"); }
  /** Make the active pattern use another beam/model/layer/material, or a fresh copy ("new") of the current one. */
  relinkActive(kind, to) {
    const c = this.ctx;
    const [from, field, cur] = { beam: [c.model.id, "beamKey", c.beam], layer: [c.model.id, "layerKey", c.layer], material: [c.layer.id, "materKey", c.mat], model: [c.fit.id, "modelKey", c.model] }[kind];
    this.mutate((p) => {
      const target = to === "new" ? F.copyObject(p, cur.id, `${cur.title} (copy)`).id : to;
      F.relink(p, from, field, target);
      if (kind === "material") F.editLayer(p, this.K, from, {});     // new elastic constants: re-derive the strain parameters
    }, "structure");
  }

  // ---- patterns ----
  /** Add a pattern next to the active one. o: {title, share:{beam,layer,model}, zone, hklx}. */
  addPattern(o = {}, image = null) {
    const base = this.activeFitId, ref = image ? this.registerImage(image) : null;
    let id;
    this.mutate((p) => { id = F.addPattern(p, this.K, base, { ...o, width: image?.width, height: image?.height, imageRef: ref }); }, "structure");
    this.setActiveFit(id);
    return id;
  }
  removePattern(fitId = this.activeFitId) {
    if (this.fitIds.length < 2) return;
    const ids = this.fitIds, i = ids.indexOf(fitId);
    this.mutate((p) => F.removePattern(p, fitId), "structure");
    this.results.delete(fitId);
    this.setActiveFit(this.fitIds[Math.min(i, this.fitIds.length - 1)]);
  }
  /** Fit method of a pattern: 1 = intersections of line pairs, 0 = each line against its simulated line. */
  setMethod(fitId, method) {
    this.mutate((p) => { find(p, fitId).info.method = method; this.refreshPairs(p, fitId); }, "structure");
  }
  /** Origin (pixels) relative to which method-0 line vectors are compared. */
  setFitOrigin(fitId, xc, yc) { this.mutate((p) => { const i = find(p, fitId).info; i.xc = xc; i.yc = yc; }, "structure", { coalesce: `fitorigin:${fitId}` }); }
  /** Put the Fit objects (the patterns) into the given id order; every other object stays where it is. */
  reorderPatterns(order) {
    this.mutate((p) => {
      const slots = p.objects.map((o, i) => (o.type === "Fit" ? i : -1)).filter((i) => i >= 0);
      const byId = new Map(slots.map((i) => [p.objects[i].id, p.objects[i]]));
      order.forEach((id, k) => { p.objects[slots[k]] = byId.get(id); });
    }, "structure");
  }
  /** Move a pattern one place left (-1) or right (+1) in the strip. */
  movePattern(fitId, dir) {
    const ids = this.fitIds, i = ids.indexOf(fitId), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.reorderPatterns(ids);
  }
  /** Patterns without a number in the title first (e.g. Substrate), then natural order by title (Layer1, Layer2, ..., Layer10). */
  sortPatterns() {
    const t = (id) => find(this.project, id).title ?? "";
    const ids = this.fitIds.slice().sort((a, b) => (/\d/.test(t(a)) - /\d/.test(t(b))) || t(a).localeCompare(t(b), undefined, { numeric: true, sensitivity: "base" }));
    this.reorderPatterns(ids);
  }
  setInclude(fitId, on) { this.mutate((p) => { find(p, fitId).info.include = on ? 1 : 0; }, "structure"); }
  renamePattern(fitId, title) {
    this.mutate((p) => { const f = find(p, fitId); f.title = title; const e = linkOf(p, f, "exptKey"); if (e) e.title = title; }, "structure", { coalesce: `title:${fitId}` });
  }

  // ---- marked lines ----
  addLine(delR, hkl = [0, 0, 0]) {
    const id = this.ctx.expt.id;
    this.mutate((p) => { const e = find(p, id); e.waves.delRMat.push(delR); e.waves.hklMat.push(hkl); this.refreshPairs(p); }, "lines");
    this.selectedLine = this.ctx.expt.waves.delRMat.length - 1;
    this.emit("lines");
  }
  removeLine(i) {
    const id = this.ctx.expt.id;
    this.mutate((p) => { const e = find(p, id); e.waves.delRMat.splice(i, 1); e.waves.hklMat.splice(i, 1); this.refreshPairs(p); }, "lines");
    this.selectedLine = -1; this.emit("lines");
  }
  setLineHkl(i, hkl) {
    const id = this.ctx.expt.id;
    this.mutate((p) => { find(p, id).waves.hklMat[i] = hkl; this.refreshPairs(p); }, "lines", { coalesce: `hkl:${id}:${i}` });
  }
  /** Hough search around every simulated line not yet marked; candidates are stored for review. */
  findLines({ dark = true, W = 16, minProminence = 4 } = {}) {
    const img = this.image, sim = this.sim; this.candidates = [];
    if (!img || !sim) { this.emit("candidates"); return; }
    const m = sim.m, centre = [m.xZone + m.dxBeam, m.yZone + m.dyBeam], rad = m.L * Math.tan(m.alpha / 1000);
    const marked = this.markedLines().filter((l) => l.assigned).map((l) => l.hkl.join(","));
    for (const l of sim.lines) {
      if (marked.includes(l.hkl.join(","))) continue;
      const r = houghWindow(img, l.delR, centre, rad, { dark, W });
      if (!r.peak) continue;
      const delR = [l.delR[0] + r.peak.a, l.delR[1] + r.peak.b];
      this.candidates.push({ hkl: l.hkl, predicted: l.delR, delR, shift: Math.hypot(r.peak.a, r.peak.b), prominence: r.prominence, score: r.peak.score, hough: r, accept: r.prominence >= minProminence });
    }
    this.candidates.sort((a, b) => b.prominence - a.prominence);
    this.emit("candidates");
  }
  acceptCandidates() {
    const cs = (this.candidates ?? []).filter((c) => c.accept); if (!cs.length) return;
    const id = this.ctx.expt.id;
    this.mutate((p) => { const e = find(p, id); for (const c of cs) { e.waves.delRMat.push(c.delR); e.waves.hklMat.push(c.hkl.slice()); } this.refreshPairs(p); }, "lines");
    this.candidates = []; this.emit("candidates");
  }
  /** Nearest simulated line to a marked line (for suggesting hkl). */
  suggestHkl(delR, maxDist = 40) {
    let best = null;
    for (const l of this.sim?.lines ?? []) { const d = Math.hypot(l.delR[0] - delR[0], l.delR[1] - delR[1]); if (!best || d < best.d) best = { d, hkl: l.hkl }; }
    return best && best.d <= maxDist ? best : null;
  }
  /** Recompute which marked-line pairs of a pattern enter the fit (Fit.interList) for the given project draft. */
  refreshPairs(p = this.project, fitId = this.activeFitId) {
    const fit = find(p, fitId), model = linkOf(p, fit, "modelKey"), expt = linkOf(p, fit, "exptKey");
    try {
      const m = modelState(p, this.K, model);
      fit.waves.interList = interPairs(m, expt.waves, { Nmin: fit.info.Nzmin, Nmax: fit.info.Nzmax });
      fit.waves.delList = lineList(m, expt.waves, { Nmin: fit.info.Nzmin, Nmax: fit.info.Nzmax });
    } catch { /* keep previous list */ }
  }

  // ---- fitting ----
  setScope(scope) { this.scope = scope; this.emit("fit"); }
  runFit(maxIter = 20) {
    if (this.fit.running) return;
    const fitIds = this.scopeFitIds();
    this.mutate((p) => fitIds.forEach((id) => this.refreshPairs(p, id)), "lines");       // the one undo step of this fit
    const free = this.freeList();
    const nData = fitIds.reduce((s, id) => s + this.nDataOf(find(this.project, id)), 0);
    if (!free.length || !nData) { this.fit = { ...this.fit, status: nData ? "no free parameters" : "no line pairs to fit" }; this.emit("fit"); return; }
    this.fit = { running: true, log: [], status: "running", fom: null, nData, nPar: free.length, fitIds };
    this.emit("fit");
    this.worker?.terminate();
    this.worker = new Worker(new URL("./fit.worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "iteration") {
        this.fit.log.push(data); this.fit.fom = data.fom;
        this.applyValues(free, data.params, null);
      } else if (data.type === "done") {
        this.applyValues(free, data.values, data.errors);
        for (const [id, fom] of Object.entries(data.perFit)) this.results.set(id, { fom, project: this.project });
        this.fit = { ...this.fit, running: false, status: data.status, fom: data.fom };
        this.worker.terminate(); this.worker = null; this.emit("fit");
      } else if (data.type === "error") {
        this.fit = { ...this.fit, running: false, status: "error: " + data.message }; this.worker = null; this.emit("fit");
      }
    };
    this.worker.postMessage({ project: this.project, K: this.K, free, maxIter, fitIds });
  }
  stopFit() { this.worker?.terminate(); this.worker = null; this.fit = { ...this.fit, running: false, status: "stopped" }; this.emit("fit"); }
  applyValues(free, values, errors) {
    this.mutate((p) => free.forEach((f, k) => { const q = find(p, f.id).params[f.index]; q.value = values[k]; if (errors) q.del = errors[k]; }), "values", { history: false });
    this.emit("fit");
  }
}
