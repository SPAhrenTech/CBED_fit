// Fit method 0 (each marked line against its simulated line) next to method 1 (line-pair intersections).
import test from "node:test";
import assert from "node:assert/strict";
import { project, KIgor as K, byId, link } from "./helpers.mjs";
import { freeParams, vary, residuals, modelState, lineList } from "../web/src/core/index.js";

const prep = (method) => {
  const p = structuredClone(project), fit = p.objects.find((o) => o.id === "Fit:1");
  const model = p.objects.find((o) => o.id === link(fit, "modelKey").id), expt = p.objects.find((o) => o.id === link(fit, "exptKey").id);
  fit.info.method = method;
  fit.waves.delList = lineList(modelState(p, K, model), expt.waves, { Nmin: fit.info.Nzmin, Nmax: fit.info.Nzmax });
  return { p, fit };
};

test("lineList picks the assigned lines of the fitted Laue zone", () => {
  const { fit } = prep(0), expt = link(byId("Fit:1"), "exptKey");
  assert.ok(fit.waves.delList.length > 5 && fit.waves.delList.length <= expt.waves.hklMat.length);
  assert.ok(fit.waves.delList.every((i) => expt.waves.hklMat[i].some((x) => x !== 0)));
});

test("method 0 fit from a perturbed start recovers its own minimum", () => {
  const { p } = prep(0), free = freeParams(p);
  const rss = (v) => Math.sqrt(residuals(p, K, v, free).reduce((t, x) => t + x * x, 0));
  const v0 = free.map((f) => f.value), ref = vary(structuredClone(p), K, free, { maxIter: 30 });      // minimum from the stored values
  const sig = free.map((f) => byId(f.id).params[f.index].del);
  const q = structuredClone(p), qf = freeParams(q);
  qf.forEach((f, k) => { f.value = v0[k] + 2 * (k % 2 ? -1 : 1) * sig[k]; q.objects.find((o) => o.id === f.id).params[f.index].value = f.value; });
  const start = rss(qf.map((f) => f.value)), res = vary(q, K, qf, { maxIter: 40 });
  assert.ok(res.fom < start, `fom ${res.fom} should be below the start ${start}`);
  assert.ok(Math.abs(res.fom - ref.fom) < 0.05 * ref.fom + 0.05, `fom ${res.fom} vs reference minimum ${ref.fom}`);
});
