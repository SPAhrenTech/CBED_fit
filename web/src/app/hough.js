// Snap a roughly drawn line segment onto the nearest ridge/valley of the image (a small local Hough-style search).
// Coordinates are model coordinates: x = column, y measured upward (row = height - y).
export function sample(img, x, y) {
  const r = img.height - y, c = x;
  const x0 = Math.floor(c), y0 = Math.floor(r);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return NaN;
  const fx = c - x0, fy = r - y0, d = img.data, w = img.width;
  const a = d[y0 * w + x0], b = d[y0 * w + x0 + 1], cc = d[(y0 + 1) * w + x0], e = d[(y0 + 1) * w + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + e * fx) * fy;
}

function lineScore(img, mid, u, half, offset, sign, flank) {
  const nx = -u[1], ny = u[0];
  let sum = 0, cnt = 0;
  for (let t = -half; t <= half; t += 2) {
    const x = mid[0] + u[0] * t + nx * offset, y = mid[1] + u[1] * t + ny * offset;
    const c = sample(img, x, y), a = sample(img, x + nx * flank, y + ny * flank), b = sample(img, x - nx * flank, y - ny * flank);
    if (Number.isNaN(c) || Number.isNaN(a) || Number.isNaN(b)) continue;
    sum += sign * ((a + b) / 2 - c); cnt++;      // dark line: flanks brighter than the centre
  }
  return cnt > 5 ? sum / cnt : -Infinity;
}

/** dark: true for dark HOLZ lines (default), false for bright. Returns refined endpoints and the score gain. */
export function snapLine(img, p0, p1, { dark = true, maxShift = 8, maxAngleDeg = 3, flank = 4 } = {}) {
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), half = len / 2;
  const th0 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const sign = dark ? 1 : -1;
  let best = { s: -Infinity, th: th0, off: 0 };
  const base = lineScore(img, mid, [Math.cos(th0), Math.sin(th0)], half, 0, sign, flank);
  for (let a = -maxAngleDeg; a <= maxAngleDeg + 1e-9; a += 0.25) {
    const th = th0 + (a * Math.PI) / 180, u = [Math.cos(th), Math.sin(th)];
    for (let off = -maxShift; off <= maxShift + 1e-9; off += 0.5) {
      const s = lineScore(img, mid, u, half, off, sign, flank);
      if (s > best.s) best = { s, th, off };
    }
  }
  const u = [Math.cos(best.th), Math.sin(best.th)], n = [-u[1], u[0]];
  const c = [mid[0] + n[0] * best.off, mid[1] + n[1] * best.off];
  return { p0: [c[0] - u[0] * half, c[1] - u[1] * half], p1: [c[0] + u[0] * half, c[1] + u[1] * half], gain: best.s - base, score: best.s };
}

/** Closest point of the infinite line through p0, p1 to the origin: the delR representation used by the model. */
export function delRFromPoints(p0, p1) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const u = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
  const t = p0[0] * u[0] + p0[1] * u[1];
  return [p0[0] - t * u[0], p0[1] - t * u[1]];
}
