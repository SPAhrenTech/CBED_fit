import { modelState, freeParams, simulateLines, findDelR, canonicalizeProject, interPairs, buildMaterial } from "../core/index.js";

const linkOf = (project, o, field) => { const l = o?.links.find((x) => x.field === field); return l && project.objects.find((x) => x.id === l.to); };
const clone = (x) => structuredClone(x);

export class Store {
  constructor() {
    this.listeners = new Set();
    this.project = null; this.K = null; this.image = null;
    this.activeFitId = null;
    this.sim = null;            // {m, lines:[{hkl, delR, magU2}], atoms}
    this.fit = { running: false, log: [], status: "idle", fom: null, nData: 0 };
    this.selectedLine = -1;
    this.error = null;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind = "all") { for (const fn of this.listeners) fn(kind); }

  // ---- loading ----
  load(project, K) {
    this.K = K;
    this.project = canonicalizeProject(project, K);
    const fits = this.project.objects.filter((o) => o.type === "Fit");
    this.activeFitId = fits[0]?.id ?? null;
    this.selectedLine = -1;
    this.recompute();
    this.emit("all");
  }
  setImage(image) { this.image = image; this.emit("image"); }

  // ---- context ----
  get ctx() {
    const p = this.project, fit = p?.objects.find((o) => o.id === this.activeFitId);
    if (!fit) return null;
    const model = linkOf(p, fit, "modelKey"), expt = linkOf(p, fit, "exptKey");
    const layer = linkOf(p, model, "layerKey"), beam = linkOf(p, model, "beamKey"), mat = linkOf(p, layer, "materKey");
    return { fit, model, expt, layer, beam, mat };
  }
  get fitIds() { return this.project.objects.filter((o) => o.type === "Fit").map((o) => o.id); }
  setActiveFit(id) { this.activeFitId = id; this.selectedLine = -1; this.recompute(); this.emit("all"); }

  /** Parameters shown/fitted for the active fit: beam, model, layer and material of that fit. */
  activeObjects() { const c = this.ctx; return c ? [c.beam, c.model, c.layer, c.mat].filter(Boolean) : []; }
  freeList() { return freeParams(this.project, { only: new Set(this.activeObjects().map((o) => o.id)) }); }

  // ---- derived state ----
  recompute() {
    const c = this.ctx;
    this.error = null;
    if (!c) { this.sim = null; return; }
    try {
      const m = modelState(this.project, this.K, c.model);
      const M = buildMaterial(c.mat, this.K);
      const atoms = { spc: M.spc, occ: M.occ, dCoord: c.model.waves.dCoordMat };
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

  // ---- edits ----
  mutate(fn, kind = "values") {
    this.project = clone(this.project);
    fn(this.project);
    this.recompute();
    this.emit(kind);
  }
  obj(p, id) { return p.objects.find((o) => o.id === id); }
  setParam(id, idx, v) { this.mutate((p) => { this.obj(p, id).params[idx].value = v; }); }
  setHold(id, idx, hold) { this.mutate((p) => { this.obj(p, id).params[idx].hold = hold; }, "structure"); }
  setStep(id, idx, exp) { this.mutate((p) => { const q = this.obj(p, id).params[idx]; q.step = exp; q.increment = 10 ** exp; }, "structure"); }
  stepParam(id, idx, dir) {
    const q = this.obj(this.project, id).params[idx];
    const inc = q.increment ?? 10 ** (q.step ?? -3);
    this.setParam(id, idx, +(q.value + dir * inc).toPrecision(12));
  }
  setInfo(id, key, v) { this.mutate((p) => { this.obj(p, id).info[key] = v; }, "structure"); }

  addLine(delR, hkl = [0, 0, 0]) {
    const id = this.ctx.expt.id;
    this.mutate((p) => { const e = this.obj(p, id); e.waves.delRMat.push(delR); e.waves.hklMat.push(hkl); this.refreshPairs(p); }, "lines");
    this.selectedLine = this.ctx.expt.waves.delRMat.length - 1;
    this.emit("lines");
  }
  removeLine(i) {
    const id = this.ctx.expt.id;
    this.mutate((p) => { const e = this.obj(p, id); e.waves.delRMat.splice(i, 1); e.waves.hklMat.splice(i, 1); this.refreshPairs(p); }, "lines");
    this.selectedLine = -1; this.emit("lines");
  }
  setLineHkl(i, hkl) {
    const id = this.ctx.expt.id;
    this.mutate((p) => { this.obj(p, id).waves.hklMat[i] = hkl; this.refreshPairs(p); }, "lines");
  }
  /** Nearest simulated line to a marked line (for suggesting hkl). */
  suggestHkl(delR, maxDist = 40) {
    let best = null;
    for (const l of this.sim?.lines ?? []) { const d = Math.hypot(l.delR[0] - delR[0], l.delR[1] - delR[1]); if (!best || d < best.d) best = { d, hkl: l.hkl }; }
    return best && best.d <= maxDist ? best : null;
  }
  /** Recompute which marked-line pairs enter the fit (Fit.interList) for the given project draft. */
  refreshPairs(p = this.project) {
    const c = { fit: this.obj(p, this.activeFitId) };
    const model = linkOf(p, c.fit, "modelKey"), expt = linkOf(p, c.fit, "exptKey");
    try {
      const m = modelState(p, this.K, model);
      c.fit.waves.interList = interPairs(m, expt.waves, { Nmin: c.fit.info.Nzmin, Nmax: c.fit.info.Nzmax });
    } catch { /* keep previous list */ }
  }

  // ---- fitting ----
  runFit(maxIter = 20) {
    if (this.fit.running) return;
    this.mutate((p) => this.refreshPairs(p), "lines");
    const free = this.freeList();
    const nData = this.project.objects.find((o) => o.id === this.activeFitId).waves.interList.length * 2;
    if (!free.length || !nData) { this.fit = { ...this.fit, status: nData ? "no free parameters" : "no line pairs to fit" }; this.emit("fit"); return; }
    this.fit = { running: true, log: [], status: "running", fom: null, nData, nPar: free.length };
    this.emit("fit");
    this.worker?.terminate();
    this.worker = new Worker(new URL("./fit.worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "iteration") {
        this.fit.log.push(data); this.fit.fom = data.fom;
        this.applyValues(free, data.params, null);
      } else if (data.type === "done") {
        this.applyValues(free, data.values, data.errors);
        this.fit = { ...this.fit, running: false, status: data.status, fom: data.fom };
        this.worker.terminate(); this.worker = null; this.emit("fit");
      } else if (data.type === "error") {
        this.fit = { ...this.fit, running: false, status: "error: " + data.message }; this.worker = null; this.emit("fit");
      }
    };
    this.worker.postMessage({ project: this.project, K: this.K, free, maxIter });
  }
  stopFit() { this.worker?.terminate(); this.worker = null; this.fit = { ...this.fit, running: false, status: "stopped" }; this.emit("fit"); }
  applyValues(free, values, errors) {
    this.mutate((p) => free.forEach((f, k) => { const q = this.obj(p, f.id).params[f.index]; q.value = values[k]; if (errors) q.del = errors[k]; }));
    this.emit("fit");
  }

  // ---- persistence ----
  exportJSON() { return JSON.stringify({ ...this.project, image: undefined }, null, 1); }
}
