// Compact (de)serialization of loaded images so a saved project is self-contained.
import { withStats } from "./tiff.js";

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

/** {width,height,data} -> {width,height,type:"u8"|"u16"|"f32",b64}, using the smallest lossless integer type. */
export function encodeImage(img) {
  let int = true, max = 0;
  for (const v of img.data) { if (!(Number.isInteger(v) && v >= 0)) { int = false; break; } if (v > max) max = v; }
  const type = int && max < 256 ? "u8" : int && max < 65536 ? "u16" : "f32";
  const arr = type === "u8" ? Uint8Array.from(img.data) : type === "u16" ? Uint16Array.from(img.data) : Float32Array.from(img.data);
  return { width: img.width, height: img.height, type, b64: b64(new Uint8Array(arr.buffer)) };
}

export function decodeImage(e) {
  const raw = unb64(e.b64), buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const arr = e.type === "u8" ? new Uint8Array(buf) : e.type === "u16" ? new Uint16Array(buf) : new Float32Array(buf);
  return withStats({ width: e.width, height: e.height, data: Float32Array.from(arr) });
}
