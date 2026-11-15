// Least-squares fitting of the simulated HOLZ lines to the marked lines (port of VaryParams / GetfV / GetJM).
import { zeros, T, dot, norm, matvec, matmul, det, inv } from "./linalg.js";
import { buildMaterial, buildLayer, buildModel, findDelR, findInter } from "./crystal.js";
import { makeHkl0, computeDE1 } from "./dynamical.js";

const FIT_GROUPS = ["Beam", "Model", "Layer", "Material"];   // same order as MakeParamsLists (0, 2, 6, 13)

/** Free parameter list: every parameter with hold === false, in group order. */
export function freeParams(project, { only } = {}) {
  const out = [];
  for (const g of FIT_GROUPS) for (const o of project.objects.filter((x) => x.type === g && (!only || only.has(x.id))))
    o.params.forEach((p, i) => { if (!p.hold) out.push({ id: o.id, index: i, label: p.label, tol: p.tol, value: p.value, step: p.step }); });
  return out;
}

const linkOf = (project, o, field) => {
  const l = o.links.find((x) => x.field === field);
  return l && project.objects.find((x) => x.id === l.to);
};

// Return `o` with some parameter values replaced (shallow copy).
const withValues = (o, ov) => (ov.has(o.id) ? { ...o, params: o.params.map((p, i) => (ov.get(o.id).has(i) ? { ...p, value: ov.get(o.id).get(i) } : p)) } : o);

/** Build the physical state of a Model (including the dynamical energy correction) with optional parameter overrides. */
export function modelState(project, K, modelObj, ov = new Map()) {
  const model = withValues(modelObj, ov);
  const layer = withValues(linkOf(project, modelObj, "layerKey"), ov);
  const beam = withValues(linkOf(project, modelObj, "beamKey"), ov);
  const mat = withValues(linkOf(project, linkOf(project, modelObj, "layerKey"), "materKey"), ov);
  const M = buildMaterial(mat, K);
  const Ls = buildLayer(layer, M, { basis: layer.waves.epsVectL });
  const m = buildModel(model, Ls, M, beam);
  if (m.dynCorr) {
    const atoms = { spc: M.spc, occ: M.occ, dCoord: M.dCoord };
    m.dE1 = computeDE1(m, makeHkl0(m, atoms, K.eDiff), atoms, K.eDiff);
  }
  return m;
}

/** Fits that take part in a joint fit: those with include set, or exactly `fitIds` when given. */
export const fitsInScope = (project, fitIds = null) =>
  project.objects.filter((o) => o.type === "Fit" && (fitIds ? fitIds.includes(o.id) : o.info.include));

/** Residual vector (expt - fit)/sigma for all included fits (or only `fitIds`, regardless of their include flag). */
export function residuals(project, K, values, free, sig = 1, fitIds = null) {
  const ov = new Map();
  free.forEach((f, k) => { if (!ov.has(f.id)) ov.set(f.id, new Map()); ov.get(f.id).set(f.index, values[k]); });
  const cache = new Map();
  const r = [];
  for (const fit of fitsInScope(project, fitIds)) {
    const method = fit.info.method;
    const mo = linkOf(project, fit, "modelKey"), ex = linkOf(project, fit, "exptKey");
    if (!cache.has(mo.id)) cache.set(mo.id, modelState(project, K, mo, ov));
    const m = cache.get(mo.id);
    const excess = ex.info.excess;
    if (method === 1) {
      for (const [i, j] of fit.waves.interList) {
        const f = findInter(findDelR(m, ex.waves.hklMat[i], excess), findDelR(m, ex.waves.hklMat[j], excess));
        const e = findInter(ex.waves.delRMat[i], ex.waves.delRMat[j]);
        r.push((e[0] - f[0]) / sig, (e[1] - f[1]) / sig);
      }
    } else {
      // method 0: compare the line vectors themselves, relative to the fit origin R0 = -(xc, yc)
      const R0 = [-fit.info.xc, -fit.info.yc];
      for (const i of fit.waves.delList) {
        const f = translate(findDelR(m, ex.waves.hklMat[i], excess), R0), e = translate(ex.waves.delRMat[i], R0);
        r.push((e[0] - f[0]) / sig, (e[1] - f[1]) / sig);
      }
    }
  }
  return r;
}
function translate(v, dR) { const d = norm(v), c = v[0] / d, s = v[1] / d, dp = d + dR[0] * c + dR[1] * s; return [dp * c, dp * s]; }

/** Central-difference Jacobian of the residual vector (port of GetJM/GetDFV: step is dPar total). */
export function jacobian(project, K, values, free, dPar, sig = 1, fitIds = null) {
  const n = values.length;
  const cols = [];
  for (let i = 0; i < n; i++) {
    const p = values.slice(), m = values.slice();
    p[i] += dPar[i] / 2; m[i] -= dPar[i] / 2;
    const rp = residuals(project, K, p, free, sig, fitIds), rm = residuals(project, K, m, free, sig, fitIds);
    cols.push(rp.map((x, k) => (x - rm[k]) / dPar[i]));
  }
  return T(cols);   // nData x nPar
}

// (J^T J + lambda diag(J^T J))^-1 J^T, or null when singular (port of MatrixDampedPseudoInverseLeft)
function dampedPinv(J, lambda) {
  const Jt = T(J), A = matmul(Jt, J), n = A.length;
  for (let i = 0; i < n; i++) A[i][i] += lambda * A[i][i];
  const tr = A.reduce((s, r, i) => s + r[i], 0);
  if (tr === 0 || Math.abs(Math.abs(det(A)) ** (1 / n) / tr) < 1e-24) return null;
  return matmul(inv(A), Jt);
}

/** Parameter standard errors sqrt(diag((J^T J)^-1)) (sigma already folded into J). */
export function parameterErrors(J) {
  const A = matmul(T(J), J);
  return inv(A).map((r, i) => Math.sqrt(r[i]));
}

/**
 * Levenberg-Marquardt exactly as in VaryParams. Returns {values, fom, iterations, errors, history, status}.
 * opts: { maxIter, sig, onIteration(info) }
 */
export function vary(project, K, free, { maxIter = 20, sig = 1, onIteration, fitIds = null } = {}) {
  const nPar = free.length;
  let p0 = free.map((f) => f.value);
  let dPar = free.map((f) => f.tol);
  let lambda = 0.1, iter = 0, done = false, status = "max-iterations";
  const history = [];
  const norm2 = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  let fom = norm2(residuals(project, K, p0, free, sig, fitIds));
  do {
    const r0 = residuals(project, K, p0, free, sig, fitIds);
    fom = norm2(r0);
    const J = jacobian(project, K, p0, free, dPar, sig, fitIds);
    const magDF = T(J).map(norm2), magDFMax = Math.max(...magDF);
    if (magDFMax / r0.length < 1e-12) { status = "converged"; break; }
    if (magDF.some((m) => m / magDFMax < 1e-12)) { status = "no-dependence"; break; }
    const step = (lam) => {
      const pinv = dampedPinv(J, lam);
      if (!pinv) return null;
      const inc = matvec(pinv, r0).map((x) => -x);
      const p = p0.map((x, k) => x + inc[k]);
      return { p, fom: norm2(residuals(project, K, p, free, sig, fitIds)) };
    };
    const s1 = step(lambda), s2 = step(lambda / 2);
    if (!(s1 && s2)) { status = "singular"; break; }
    const tolDp = (f) => { const dp = f / magDFMax / 1e6; return free.map((q) => Math.max(q.tol, dp)); };
    if (s1.fom < fom || s2.fom < fom) {
      if (s1.fom < s2.fom) { p0 = s1.p; dPar = tolDp(s1.fom); fom = s1.fom; }
      else { p0 = s2.p; dPar = tolDp(s2.fom); fom = s2.fom; lambda /= 2; }
    } else { lambda *= 10; dPar = tolDp(fom); }
    iter++;
    history.push({ iter, fom, lambda });
    onIteration?.({ iter, fom, params: p0 });
  } while (iter < maxIter && !done);
  let errors = null;
  try { errors = parameterErrors(jacobian(project, K, p0, free, dPar, sig, fitIds)); } catch { /* singular */ }
  return { values: p0, fom, iterations: iter, errors, history, status };
}
