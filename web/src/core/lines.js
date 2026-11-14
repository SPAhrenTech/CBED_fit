// Line selection and identification (ports of MakeSimhklMat, IsLineInCircle, Find_hklV).
import { T, dot, norm, matvec, det } from "./linalg.js";
import * as P from "./physics.js";
import { delRFromG, transformDel, translateDel } from "./crystal.js";

/** True if the line (closest-point vector d) passes through the circle (centre c, radius rad). */
export function isLineInCircle(d, c, rad) {
  const mag = norm(d), s = -d[0] / mag, co = d[1] / mag;
  const dist = c[0] * co + c[1] * s;
  const xn = -mag * s + dist * co, yn = mag * co + dist * s;
  return rad ** 2 - ((xn - c[0]) ** 2 + (yn - c[1]) ** 2) > 0;
}

/**
 * All lines of Laue zones Nmin..Nmax that cross the pattern disk, strongest |U_hkl|^2 first
 * (after any fixed `supplementary` reflections), at most maxLines.
 */
export function simulateLines(m, atoms, eDiff, { Nmin = 1, Nmax = 1, maxLines = 100, supplementary = [] } = {}) {
  const lambda = P.wavelength(m.E), K0 = 1 / lambda;
  const rad = m.L * Math.tan(m.alpha / 1000);
  const rZone = [m.xZone, m.yZone], rBeam = [m.xZone + m.dxBeam, m.yZone + m.dyBeam];
  const volp = det(m.UpM);
  const H = 1 / norm(matvec(m.UM, m.uvwz));
  const U2 = (h) => { const u = P.Uhkl(m.E, h, atoms.dCoord, atoms.spc, atoms.occ, m.VM, volp, eDiff); return u.re ** 2 + u.im ** 2; };
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-7;
  const out = [], mag = [];
  for (const h of supplementary) if (!out.some((o) => same(o, h))) { out.push(h); mag.push(U2(h)); }
  const nFixed = out.length;
  const a = [0, 1, 2].map((k) => norm(T(m.UpM)[k])); // |columns of UpM|... as getVect(UpM, e_k)
  const aLen = [0, 1, 2].map((k) => norm(m.UpM.map((r) => r[k])));
  const gzmax = (Nmax + 0.5) * H;
  const garg = 1 - (Math.cos(m.alpha / 1000) - gzmax / K0) ** 2;
  let gmax = K0;
  if (garg >= 0) { const gx = K0 * (Math.sin(m.alpha / 1000) + Math.sqrt(garg)); gmax = Math.sqrt(gx * gx + gzmax * gzmax); }
  const Np = aLen.map((l) => Math.ceil(gmax * l));
  for (let m3 = -Np[2]; m3 <= Np[2]; m3++) for (let m2 = -Np[1]; m2 <= Np[1]; m2++) for (let m1 = -Np[0]; m1 <= Np[0]; m1++) {
    const G = matvec(m.VpM, [m1, m2, m3]);
    const hkl = matvec(m.UTM, G).map(Math.round);
    const N = dot(hkl, m.uvwz);
    if (N < Nmin || N > Nmax) continue;
    const d = delRFromG(G, lambda, m.L, rZone, rBeam, m.phiMat, m.EccMat, 0);
    if (!isLineInCircle(d, rBeam, rad)) continue;
    if (out.slice(0, nFixed).some((o) => same(o, hkl))) continue;
    const u = U2(hkl);
    let pos = out.length;
    for (let i = nFixed; i < out.length; i++) if (u > mag[i]) { pos = i; break; }
    out.splice(pos, 0, hkl); mag.splice(pos, 0, u);
    if (out.length > maxLines) { out.length = maxLines; mag.length = maxLines; }
  }
  return { hkl: out, magU2: mag };
}

/**
 * Real-valued Miller indices of the reflection whose line passes through delR (port of Find_hklV).
 * pOrN = +1 / -1 selects one of the two solutions for the in-plane component; Nz is the Laue zone.
 */
export function findHklFromLine(m, delR, pOrN, Nz) {
  const rc = [m.xZone, m.yZone], rb = [m.dxBeam, m.dyBeam];
  let d = translateDel(delR, rc, -1);
  d = translateDel(d, rb, -1);
  d = transformDel(d, m.EccIMat);
  d = translateDel(d, rb);
  d = transformDel(d, m.phiIMat);
  const dE = m.dynCorr && Math.abs(Nz) > 0.5 ? m.dE1 / Nz : 0;
  const lam = P.wavelength(m.E - dE);
  const dk = d.map((x) => x / lam / m.L);
  const delk = norm(dk);
  const kxi = delk ** 2 / dk[0], kyi = delk ** 2 / dk[1], kz = 1 / lam;
  const gz = Nz / norm(matvec(m.UM, m.uvwz));
  const C = gz * kz - gz ** 2 / 2;
  const gxy = pOrN * delk + Math.sqrt(delk ** 2 + 2 * C);
  const G = [(C - gxy ** 2 / 2) / kxi, (C - gxy ** 2 / 2) / kyi, gz];
  return matvec(m.UTM, G);
}
