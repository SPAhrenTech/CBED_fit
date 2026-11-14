import test from "node:test";
import assert from "node:assert/strict";
import { readTiff } from "../web/src/app/tiff.js";
import { snapLine, delRFromPoints } from "../web/src/app/hough.js";

function makeTiff(w, h, vals, { bits = 16, le = true } = {}) {
  const nTags = 8, ifdOff = 8, dataOff = ifdOff + 2 + nTags * 12 + 4, bytes = bits / 8;
  const buf = new ArrayBuffer(dataOff + w * h * bytes), dv = new DataView(buf);
  dv.setUint16(0, le ? 0x4949 : 0x4d4d); dv.setUint16(2, 42, le); dv.setUint32(4, ifdOff, le); dv.setUint16(ifdOff, nTags, le);
  const tag = (i, t, type, v) => { const o = ifdOff + 2 + i * 12; dv.setUint16(o, t, le); dv.setUint16(o + 2, type, le); dv.setUint32(o + 4, 1, le); type === 3 ? dv.setUint16(o + 8, v, le) : dv.setUint32(o + 8, v, le); };
  tag(0, 256, 4, w); tag(1, 257, 4, h); tag(2, 258, 3, bits); tag(3, 259, 3, 1); tag(4, 262, 3, 1); tag(5, 273, 4, dataOff); tag(6, 278, 4, h); tag(7, 279, 4, w * h * bytes);
  vals.forEach((v, i) => (bits === 16 ? dv.setUint16(dataOff + 2 * i, v, le) : dv.setUint8(dataOff + i, v)));
  return buf;
}

test("TIFF reader: 16-bit little- and big-endian, 8-bit", () => {
  const vals = [0, 1, 1000, 65535, 7, 8];
  for (const le of [true, false]) { const t = readTiff(makeTiff(3, 2, vals, { le })); assert.deepEqual([t.width, t.height], [3, 2]); assert.deepEqual(Array.from(t.data), vals); }
  assert.deepEqual(Array.from(readTiff(makeTiff(2, 2, [1, 2, 3, 255], { bits: 8 })).data), [1, 2, 3, 255]);
});

test("TIFF reader rejects compressed files clearly", () => {
  const b = makeTiff(2, 2, [1, 2, 3, 4]); new DataView(b).setUint16(8 + 2 + 3 * 12 + 8, 5, true);
  assert.throws(() => readTiff(b), /Compressed/);
});

test("snapLine pulls a sloppy segment onto a dark line", () => {
  const W = 300, H = 300, data = new Float32Array(W * H).fill(200);
  // dark line through model points (50,60)-(250,160): y = 0.5x + 35 (model y up => row = H - y)
  for (let x = 0; x < W; x++) for (let dy = -1; dy <= 1; dy++) { const y = 0.5 * x + 35 + dy * 0.5, r = Math.round(H - y); if (r >= 0 && r < H) data[r * W + x] = 20; }
  const img = { width: W, height: H, data };
  const r = snapLine(img, [50, 66], [250, 154], { dark: true });         // offset and rotated from the truth
  const err = (p) => Math.abs(p[1] - (0.5 * p[0] + 35));
  assert.ok(err(r.p0) < 1.0 && err(r.p1) < 1.0, `endpoint errors ${err(r.p0)}, ${err(r.p1)}`);
  assert.ok(r.gain > 0);
});

test("delRFromPoints is the closest point of the line to the origin", () => {
  const d = delRFromPoints([0, 10], [10, 10]);
  assert.ok(Math.abs(d[0]) < 1e-12 && Math.abs(d[1] - 10) < 1e-12);
});
