import { snapLine, delRFromPoints } from "./hough.js";

// Model coordinates: x = image column, y = height - image row (y up). The canvas works in image pixels (row down).
export class Viewer {
  constructor(canvas, store, hooks = {}) {
    this.canvas = canvas; this.g = canvas.getContext("2d"); this.store = store; this.hooks = hooks;
    this.view = { s: 1, ox: 0, oy: 0 };
    this.tool = "pan"; this.show = { image: true, sim: true, marked: true, labels: true, disk: true };
    this.window = { lo: 0, hi: 1 };       // fractions between p01 and p99
    this.snap = true; this.dark = true;
    this.drag = null; this.cursor = null; this.tmp = null;
    this.bitmap = null;
    this.views = new Map(); this.srcKey = undefined;   // pan/zoom remembered per pattern
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => { this.cursor = null; this.hooks.onCursor?.(null); this.draw(); });
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  get img() { return this.store.image; }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + "px"; this.canvas.style.height = r.height + "px";
    this.dpr = dpr;
    if (!this.fitted && this.img) this.fitToWindow();
    this.draw();
  }
  fitToWindow() {
    if (!this.img) return;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const s = Math.min(w / this.img.width, h / this.img.height) * 0.95;
    this.view = { s, ox: (w - this.img.width * s) / 2, oy: (h - this.img.height * s) / 2 };
    this.fitted = true;
  }
  /** Switch to another pattern/image: remember the current view, restore the target's (or fit it). Returns false if unchanged. */
  setSource(key) {
    if (key === this.srcKey) return false;
    if (this.srcKey !== undefined) this.views.set(this.srcKey, { ...this.view });
    this.srcKey = key;
    this.rebuildBitmap();
    const saved = this.views.get(key);
    if (saved) { this.view = { ...saved }; this.fitted = true; } else { this.fitted = false; this.fitToWindow(); }
    this.draw();
    return true;
  }
  imageChanged() { this.fitted = false; this.rebuildBitmap(); this.fitToWindow(); this.draw(); }

  rebuildBitmap() {
    const img = this.img; if (!img) { this.bitmap = null; return; }
    const lo = img.p01 + (img.p99 - img.p01) * this.window.lo, hi = img.p01 + (img.p99 - img.p01) * this.window.hi;
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const id = c.getContext("2d").createImageData(img.width, img.height), k = 255 / Math.max(hi - lo, 1e-9);
    for (let i = 0; i < img.data.length; i++) { const v = Math.max(0, Math.min(255, (img.data[i] - lo) * k)); id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = v; id.data[4 * i + 3] = 255; }
    c.getContext("2d").putImageData(id, 0, 0);
    this.bitmap = c;
  }
  setWindow(lo, hi) { this.window = { lo, hi }; this.rebuildBitmap(); this.draw(); }

  // ---- coordinate transforms ----
  toScreen(x, y) { const H = this.img?.height ?? 0; return [x * this.view.s + this.view.ox, (H - y) * this.view.s + this.view.oy]; }
  toModel(sx, sy) { const H = this.img?.height ?? 0; return [(sx - this.view.ox) / this.view.s, H - (sy - this.view.oy) / this.view.s]; }
  evPos(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  // ---- interaction ----
  onWheel(e) {
    e.preventDefault();
    const [sx, sy] = this.evPos(e), f = Math.exp(-e.deltaY * 0.0015), v = this.view;
    const ns = Math.min(40, Math.max(0.05, v.s * f));
    v.ox = sx - ((sx - v.ox) * ns) / v.s; v.oy = sy - ((sy - v.oy) * ns) / v.s; v.s = ns;
    this.draw();
  }
  onDown(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const [sx, sy] = this.evPos(e);
    if (this.tool === "mark" && e.button === 0) this.drag = { kind: "mark", a: this.toModel(sx, sy), b: this.toModel(sx, sy) };
    else this.drag = { kind: "pan", sx, sy, ox: this.view.ox, oy: this.view.oy, moved: false };
  }
  onMove(e) {
    const [sx, sy] = this.evPos(e), m = this.toModel(sx, sy);
    this.cursor = m; this.hooks.onCursor?.(m);
    const d = this.drag;
    if (d?.kind === "pan") { if (Math.hypot(sx - d.sx, sy - d.sy) > 3) d.moved = true; this.view.ox = d.ox + sx - d.sx; this.view.oy = d.oy + sy - d.sy; }
    else if (d?.kind === "mark") d.b = m;
    this.draw();
  }
  onUp(e) {
    const d = this.drag; this.drag = null;
    if (!d) return;
    const [sx, sy] = this.evPos(e);
    if (d.kind === "pan" && !d.moved) this.pick(this.toModel(sx, sy));
    if (d.kind === "mark") {
      const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * this.view.s;
      if (len > 25) this.addMarked(d.a, d.b);
    }
    this.draw();
  }
  onKey(e) {
    if (e.target.matches?.("input, textarea, select")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && this.store.selectedLine >= 0) this.store.removeLine(this.store.selectedLine);
    if (e.key === "m") this.hooks.setTool?.("mark");
    if (e.key === "v" || e.key === "Escape") this.hooks.setTool?.("pan");
    if (e.key === "f") { this.fitToWindow(); this.draw(); }
  }

  addMarked(a, b) {
    let p0 = a, p1 = b;
    if (this.snap && this.img) { const r = snapLine(this.img, a, b, { dark: this.dark }); if (Number.isFinite(r.score)) { p0 = r.p0; p1 = r.p1; } }
    const delR = delRFromPoints(p0, p1);
    const sug = this.store.suggestHkl(delR);
    this.store.addLine(delR, sug ? sug.hkl.slice() : [0, 0, 0]);
  }
  pick(m) {
    let best = -1, bd = 8 / this.view.s;
    this.store.markedLines().forEach((l) => {
      const n = Math.hypot(...l.delR); const d = Math.abs((m[0] * l.delR[0] + m[1] * l.delR[1]) / n - n);
      if (d < bd) { bd = d; best = l.i; }
    });
    this.store.selectedLine = best; this.store.emit("lines");
  }

  // ---- drawing ----
  /** Endpoints of the line with closest-point vector d, extended across the image. */
  lineEnds(d) {
    const n = Math.hypot(d[0], d[1]), u = [-d[1] / n, d[0] / n], R = this.img ? Math.hypot(this.img.width, this.img.height) * 1.5 : 2000;
    return [[d[0] - u[0] * R, d[1] - u[1] * R], [d[0] + u[0] * R, d[1] + u[1] * R]];
  }
  strokeLine(d, style, width = 1, dash = []) {
    const [a, b] = this.lineEnds(d), g = this.g;
    g.beginPath(); g.moveTo(...this.toScreen(...a)); g.lineTo(...this.toScreen(...b));
    g.strokeStyle = style; g.lineWidth = width; g.setLineDash(dash); g.stroke(); g.setLineDash([]);
  }
  draw() {
    const g = this.g, dpr = this.dpr || 1, W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg") || "#111";
    g.fillRect(0, 0, W, H);
    const img = this.img;
    if (!img) { g.fillStyle = "#888"; g.font = "14px system-ui"; g.fillText("No image for this pattern. Drop a grayscale TIFF here or use Set image.", 24, 40); return; }
    const v = this.view;
    if (this.show.image && this.bitmap) {
      g.imageSmoothingEnabled = v.s < 1;
      g.drawImage(this.bitmap, v.ox, v.oy, img.width * v.s, img.height * v.s);
    }
    g.save();
    g.beginPath(); g.rect(0, 0, W, H); g.clip();
    const ctx = this.store.ctx, sim = this.store.sim;
    if (sim && this.show.disk) {
      const m = sim.m, c = this.toScreen(m.xZone + m.dxBeam, m.yZone + m.dyBeam), rad = m.L * Math.tan(m.alpha / 1000) * v.s;
      g.strokeStyle = "rgba(255,200,0,.7)"; g.lineWidth = 1; g.setLineDash([6, 4]);
      g.beginPath(); g.arc(c[0], c[1], rad, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]);
      const z = this.toScreen(m.xZone, m.yZone); g.beginPath(); g.moveTo(z[0] - 6, z[1]); g.lineTo(z[0] + 6, z[1]); g.moveTo(z[0], z[1] - 6); g.lineTo(z[0], z[1] + 6); g.stroke();
    }
    const css = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
    if (sim && this.show.sim) for (const l of sim.lines) this.strokeLine(l.delR, css("--sim", "rgba(255,70,70,.85)"), 1);
    if (this.show.marked) {
      for (const l of this.store.markedLines()) {
        const sel = l.i === this.store.selectedLine;
        this.strokeLine(l.delR, sel ? css("--sel", "#ffd400") : l.assigned ? css("--mark", "#33d6ff") : css("--unassigned", "#ff9f1c"), sel ? 2 : 1.25, l.assigned ? [] : [5, 3]);
        if (this.show.labels && l.assigned) this.label(l.delR, l.hkl.join(" "), css("--mark", "#33d6ff"));
      }
    }
    if (this.drag?.kind === "mark") { const [a, b] = [this.drag.a, this.drag.b].map((p) => this.toScreen(...p)); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.strokeStyle = "#fff"; g.lineWidth = 1; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]); }
    g.restore();
  }
  label(d, text, color) {
    // Place the label where the line is nearest the viewport centre.
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr;
    const [a, b] = this.lineEnds(d).map((p) => this.toScreen(...p)), ux = b[0] - a[0], uy = b[1] - a[1], L2 = ux * ux + uy * uy;
    const t = Math.max(0.3, Math.min(0.7, ((W / 2 - a[0]) * ux + (H / 2 - a[1]) * uy) / L2));
    const x = a[0] + ux * t, y = a[1] + uy * t;
    if (x < 0 || y < 0 || x > W || y > H) return;
    this.g.font = "11px ui-monospace, monospace"; this.g.fillStyle = color; this.g.fillText(text, x + 4, y - 4);
  }
}
