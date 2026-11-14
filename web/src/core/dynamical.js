// Dynamical (Bloch-wave) correction to the electron energy used for HOLZ line positions.
// Ports of FindhklMatrix, make_hkl0Mat and get_dE1.
import { zeros, T, dot, norm, cross, matvec, matmul, det, inv, eigHermitian } from "./linalg.js";
import * as P from "./physics.js";

const isInteger = (v) => v - Math.floor(v + 1e-9) < 1e-7;
const areIntegers = (w) => w.every(isInteger);

// Divide out the largest common integer factor.
function factorize(V) {
  V = V.slice();
  for (;;) {
    const facMax = Math.max(...V.map(Math.abs));
    let found = false;
    for (let fac = facMax; fac > 1; fac--) {
      const t = V.map((x) => x / fac);
      if (areIntegers(t)) { V = t; found = true; break; }
    }
    if (!found) return V;
  }
}

function findZOLZReflection(uvwz) {
  let best = null, lmin = 1e8;
  for (let i = 0; i < 3; i++) {
    const i0 = i % 3, i1 = (1 + i) % 3, i2 = (2 + i) % 3;
    const h = [0, 0, 0];
    h[i0] = 0; h[i1] = -uvwz[i2]; h[i2] = uvwz[i1];
    const l = norm(h);
    if (l > 0 && (best === null || l <= lmin)) { lmin = l; best = h.slice(); }
  }
  return best;
}

function reduce1(X, Y) {
  const c = cross(X, Y);
  const p = factorize(c);
  const area = dot(c, p) / dot(p, p);
  let res = Y;
  for (let i = 1; i < area; i++) {
    const t = X.map((x, k) => (i * x + Y[k]) / area);
    if (areIntegers(t)) { res = t; break; }
  }
  return res;
}

function reduce2(X, Y, Zv) {
  const c = cross(X, Y);
  const step = dot(c, c);
  let res = Zv;
  outer: for (let i = 0; i < step; i++) for (let j = 0; j < step; j++) {
    if (i === 0 && j === 0) continue;
    const t = X.map((x, k) => (i * x + j * Y[k] + Zv[k]) / step);
    if (areIntegers(t)) { res = t; break outer; }
  }
  return res;
}

/** Columns: two in-plane primitive-lattice vectors spanning the zone plane, and the zone axis (integers). */
export function findhklMatrix(uvwpz) {
  let X = factorize(findZOLZReflection(uvwpz));
  let Yv = factorize(cross(uvwpz, findZOLZReflection(uvwpz)));
  Yv = reduce1(X, Yv);
  const Zv = reduce2(X, Yv, uvwpz);
  return T([X, Yv, Zv]).map((r) => r.map(Math.round));
}

function findMaxIndices(gmax, gx, gy) {
  const lx = norm(gx), ly = norm(gy);
  const s2 = 1 - (dot(gx, gy) / lx / ly) ** 2;
  return [Math.ceil(gmax / lx / s2), Math.ceil(gmax / ly / s2)];
}

/** Beams (hkl) included in the dynamical energy correction: ZOLZ reflections with crit = |1/xi_g| / |s_g| > thresh. */
export function makeHkl0(m, atoms, eDiff) {
  const lambda = P.wavelength(m.E), K0 = 1 / lambda;
  const KV = [0, 0, -K0];                         // (sic) the Igor code uses -K here and +K in get_dE1
  const ruvwz = matvec(m.UM, m.uvwz);
  const uvwpz = factorize(matvec(m.VpTM, ruvwz));
  const H = Math.sqrt(dot(uvwpz, uvwpz));
  const FM = findhklMatrix(uvwpz);
  const volp = det(m.UpM);
  const col = (j) => FM.map((r) => r[j]);
  const [Nx, Ny] = findMaxIndices(H * Math.sqrt(2 * K0 / H - 1), col(0), col(1));
  const list = [[0, 0, 0]];
  for (let mY = -Ny; mY <= Ny; mY++) for (let mX = -Nx; mX <= Nx; mX++) {
    const hklp = matvec(FM, [mX, mY, 0]);
    const G = matvec(m.VpM, hklp);
    const g = norm(G);
    if (g > 0 && g < m.gmax) {
      const hkl = matvec(m.UTM, G);
      const s = P.shkl(KV, G);
      const U = P.Uhkl(m.E, hkl, atoms.dCoord, atoms.spc, atoms.occ, m.VM, volp, eDiff);
      const crit = Math.hypot(U.re, U.im) / K0 / Math.abs(s);
      if (crit > m.thresh) {
        if (list.length + 1 > m.maxBeams) throw new Error("too many beams");
        list.push(hkl);
      }
    }
  }
  return list;
}

/** Energy shift dE1 (keV) of the Bloch state that carries the transmitted beam (port of get_dE1). */
export function computeDE1(m, hkl0, atoms, eDiff) {
  const lambda = P.wavelength(m.E), K0 = 1 / lambda;
  const KV = [0, 0, K0];
  const H = norm(matvec(m.UM, m.uvwz));
  const volp = det(m.UpM);
  const n = hkl0.length;
  const re = zeros(n, n), im = zeros(n, n);
  for (let i = 0; i < n; i++) {
    re[i][i] = P.shkl(KV, matvec(m.VM, hkl0[i]));
    for (let j = i + 1; j < n; j++) {
      const d = hkl0[i].map((x, k) => x - hkl0[j][k]);
      const U = P.Uhkl(m.E, d, atoms.dCoord, atoms.spc, atoms.occ, m.VM, volp, eDiff);
      re[i][j] = U.re / K0 / 2; im[i][j] = U.im / K0 / 2;
      re[j][i] = U.re / K0 / 2; im[j][i] = -U.im / K0 / 2;
    }
  }
  const { values, vectors } = eigHermitian(re, im);
  let gamma = values[0], best = -1;
  values.forEach((v, k) => {
    const w = vectors[k].re[0] ** 2 + vectors[k].im[0] ** 2;
    if (k === 0 || w > best) { best = w; gamma = v; }
  });
  return (gamma * P.HC ** 2 * K0 ** 2) / H / (P.MC2 + m.E);
}
