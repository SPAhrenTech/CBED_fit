// Minimal baseline TIFF reader: uncompressed, single-channel grayscale (8/16/32-bit integer or 32/64-bit float),
// strip-based. Enough for typical diffraction-pattern exports; anything else gets a clear error.
export function readTiff(buffer) {
  const dv = new DataView(buffer);
  const le = dv.getUint16(0) === 0x4949;
  if (!le && dv.getUint16(0) !== 0x4d4d) throw new Error("Not a TIFF file");
  if (dv.getUint16(2, le) !== 42) throw new Error("Unsupported TIFF variant (BigTIFF?)");
  const ifd = dv.getUint32(4, le);
  const n = dv.getUint16(ifd, le);
  const tags = {};
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    const tag = dv.getUint16(o, le), type = dv.getUint16(o + 2, le), count = dv.getUint32(o + 4, le);
    const size = (SIZE[type] ?? 1) * count;
    const vo = size <= 4 ? o + 8 : dv.getUint32(o + 8, le);
    const vals = [];
    for (let k = 0; k < count; k++) {
      if (type === 3) vals.push(dv.getUint16(vo + 2 * k, le));
      else if (type === 4) vals.push(dv.getUint32(vo + 4 * k, le));
      else if (type === 1) vals.push(dv.getUint8(vo + k));
      else vals.push(0);
    }
    tags[tag] = vals;
  }
  const w = tags[256][0], h = tags[257][0];
  const bits = (tags[258] ?? [1])[0], spp = (tags[277] ?? [1])[0], comp = (tags[259] ?? [1])[0];
  const fmt = (tags[339] ?? [1])[0], planar = (tags[284] ?? [1])[0];
  if (comp !== 1) throw new Error(`Compressed TIFF (compression ${comp}) is not supported; export as uncompressed`);
  if (spp !== 1) throw new Error("Only single-channel (grayscale) TIFFs are supported");
  const offs = tags[273], counts = tags[279], rps = (tags[278] ?? [h])[0];
  const bytes = bits / 8;
  const data = new Float32Array(w * h);
  let px = 0;
  for (let s = 0; s < offs.length; s++) {
    const nPix = Math.min(counts ? counts[s] / bytes : rps * w, w * h - px);
    for (let k = 0; k < nPix; k++) {
      const o = offs[s] + k * bytes;
      let v;
      if (fmt === 3) v = bits === 32 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
      else if (fmt === 2) v = bits === 8 ? dv.getInt8(o) : bits === 16 ? dv.getInt16(o, le) : dv.getInt32(o, le);
      else v = bits === 8 ? dv.getUint8(o) : bits === 16 ? dv.getUint16(o, le) : dv.getUint32(o, le);
      data[px++] = v;
    }
  }
  if ((tags[262] ?? [1])[0] === 0) { let mx = -Infinity; for (const v of data) if (v > mx) mx = v; for (let i = 0; i < data.length; i++) data[i] = mx - data[i]; }
  return { width: w, height: h, data };
}

/** Decode any browser-supported image (PNG/JPEG) to grayscale, or a TIFF via readTiff. */
export async function loadImageFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, 4);
  const isTiff = (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d);
  const img = isTiff ? readTiff(buf) : await decodeRaster(new Blob([buf]));
  return withStats(img);
}

export async function decodeRaster(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
  const out = new Float32Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = data[4 * i];
  return { width: bmp.width, height: bmp.height, data: out };
}

export function withStats(img) {
  const s = Float32Array.from(img.data).sort();
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { ...img, min: s[0], max: s[s.length - 1], p01: q(0.01), p99: q(0.99) };
}
