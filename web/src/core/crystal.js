import { zeros, eye, T, dot, norm, cross, matvec, matmul, det, inv, eigSym, eigHermitian, pinvLeft } from "./linalg.js";
import * as P from "./physics.js";

const { X, Y, Z } = P;
const IJ_VOIGT = [[0, 5, 4], [5, 1, 3], [4, 3, 2]];            // ijLookup1: tensor index pair -> Voigt index (eps11,22,33,g23,g31,g12)
const VOIGT_PAIRS = [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]]; // ijrLookup

// ---------------------------------------------------------------- Material
const bilinear = (x, y, w) => x * y * w[0] + (1 - x) * (1 - y) * w[1] + (1 - x) * y * w[2] + x * (1 - y) * w[3];

function cubicC(c11, c12, c44) {
  // Same selection rule as get_cijkl in the Igor code: C_iiii = c11, C_iijj = c12, C_ijij (i != j) = c44, others 0.
  const C = [0, 1, 2].map(() => [0, 1, 2].map(() => [0, 1, 2].map(() => [0, 0, 0])));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) {
    if (i === j && k === l) C[i][j][k][l] = i === k ? c11 : c12;
    else if (i !== j && k !== l && i === k && j === l) C[i][j][k][l] = c44;
  }
  return C;
}

/** Bulk crystal from a Material object. type 0 = Si, 1 = GaInPAs (x = Ga fraction, y = As fraction). */
export function buildMaterial(mat, K) {
  const mp = K.materProps, type = K.materTypes[mat.vars.materType];
  let a0, alphaT, occ, C;
  if (mat.vars.materType === 0) {
    a0 = mp.a_nm[4]; alphaT = mat.info["alphaT"] ?? 0; occ = [1, 1];
    C = cubicC(mp.c11[4], mp.c12[4], mp.c44[4]);
  } else {
    const [x, y] = [mat.params[0].value, mat.params[1].value];
    a0 = bilinear(x, y, mp.a_nm); alphaT = bilinear(x, y, mp.alphaT);
    occ = [x, 1 - x, 1 - y, y];
    C = cubicC(bilinear(x, y, mp.c11), bilinear(x, y, mp.c12), bilinear(x, y, mp.c44));
  }
  return { a0, alphaT, occ, C, A0: eye(3).map((r) => r.map((v) => v * a0)), primT: type.primTMat, spc: type.spcVect, dCoord: type.dCoordMat };
}

// ---------------------------------------------------------------- Layer
function rotateElast(C, TM) {
  const R = [0, 1, 2].map(() => [0, 1, 2].map(() => [0, 1, 2].map(() => [0, 0, 0])));
  for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) {
    let sum = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++)
      sum += TM[p][i] * TM[q][j] * TM[r][k] * TM[s][l] * C[i][j][k][l];
    R[p][q][r][s] = sum;
  }
  return R;
}

const FREE = { 0: [0, 1, 2, 3, 4, 5], 1: [0, 1, 3, 4, 5], 2: [2, 3, 4], 3: [] };

// Orthonormal basis of the strain vectors that are stress-free in the listed components (null space of C_free),
// then restricted by the in-plane-symmetry and no-shear options. Returns a 6 x nEps matrix.
function rawStrainBasis(C2D, structType, isSymm, noShear) {
  const free = FREE[structType];
  let basis = eye(6);
  const nullspace = (M) => {      // M: rows x 6 matrix; null space of M via eigenvectors of M^T M with ~0 eigenvalue
    const { values, vectors } = eigSym(matmul(T(M), M));
    const cols = [];
    values.forEach((v, k) => { if (Math.abs(v) < 1e-4) cols.push(vectors.map((r) => r[k])); });
    return cols.length ? T(cols) : zeros(6, 0);
  };
  if (free.length) {
    const CRed = free.map((f) => C2D[f]);
    basis = nullspace(CRed);
  }
  const restrict = (S) => {
    if (basis[0].length === 0) return;
    const SB = matmul(S, basis);
    const { values, vectors } = eigSym(matmul(T(SB), SB));
    const nb = basis[0].length, keep = [];
    const rot = matmul(basis, vectors);
    values.forEach((v, k) => { if (Math.abs(v) < 1e-4) keep.push(rot.map((r) => r[k])); });
    basis = keep.length ? T(keep) : zeros(6, 0);
  };
  if (isSymm) restrict([[-1, 1, 0, 0, 0, 0], [1, -1, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]);
  if (noShear) restrict(eye(6).map((r, i) => r.map((v, j) => (i === j && i >= 3 ? -1 : 0))));
  return basis;
}

// Strain components in Voigt order and the order in which they are preferred as independent fit parameters.
export const STRAIN_NAMES = ["eps11", "eps22", "eps33", "gamma23", "gamma31", "gamma12"];
const PIVOT_PREFERENCE = [0, 1, 5, 2, 3, 4];

function rank(rows, tol = 1e-9) {
  const M = rows.map((r) => r.slice());
  let rk = 0;
  for (let c = 0; c < (M[0]?.length ?? 0) && rk < M.length; c++) {
    let p = rk;
    for (let r = rk + 1; r < M.length; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < tol) continue;
    [M[p], M[rk]] = [M[rk], M[p]];
    for (let r = rk + 1; r < M.length; r++) { const f = M[r][c] / M[rk][c]; for (let k = c; k < M[0].length; k++) M[r][k] -= f * M[rk][k]; }
    rk++;
  }
  return rk;
}

/**
 * Strain-parameter basis in canonical form: the free parameters ARE strain components. Independent components are
 * chosen in the order eps11, eps22, gamma12, eps33, gamma23, gamma31; each basis column has a 1 in its own
 * component and 0 in the other chosen ones. The remaining components follow from the stress-free conditions.
 * Returns {basis (6 x n), pivots (component indices), labels}.
 */
export function strainBasis(C2D, structType, isSymm, noShear) {
  const B = rawStrainBasis(C2D, structType, isSymm, noShear);
  const n = B[0].length;
  if (n === 0) return Object.assign(B, { pivots: [], labels: [] });
  const pivots = [];
  for (const c of PIVOT_PREFERENCE) {
    if (pivots.length === n) break;
    if (rank([...pivots, c].map((i) => B[i])) > pivots.length) pivots.push(c);
  }
  const canon = matmul(B, inv(pivots.map((i) => B[i])));
  return Object.assign(canon, { pivots, labels: pivots.map((i) => STRAIN_NAMES[i]) });
}

/**
 * Layer orientation, strain and elasticity (port of RefreshLayer).
 * opts.basis: use this 6 x nEps strain basis instead of computing one (use the saved basis to keep the
 *             meaning of the stored coefficients).
 */
export function buildLayer(layer, mat, opts = {}) {
  const [offcut, isSymm, noShear, T_K] = [layer.info["offcut (deg)"], layer.info["in-plane symmetry"], layer.info["no shear"], layer.info["T(K)"]];
  const structType = layer.vars.structType;
  const { A0, alphaT, C: C0, primT } = mat;
  let AM = A0.map((r) => r.map((v) => v * (1 + alphaT * (T_K - 300))));
  const uvwz = layer.waves.uvwzVect, hklx = layer.waves.hklxVect, hklm = layer.waves.hklmVect;

  const zAxis = matvec(AM, uvwz);
  AM = P.rotateBasis(AM, zAxis, Z);
  let BM = T(inv(AM));
  const xAxis = matvec(BM, hklx);
  const Xp = P.findNormalVect(Z, xAxis);
  if (norm(Xp) > 0) AM = P.rotateBasis(AM, Xp, X);
  const tilt = matvec(BM, hklm);                 // note: BM is the reciprocal basis from before the x-axis rotation (as in Igor)
  if (norm(tilt) > 0) AM = P.rotateBasisAngle(AM, zAxis, tilt, offcut);

  const TM = matmul(AM, inv(A0));
  const C = rotateElast(C0, TM);
  const C2D = VOIGT_PAIRS.map(([i, j]) => VOIGT_PAIRS.map(([k, l]) => C[i][j][k][l]));
  const basis = opts.basis ?? strainBasis(C2D, structType, isSymm, noShear);   // stored basis, or canonical strain basis
  const nEps = basis[0].length;
  const coef = layer.params.map((p) => p.value);
  const epsVect = nEps ? matvec(basis, coef.slice(0, nEps)) : [0, 0, 0, 0, 0, 0];
  if (nEps) {
    const D = [0, 1, 2].map((p) => [0, 1, 2].map((q) => (p === q ? 1 : 0) + (p === q ? 1 : 0.5) * epsVect[IJ_VOIGT[p][q]]));
    AM = matmul(D, AM);
  }
  const ApM = matmul(AM, primT);
  return { AM, BM: T(inv(AM)), ApM, BpM: T(inv(ApM)), TM, C, C2D, basis, epsVect, rawC2D: C2D };
}

// ---------------------------------------------------------------- Model (camera geometry + oriented lattice)
export function buildModel(model, layerState, mat, beam) {
  const [L, phi, xZone, yZone, eccX, eccY] = model.params.map((p) => p.value);
  const uvwz = model.waves.uvwzVect, hklx = model.waves.hklxVect;
  let UM = layerState.AM.map((r) => r.slice());
  const zone = matvec(UM, uvwz);
  UM = P.rotateBasis(UM, zone, Z);
  let VM = T(inv(UM));
  const para = matvec(VM, hklx);
  const vert = cross(Z, para);
  if (norm(vert) > 0) UM = P.rotateBasis(UM, vert, Y);
  VM = T(inv(UM));
  const UpM = matmul(UM, mat.primT), VpM = T(inv(UpM));
  const s = Math.sin((phi / 180) * Math.PI), c = Math.cos((phi / 180) * Math.PI);
  const phiMat = [[c, -s], [s, c]];
  const eccR = Math.sqrt(1 + eccX ** 2 + eccY ** 2);
  const EccMat = [[eccR + eccX, eccY], [eccY, eccR - eccX]];
  const info = model.info;
  return {
    L, xZone, yZone, UM, VM, UpM, VpM, UTM: T(UM), VTM: T(VM), VpTM: T(VpM), phiMat, phiIMat: inv(phiMat), EccMat, EccIMat: inv(EccMat),
    dynCorr: info["dyn_correction"], gmax: info["gmax (nm^-1)"], thresh: info["thresh"], maxBeams: info["max_beams"],
    dxBeam: info["xb (pix)"], dyBeam: info["yb (pix)"], alpha: info["alpha(mrad)"],
    uvwz, hklx, E: beam.params[0].value, mat, dE1: 0,
  };
}

// ---------------------------------------------------------------- line geometry
const del2 = (v) => norm(v);
// TransformDel: transform a line given by its closest-point vector under the point map M.
export function transformDel(v, M) {
  const d = norm(v);
  const r = v.map((x) => x / d ** 2);
  const p = matvec(T(inv(M)), r);
  const dp = 1 / norm(p);
  return p.map((x) => dp * dp * x);
}
export function translateDel(v, dR, sign = 1) {
  const d = norm(v), c = v[0] / d, s = v[1] / d;
  const dp = d + sign * (dR[0] * c + dR[1] * s);
  return [dp * c, dp * s];
}

/** Reciprocal-space offset of the HOLZ line of reflection g (port of GetDelKV). */
export function delK(G, lambda, isExcess) {
  const g = norm(G), k = 1 / lambda;
  const kz = k * Math.cos(Math.asin(g / 2 / k) - Math.asin(G[2] / g));
  const num = G[2] * kz - (g * g) / 2;
  const kxi = num / G[0], kyi = num / G[1];
  const kd = 1 / Math.sqrt(1 / kxi ** 2 + 1 / kyi ** 2);
  const d = [(kd * kd) / kxi, (kd * kd) / kyi];
  if (isExcess) { d[0] += G[0]; d[1] += G[1]; }
  return { d, kz };
}

/** Line position delR (pixels) for reciprocal vector G (port of GetDelRV). */
export function delRFromG(G, lambda, L, rZone, rBeam, phiMat, EccMat, isExcess) {
  const { d, kz } = delK(G, lambda, isExcess);
  let v = d.map((x) => (L * x) / kz);
  v = transformDel(v, phiMat);
  v = translateDel(v, rZone);
  v = translateDel(v, rBeam, -1);
  v = transformDel(v, EccMat);
  return translateDel(v, rBeam);
}

/** delR for Miller indices hkl on a model (port of FindDelRV, including the dynamical energy correction). */
export function findDelR(m, hkl, isExcess = 0) {
  const G = matvec(m.VM, hkl);
  const ruvwz = matvec(m.UM, m.uvwz);
  const n = dot(ruvwz, G);
  const dE = m.dynCorr && Math.abs(n) > 0.5 ? m.dE1 / n : 0;
  const lambda = P.wavelength(m.E - dE);
  const rZone = [m.xZone, m.yZone];
  const rBeam = [m.xZone + m.dxBeam, m.yZone + m.dyBeam];
  return delRFromG(G, lambda, m.L, rZone, rBeam, m.phiMat, m.EccMat, isExcess);
}

// ---------------------------------------------------------------- line intersections / residuals
/** Intersection of two lines given by delR1, delR2 (port of FindInter). */
export function findInter(d1, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  const n1 = d1[0] ** 2 + d1[1] ** 2, n2 = d2[0] ** 2 + d2[1] ** 2;
  return [(n1 * d2[1] - d1[1] * n2) / den, (d1[0] * n2 - n1 * d2[0]) / den];
}
