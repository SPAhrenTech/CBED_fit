import { zeros, eye, T, dot, norm, cross, matvec, matmul, det, inv } from "./linalg.js";

export const HC = 1.23984186;     // keV nm
export const MC2 = 510.998903;    // keV
export const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

// Relativistic electron wavelength (nm) for energy E (keV).
export const wavelength = (E) => HC / Math.sqrt(E * (E + 2 * MC2));

// Electron scattering factor, Doyle & Turner (1968) eq. (4) with c = 0: f(s) = sum_i a_i exp(-b_i s^2).
// pars = [a1,b1,...,an,bn] (four terms from Table 4(a); any number of pairs is accepted), a in nm, b in nm^2, s = |g|/2 in 1/nm.
export function fe(pars, s) {
  let f = 0; const s2 = s * s;
  for (let i = 0; i + 1 < pars.length; i += 2) f += pars[i] * Math.exp(-pars[i + 1] * s2);
  return f;
}

// Electron scattering factor by atomic number Z. The Igor get_ffac had Si (14) pointing at the Ga parameters and
// P (15) and In (listed as 40, but In is 49) returning 0, so only Ga and As were correct; fixed here.
// Parameters are the Doyle & Turner 4-term fits for Si, P, Ga, As and In (the Igor experiment's In was a copy of Ga).
const FFAC_KEY = { 14: "fSi_pars", 15: "fP_pars", 31: "fGa_pars", 33: "fAs_pars", 49: "fIn_pars" };
export function ffac(Z, s, eDiff) {
  const k = FFAC_KEY[Z];
  if (!k) throw new Error(`no scattering factor for Z=${Z}`);
  return fe(eDiff[k], s);
}

// Fourier coefficient U_hkl of the crystal potential (complex {re, im}).
export function Uhkl(E, hkl, dCoord, spc, occ, VM, primVol, eDiff) {
  const g = matvec(VM, hkl);
  const s = norm(g) / 2;
  const relCorr = 1 + E / MC2;
  let re = 0, im = 0;
  for (let i = 0; i < occ.length; i++) {
    const f = relCorr * ffac(spc[i], s, eDiff);
    const ph = 2 * Math.PI * (hkl[0] * dCoord[i][0] + hkl[1] * dCoord[i][1] + hkl[2] * dCoord[i][2]);
    re += occ[i] * f * Math.cos(ph); im += occ[i] * f * Math.sin(ph);
  }
  const atten = Math.exp(-((s / 40) ** 2));
  const k = atten / Math.PI / primVol;
  return { re: re * k, im: im * k };
}

// Excitation error for incident wave vector kV and reciprocal vector gV.
export function shkl(kV, gV) {
  const K = norm(kV), g = norm(gV), gz = dot(kV, gV) / K;
  const gx = Math.sqrt(g * g - gz * gz);
  return -K * (1 - Math.sqrt(1 - (gx / K) ** 2)) - gz;
}

// ---- rotations (ports of GetRotationMatrix / GetRotationMatrixAngle / RotateBasis*) ----
const unit = (v) => { const n = norm(v); return v.map((x) => x / n); };
const col = (M, j) => M.map((r) => r[j]);
const fromCols = (a, b, c) => T([a, b, c]);

function normalAxis(v, vp) {
  for (const w of [cross(v, vp), cross(v, Y), cross(Z, v)]) {
    const n = norm(w);
    if (n > 0) return w.map((x) => x / n);
  }
  throw new Error("degenerate rotation");
}

// Rotation that takes direction v onto direction vp.
export function rotationMatrix(v, vp) {
  const a = unit(v);
  const c = normalAxis(v, vp);
  const A = fromCols(a, cross(c, a), c);
  const a2 = unit(vp);
  const cc = cross(c, a2);
  const B = fromCols(a2, cc.map((x) => x / norm(cc)), c);
  return matmul(B, inv(A));
}

// Rotation about axis (v x vp) by angdeg, starting from frame (v, ., v x vp).
export function rotationMatrixAngle(v, vp, angdeg) {
  const a = unit(v);
  const c = normalAxis(v, vp);
  const b = cross(c, a);
  const ca = Math.cos((angdeg / 180) * Math.PI), sa = Math.sin((angdeg / 180) * Math.PI);
  const A = fromCols(a, b, c);
  const Ap = fromCols(a.map((x, i) => ca * x + sa * b[i]), a.map((x, i) => -sa * x + ca * b[i]), c);
  return matmul(Ap, inv(A));
}

export const rotateBasis = (UM, v, vp) => matmul(rotationMatrix(v, vp), UM);
export const rotateBasisAngle = (UM, v, vp, ang) => matmul(rotationMatrixAngle(v, vp, ang), UM);

// (Z x x) x Z : the component of x perpendicular to Z, or zero if x || Z.
export function findNormalVect(zV, xV) {
  const p = cross(zV, xV);
  return norm(p) > 0 ? cross(p, zV) : p;
}

export const transposeInverse = (M) => T(inv(M));
