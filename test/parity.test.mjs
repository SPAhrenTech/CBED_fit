// Parity tests: the JS core must reproduce quantities stored in the Igor experiment.
import test from "node:test";
import assert from "node:assert/strict";
import { project, K, byId, link, maxDiff } from "./helpers.mjs";
import { buildMaterial, buildLayer, buildModel, findDelR, findInter, strainBasis, makeHkl0, computeDE1, simulateLines, findHklFromLine, freeParams, residuals, jacobian, parameterErrors, vary, modelState } from "../web/src/core/index.js";
import { ffac } from "../web/src/core/physics.js";
import { matmul, T, pinvLeft } from "../web/src/core/linalg.js";

const model = byId("Model:1"), layer = link(model, "layerKey"), beam = link(model, "beamKey"), mat = link(layer, "materKey");
const fit = byId("Fit:1"), expt = link(fit, "exptKey"), sim = byId("Simulation:2");
const M = buildMaterial(mat, K);
const Ls = buildLayer(layer, M, { basis: layer.waves.epsVectL });
const Mo = buildModel(model, Ls, M, beam);
const atoms = { spc: M.spc, occ: M.occ, dCoord: M.dCoord };
const close = (a, b, tol, msg) => assert.ok(maxDiff(a, b) <= tol, `${msg}: max diff ${maxDiff(a, b)} > ${tol}`);

test("material", () => { close(M.A0, mat.waves.AMat, 1e-14, "AMat"); close(M.C, mat.waves.CMat, 1e-14, "CMat"); });
test("layer orientation, strain, elasticity", () => {
  for (const [k, n] of [["epsVect", "epsVect"], ["AM", "AMat"], ["BM", "BMat"], ["ApM", "ApMat"], ["TM", "TMat"], ["C", "CMat"], ["C2D", "C2DMat"]])
    close(Ls[k], layer.waves[n], 1e-12, n);
});
test("model matrices", () => {
  for (const [k, n, tol] of [["UM", "UMat", 1e-12], ["VM", "VMat", 1e-12], ["UpM", "UpMat", 1e-12], ["VpM", "VpMat", 1e-12], ["phiMat", "phiMat", 1e-12], ["EccMat", "EccMat", 1e-6]])
    close(Mo[k], model.waves[n], tol, n); // Igor stores EccMat in single precision
});
test("strain basis spans the stored strain space", () => {
  const B = strainBasis(Ls.C2D, layer.vars.structType, layer.info["in-plane symmetry"], layer.info["no shear"]);
  assert.equal(B[0].length, layer.waves.epsVectL[0].length, "same number of strain parameters");
  const pinv = pinvLeft(B);
  const proj = matmul(B, pinv);  // projector onto span(B)
  close(matmul(proj, layer.waves.epsVectL), layer.waves.epsVectL, 1e-9, "stored basis lies in span");
});
test("dynamical energy correction dE1", () => {
  const hkl0 = makeHkl0(Mo, atoms, K.eDiff);
  const rnd = (L) => L.map((h) => h.map((x) => Math.round(x) + 0));
  assert.deepEqual(rnd(hkl0), rnd(model.waves.hkl0Mat));
  const dE1 = computeDE1(Mo, hkl0, atoms, K.eDiff);
  assert.ok(Math.abs(dE1 / model.waves.calcVal[0] - 1) < 1e-5, `dE1 ${dE1} vs ${model.waves.calcVal[0]}`);
});
test("line intersections and FOM of the stored fit", () => {
  const m = modelState(project, K, model);
  const pairs = fit.waves.interList;
  const f = pairs.map(([i, j]) => findInter(findDelR(m, expt.waves.hklMat[i], 0), findDelR(m, expt.waves.hklMat[j], 0)));
  close(f, fit.waves.fitInterRMat, 1e-3, "fitInterRMat (px)");
  const free = freeParams(project);
  assert.equal(free.length, 9);
  const r = residuals(project, K, free.map((x) => x.value), free);
  const fom = Math.sqrt(r.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(fom - byId("Analysis:0").info.FOM) < 1e-6, `FOM ${fom}`);
});
test("parameter errors agree with Igor to <2%", () => {
  const free = freeParams(project);
  const err = parameterErrors(jacobian(project, K, free.map((x) => x.value), free, free.map((x) => x.tol)));
  free.forEach((f, k) => { const st = byId(f.id).params[f.index].del; assert.ok(Math.abs(err[k] / st - 1) < 0.02, `${f.label}: ${err[k]} vs ${st}`); });
});
test("simulated line set matches Igor (same 30 lines)", () => {
  const m = modelState(project, K, model);
  const r = simulateLines(m, atoms, K.eDiff, { Nmin: sim.info.Nzmin, Nmax: sim.info.Nzmax, maxLines: sim.info.max_lines });
  const key = (h) => h.join(",");
  assert.deepEqual(r.hkl.map(key).sort(), sim.waves.hklMat.map(key).sort());
});
test("line positions agree with the stored simulation to 0.02 px", () => {
  const m = modelState(project, K, model);
  sim.waves.hklMat.forEach((h, i) => close(findDelR(m, h, 0), sim.waves.delrMat[i], 0.02, `line ${h}`));
});
test("identify: delR -> hkl round trip", () => {
  const m = modelState(project, K, model);
  for (const h of sim.waves.hklMat.slice(0, 10)) {
    const d = findDelR(m, h, 0), Nz = h[0] * m.uvwz[0] + h[1] * m.uvwz[1] + h[2] * m.uvwz[2];
    const e = Math.min(...[1, -1].map((s) => maxDiff(findHklFromLine(m, d, s, Nz), h)));
    assert.ok(e < 1e-3, `hkl ${h}: ${e}`);
  }
});
test("Levenberg-Marquardt recovers the minimum from a perturbed start", () => {
  const p = structuredClone(project), free = freeParams(p);
  const truth = free.map((f) => f.value), sig = free.map((f) => byId(f.id).params[f.index].del);
  free.forEach((f, k) => { f.value = truth[k] + 2 * (k % 2 ? -1 : 1) * sig[k]; p.objects.find((o) => o.id === f.id).params[f.index].value = f.value; });
  const res = vary(p, K, free, { maxIter: 30 });
  assert.ok(res.fom < 50.40, `FOM ${res.fom}`);
  free.forEach((f, k) => assert.ok(Math.abs(res.values[k] - truth[k]) < 0.3 * sig[k], `${f.label} off by ${(res.values[k] - truth[k]) / sig[k]} sigma`));
});
test("scattering factors are element-specific", () => {
  const s = 0.3;
  const f = Object.fromEntries([14, 15, 31, 33, 49].map((Z) => [Z, ffac(Z, s, K.eDiff)]));
  assert.ok(f[14] !== f[31] && f[15] > 0 && f[15] !== f[33]);
  assert.throws(() => ffac(40, s, K.eDiff));
});

test("strain parameters become strain components, physical strain unchanged", async () => {
  const { canonicalizeProject } = await import("../web/src/core/index.js");
  const p2 = canonicalizeProject(project, K);
  const l2 = p2.objects.find((o) => o.id === "Layer:2");
  assert.deepEqual(l2.params.map((q) => q.label), ["eps11", "gamma12"]);
  close(l2.waves.epsVect, layer.waves.epsVect, 1e-12, "strain tensor");
  assert.ok(Math.abs(l2.params[0].value - layer.waves.epsVect[0]) < 1e-12 && Math.abs(l2.params[1].value - layer.waves.epsVect[5]) < 1e-12);
  assert.ok(l2._strainResidual < 1e-12);
  // same minimum, same figure of merit
  const free = freeParams(p2);
  assert.deepEqual(free.slice(-2).map((f) => f.label), ["eps11", "gamma12"]);
  const r = residuals(p2, K, free.map((f) => f.value), free);
  assert.ok(Math.abs(Math.sqrt(r.reduce((s, x) => s + x * x, 0)) - 50.3938258) < 1e-6);
  // errors in strain units equal the old covariance propagated through the change of variables
  const free0 = freeParams(project);
  const J0 = jacobian(project, K, free0.map((f) => f.value), free0, free0.map((f) => f.tol));
  const J2 = jacobian(p2, K, free.map((f) => f.value), free, free.map((f) => f.tol));
  const e2 = parameterErrors(J2);
  const eps = l2.params.map((q) => q.value);
  assert.ok(e2.slice(-2).every((e) => e > 0 && e < 0.05), `strain errors ${e2.slice(-2)}`);
  // the coefficient-0 error of Igor scaled by |d eps11/d coef0| = 0.5955 must equal the new eps11 error when gamma12 is uncorrelated
  const e0 = parameterErrors(J0);
  assert.ok(Math.abs(e2[7] / (0.5955 * e0[7]) - 1) < 0.02, `eps11 error ${e2[7]} vs ${0.5955 * e0[7]}`);
  assert.ok(Math.abs(e2[8] / e0[8] - 1) < 0.02, `gamma12 error ${e2[8]} vs ${e0[8]}`);
});

test("changing constraints keeps the strain (rebasing) and the canonical basis is deterministic", async () => {
  const { reparametrizeLayerStrain, strainBasis } = await import("../web/src/core/index.js");
  const a = strainBasis(Ls.C2D, 2, 1, 0), b = strainBasis(Ls.C2D, 2, 1, 0);
  assert.deepEqual(a.map((r) => r.slice()), b.map((r) => r.slice()));
  assert.deepEqual(a.pivots, [0, 5]);
  // drop the in-plane symmetry: strain now has 3 free parameters (eps11, eps22, gamma12) and the old strain is preserved exactly
  const free3 = reparametrizeLayerStrain({ ...layer, info: { ...layer.info, "in-plane symmetry": 0 } }, mat, K);
  assert.deepEqual(free3.params.map((q) => q.label), ["eps11", "eps22", "gamma12"]);
  assert.ok(free3._strainResidual < 1e-12);
  close(free3.waves.epsVect, layer.waves.epsVect, 1e-12, "strain preserved");
});
