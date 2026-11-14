// Small dense linear algebra. Matrices are arrays of rows: M[i][j], same indexing as the Igor waves.
export const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));
export const eye = (n) => { const I = zeros(n, n); for (let i = 0; i < n; i++) I[i][i] = 1; return I; };
export const T = (A) => A[0].map((_, j) => A.map((r) => r[j]));
export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export const norm = (a) => Math.sqrt(dot(a, a));
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const matvec = (A, v) => A.map((r) => dot(r, v));
export const matmul = (A, B) => {
  const Bt = T(B);
  return A.map((r) => Bt.map((c) => dot(r, c)));
};

export function det(A) {
  const n = A.length;
  const M = A.map((r) => r.slice());
  let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (M[p][c] === 0) return 0;
    if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; d = -d; }
    d *= M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return d;
}

export function inv(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...eye(n)[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (M[p][c] === 0) throw new Error("singular matrix");
    [M[p], M[c]] = [M[c], M[p]];
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c];
      if (f !== 0) for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r.slice(n));
}

// Symmetric eigenproblem (cyclic Jacobi). Returns {values, vectors} with vectors as COLUMNS (vectors[i][k] = component i of eigenvector k).
export function eigSym(S) {
  const n = S.length;
  const A = S.map((r) => r.slice());
  const V = eye(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
      for (let k = 0; k < n; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}

// Hermitian eigenproblem via the real symmetric embedding [[Re,-Im],[Im,Re]].
// H is given as {re, im} matrices. Returns eigenvalues (ascending, each once) and eigenvectors as
// {re, im} columns, via picking one vector from each degenerate pair of the embedding.
export function eigHermitian(re, im) {
  const n = re.length;
  const big = zeros(2 * n, 2 * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    big[i][j] = re[i][j]; big[i + n][j + n] = re[i][j];
    big[i][j + n] = -im[i][j]; big[i + n][j] = im[i][j];
  }
  const { values, vectors } = eigSym(big);
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const vals = [], vecs = [];
  // Each eigenvalue appears twice; the pair (u,v) and (-v,u) represent the same complex vector up to phase.
  for (let k = 0; k < 2 * n; k += 2) {
    const idx = order[k];
    vals.push(values[idx]);
    vecs.push({ re: Array.from({ length: n }, (_, i) => vectors[i][idx]), im: Array.from({ length: n }, (_, i) => vectors[i + n][idx]) });
  }
  return { values: vals, vectors: vecs };
}

// Left pseudoinverse (A^T A)^-1 A^T, or null when A^T A is singular (same tolerance test as the Igor code).
export function pinvLeft(A) {
  const At = T(A), P = matmul(At, A);
  const n = P.length;
  const d = det(P), tr = P.reduce((s, r, i) => s + r[i], 0);
  if (!(tr !== 0) || Math.abs(Math.abs(d) ** (1 / n) / tr) < 1e-24) return null;
  return matmul(inv(P), At);
}
