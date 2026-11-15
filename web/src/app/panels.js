import { h, fmt, sci } from "./dom.js";
import { STRAIN_TYPES, perpHkl } from "../core/factory.js";

const KIND_TYPE = { beam: "Beam", model: "Model", layer: "Layer", material: "Material" };
const zoneText = (z) => `[${z.map((x) => +x.toFixed(2)).join(" ")}]`;

// ------------------------------------------------------------------ pattern strip
/** Navigation over the patterns (one per Fit): switch, include in the joint fit, add. */
export class PatternStrip {
  constructor(root, store, hooks) { this.root = root; this.store = store; this.hooks = hooks; this.queued = false; store.subscribe(() => this.schedule()); }
  schedule() { if (this.queued) return; this.queued = true; requestAnimationFrame(() => { this.queued = false; this.render(); }); }
  render() {
    const s = this.store; if (!s.project) return;
    const pats = s.patterns, many = pats.length > 1;
    const tabs = pats.map((p) => {
      const meta = [zoneText(p.zone), `${p.nAssigned}/${p.nLines} lines`, p.fom != null ? `FOM ${p.fom.toFixed(2)}` : null, p.hasImage ? null : "no image"].filter(Boolean).join(" · ");
      return h("div", { class: `ptab${p.id === s.activeFitId ? " on" : ""}${p.include ? "" : " off"}`, title: "Click to show this pattern", onclick: () => s.setActiveFit(p.id) },
        h("input", { type: "checkbox", checked: p.include, title: "Include in the joint fit", onclick: (e) => e.stopPropagation(), onchange: (e) => s.setInclude(p.id, e.target.checked) }),
        h("span", { class: "t" }, p.title),
        h("span", { class: `m${p.stale ? " stale" : ""}`, title: p.stale ? "FOM from the last fit; parameters have changed since" : "" }, meta));
    });
    this.root.replaceChildren(...[
      many && h("button", { class: "nav", title: "Previous pattern ([ or PageUp)", onclick: () => s.stepPattern(-1) }, "‹"),
      ...tabs,
      many && h("button", { class: "nav", title: "Next pattern (] or PageDown)", onclick: () => s.stepPattern(1) }, "›"),
      h("button", { class: "nav", title: "Add a pattern (another image, orientation or beam)", onclick: () => this.hooks.onAdd() }, "＋ Add pattern")].filter(Boolean));
    this.root.querySelector(".ptab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

// ------------------------------------------------------------------ parameters
/** Everything the active pattern depends on: beam, camera/orientation, layer and material, with sharing controls. */
export class ParamsPanel {
  constructor(root, store) { this.root = root; this.store = store; this.sig = ""; this.binds = []; this.rows = []; store.subscribe((k) => this.update(k)); }

  signature() {
    const s = this.store, c = s.ctx; if (!c) return "";
    const lite = (o) => [o.id, o.title, o.links, o.vars.structType, o.vars.materType, o.type === "Layer" ? [o.info["in-plane symmetry"], o.info["no shear"]] : 0, o.params.map((p) => [p.label, p.hold, p.step])];
    return JSON.stringify([s.activeFitId, c.fit.title, c.fit.info.include, s.fitIds.length, !!s.image, s.imageObj()?.title, s.activeObjects().map(lite),
      Object.values(KIND_TYPE).map((t) => s.project.objects.filter((o) => o.type === t).map((o) => [o.id, o.title])), s.activeObjects().map((o) => s.sharedWith(o.id))]);
  }
  update() {
    if (!this.store.project) return;
    const sig = this.signature();
    if (sig !== this.sig) { this.sig = sig; this.build(); }
    for (const b of this.binds) { try { b(); } catch { /* object gone; the next signature change rebuilds */ } }
  }

  // ---- bound inputs: they re-read the store on every update, so undo/redo and fits show up without rebuilding ----
  num(get, set, cls = "num") {
    const el = h("input", { type: "text", inputmode: "decimal", spellcheck: "false", class: cls, value: fmt(get()) });
    el.addEventListener("change", () => { const v = parseFloat(el.value); if (Number.isFinite(v)) set(v); else el.value = fmt(get()); });
    this.binds.push(() => { if (document.activeElement !== el) el.value = fmt(get()); });
    return el;
  }
  vec(get, set) {
    const els = [0, 1, 2].map((i) => h("input", { type: "text", inputmode: "numeric", class: "num vec", value: get()[i] }));
    const commit = () => { const v = els.map((e) => parseFloat(e.value)); if (v.every(Number.isFinite) && v.some((x) => x !== 0)) set(v); else els.forEach((e, i) => (e.value = get()[i])); };
    els.forEach((e) => e.addEventListener("change", commit));
    this.binds.push(() => els.forEach((e, i) => { if (document.activeElement !== e) e.value = get()[i]; }));
    return h("span", { class: "vec" }, els);
  }
  check(get, set, title) {
    const el = h("input", { type: "checkbox", checked: !!get(), title });
    el.addEventListener("change", () => set(el.checked));
    this.binds.push(() => { el.checked = !!get(); });
    return el;
  }
  cur(id) { return this.store.obj(this.store.project, id); }

  paramTable(o) {
    const s = this.store;
    const table = h("div", { class: "params" }, ...["", "value", "± error", "hold", "step 10ⁿ"].map((t) => h("span", { class: "colhead" }, t)));
    o.params.forEach((p, index) => {
      const input = this.num(() => this.cur(o.id).params[index].value, (v) => s.setParam(o.id, index, v));
      input.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); s.stepParam(o.id, index, e.key === "ArrowUp" ? 1 : -1); } });
      const err = h("span", { class: "err" });
      this.binds.push(() => { const q = this.cur(o.id).params[index]; err.textContent = q.del != null && !q.hold ? "± " + sci(q.del) : ""; });
      const stepIn = h("input", { type: "number", class: "step", title: "log10 of the arrow-button increment", value: p.step ?? -3, min: -12, max: 6, step: 1, onchange: (e) => s.setStep(o.id, index, parseInt(e.target.value, 10)) });
      table.append(
        h("span", { class: "lbl" }, p.label),
        h("span", { class: "spin" }, input,
          h("button", { class: "arrow", title: "increase", onclick: () => s.stepParam(o.id, index, 1) }, "▲"),
          h("button", { class: "arrow", title: "decrease", onclick: () => s.stepParam(o.id, index, -1) }, "▼")),
        err,
        h("label", { class: "hold", title: "tick to hold fixed" }, h("input", { type: "checkbox", checked: p.hold, onchange: (e) => s.setHold(o.id, index, e.target.checked) })),
        stepIn);
    });
    return table;
  }
  /** Section header: object chooser (use another, or an independent copy), name and sharing badge. */
  section(kind, label, o) {
    const s = this.store, all = s.project.objects.filter((x) => x.type === KIND_TYPE[kind]);
    const sel = h("select", { title: `Which ${kind} this pattern uses. Patterns that use the same ${kind} share its parameters.`, onchange: (e) => s.relinkActive(kind, e.target.value) },
      ...all.map((x) => h("option", { value: x.id }, x.title || x.id)), h("option", { value: "new" }, "＋ independent copy of this one"));
    sel.value = o.id;
    const shared = s.sharedWith(o.id);
    return [
      h("div", { class: "sect" }, h("h3", {}, label), sel),
      h("div", { class: "sect" }, h("input", { class: "num titleIn", value: o.title, title: "name", onchange: (e) => s.setTitle(o.id, e.target.value) }),
        shared.length ? h("span", { class: "badge", title: "Parameters of this object are fitted jointly" }, "shared with " + shared.join(", ")) : null),
    ];
  }
  row(label, ...cells) { return [h("span", { class: "lbl" }, label), h("span", {}, ...cells)]; }

  build() {
    const s = this.store, c = s.ctx; this.binds = [];
    if (!c) { this.root.replaceChildren(h("p", { class: "hint" }, "No project.")); return; }
    const { fit, model, layer, beam, mat } = c, img = s.image, body = [];

    // pattern
    body.push(h("div", { class: "sect" }, h("h3", {}, "Pattern"), h("input", { class: "num titleIn", value: fit.title, onchange: (e) => s.renamePattern(fit.id, e.target.value) }),
      h("button", { title: "Remove this pattern from the project", disabled: s.fitIds.length < 2, onclick: () => confirm(`Remove “${fit.title}” and its marked lines?`) && s.removePattern() }, "Remove")));
    body.push(h("div", { class: "sect2" },
      ...this.row("image", h("span", { class: "hint" }, img ? `${s.imageObj().title || "image"} — ${img.width}×${img.height}` : "none yet — use Set image in the toolbar")),
      ...this.row("in joint fit", this.check(() => this.cur(fit.id).info.include, (v) => s.setInclude(fit.id, v), "include this pattern when fitting all patterns")),
      ...this.row("Laue zones", this.num(() => this.cur(fit.id).info.Nzmin, (v) => s.setLaueZones(fit.id, v, null), "num vec"), this.num(() => this.cur(fit.id).info.Nzmax, (v) => s.setLaueZones(fit.id, null, v), "num vec"),
        h("small", { class: "hint" }, " from … to (HOLZ layers simulated)"))));

    // beam
    body.push(...this.section("beam", "Beam", beam), this.paramTable(beam));

    // camera and orientation
    body.push(...this.section("model", "Camera & orientation", model));
    body.push(h("div", { class: "sect2" },
      ...this.row("zone axis [uvw]", this.vec(() => this.cur(model.id).waves.uvwzVect, (v) => s.setZone(model.id, v, null))),
      ...this.row("x reference hkl", this.vec(() => this.cur(model.id).waves.hklxVect, (v) => s.setZone(model.id, this.cur(model.id).waves.uvwzVect, v)))));
    body.push(this.paramTable(model));
    const mi = (k) => this.num(() => this.cur(model.id).info[k], (v) => s.setInfo(model.id, k, v));
    body.push(h("div", { class: "sect2" },
      ...["alpha(mrad)", "xb (pix)", "yb (pix)", "gmax (nm^-1)", "thresh", "max_beams"].flatMap((k) => this.row(k, mi(k))),
      ...this.row("dynamical corr.", this.check(() => this.cur(model.id).info["dyn_correction"], (v) => s.setInfo(model.id, "dyn_correction", v ? 1 : 0)))));

    // layer
    body.push(...this.section("layer", "Layer (strain & growth direction)", layer));
    const L = (patch) => s.editLayer(layer.id, patch), st = layer.vars.structType;
    body.push(h("div", { class: "sect2" },
      ...this.row("growth [uvw]", this.vec(() => this.cur(layer.id).waves.uvwzVect, (v) => L({ waves: { uvwzVect: v, hklxVect: perpHkl(v), hklmVect: perpHkl(v) } }))),
      ...this.row("x reference hkl", this.vec(() => this.cur(layer.id).waves.hklxVect, (v) => L({ waves: { hklxVect: v } }))),
      ...this.row("offcut (deg)", this.num(() => this.cur(layer.id).info["offcut (deg)"], (v) => L({ info: { "offcut (deg)": v } }), "num vec")),
      ...this.row("offcut toward hkl", this.vec(() => this.cur(layer.id).waves.hklmVect, (v) => L({ waves: { hklmVect: v } }))),
      ...this.row("T (K)", this.num(() => this.cur(layer.id).info["T(K)"], (v) => L({ info: { "T(K)": v } }), "num vec")),
      ...this.row("strain", (() => { const sel = h("select", { onchange: (e) => L({ structType: +e.target.value }) }, STRAIN_TYPES.map((t, i) => h("option", { value: i }, t))); sel.value = st; return sel; })()),
      ...(st ? this.row("constraints", h("label", {}, this.check(() => this.cur(layer.id).info["in-plane symmetry"], (v) => L({ info: { "in-plane symmetry": v ? 1 : 0 } })), " in-plane symmetry "),
        h("label", {}, this.check(() => this.cur(layer.id).info["no shear"], (v) => L({ info: { "no shear": v ? 1 : 0 } })), " no shear")) : [])));
    if (layer.params.length) body.push(this.paramTable(layer)); else body.push(h("p", { class: "hint" }, "Unstrained: the lattice is the bulk crystal at this temperature."));

    // material
    body.push(...this.section("material", "Material", mat));
    body.push(h("div", { class: "sect2" }, ...this.row("type", (() => {
      const sel = h("select", { onchange: (e) => s.editMaterialType(mat.id, +e.target.value) }, Object.entries(s.K.materTypes).map(([i, t]) => h("option", { value: i }, t.name)));
      sel.value = mat.vars.materType; return sel;
    })())));
    if (mat.params.length) body.push(this.paramTable(mat));
    this.root.replaceChildren(...body);
  }
}

// ------------------------------------------------------------------ lines
/** Marked lines table of the active pattern. */
export class LinesPanel {
  constructor(root, store) { this.root = root; this.store = store; store.subscribe((k) => { if (k !== "image" && k !== "values") this.render(); }); this.dark = true; }
  houghView(c) {
    const r = c.hough, cv = h("canvas", { width: r.n, height: r.n, class: "hough" }), g = cv.getContext("2d");
    const v = Array.from(r.grid).filter(Number.isFinite), lo = Math.min(...v), hi = Math.max(...v), im = g.createImageData(r.n, r.n);
    for (let j = 0; j < r.n; j++) for (let i = 0; i < r.n; i++) {   // b increases upward, as the image y axis
      const q = r.grid[(r.n - 1 - j) * r.n + i], t = Number.isFinite(q) ? (q - lo) / (hi - lo || 1) : 0, o = (j * r.n + i) * 4;
      im.data.set([255 * t, 255 * Math.sqrt(t), 80 * t, 255], o);
    }
    g.putImageData(im, 0, 0);
    const px = (a) => (a + r.W) / r.step + 0.5, cx = px(0), py = r.n - px(0) + 0, pk = r.n - (c.delR[1] - c.predicted[1] + r.W) / r.step - 0.5;
    g.strokeStyle = "#fff"; g.beginPath(); g.moveTo(cx - 3, py); g.lineTo(cx + 3, py); g.moveTo(cx, py - 3); g.lineTo(cx, py + 3); g.stroke();
    g.strokeStyle = "#3f6"; g.strokeRect(px(c.delR[0] - c.predicted[0]) - 2, pk - 2, 4, 4);
    return cv;
  }
  candidateBlock() {
    const s = this.store, cs = s.candidates ?? [];
    const rows = cs.map((c) => h("tr", {}, h("td", {}, h("input", { type: "checkbox", checked: c.accept, onchange: (e) => { c.accept = e.target.checked; s.emit("candidates"); } })),
      h("td", {}, c.hkl.join(" ")), h("td", { class: "r" }, c.shift.toFixed(1)), h("td", { class: "r" }, c.prominence.toFixed(1)), h("td", {}, this.houghView(c))));
    return [h("div", { class: "row" },
      h("button", { onclick: () => s.findLines({ dark: this.dark }) }, "Find lines (Hough)"),
      h("label", { class: "inline" }, h("input", { type: "checkbox", checked: this.dark, onchange: (e) => { this.dark = e.target.checked; } }), " dark")),
      ...(cs.length ? [h("table", { class: "lines" }, h("thead", {}, h("tr", {}, ...["", "hkl", "shift px", "σ", "accumulator (±16 px)"].map((t) => h("th", {}, t)))), h("tbody", {}, rows)),
        h("div", { class: "row" }, h("button", { class: "primary", onclick: () => s.acceptCandidates() }, `Add ${cs.filter((c) => c.accept).length} checked`), h("button", { onclick: () => { s.candidates = []; s.emit("candidates"); } }, "Discard"))] : [])];
  }
  render() {
    const s = this.store; if (!s.ctx?.expt) return;
    const lines = s.markedLines(), fit = s.ctx.fit;
    const used = new Set((fit.waves.interList ?? []).flat());
    const rows = lines.map((l) => h("tr", { class: l.i === s.selectedLine ? "sel" : "", onclick: () => { s.selectedLine = l.i; s.emit("lines"); } },
      h("td", {}, l.i + 1),
      h("td", {}, h("input", { class: "hkl", value: l.assigned ? l.hkl.join(" ") : "", placeholder: "h k l", onclick: (e) => e.stopPropagation(), onchange: (e) => { const t = e.target.value.trim().split(/[\s,]+/).map(Number); if (t.length === 3 && t.every(Number.isFinite)) s.setLineHkl(l.i, t); else if (!e.target.value.trim()) s.setLineHkl(l.i, [0, 0, 0]); else e.target.value = l.hkl.join(" "); } })),
      h("td", { class: "r" }, l.resid == null ? "–" : l.resid.toFixed(2)),
      h("td", {}, used.has(l.i) ? "●" : "○"),
      h("td", {}, h("button", { class: "arrow", title: "delete line", onclick: (e) => { e.stopPropagation(); s.removeLine(l.i); } }, "✕"))));
    this.root.replaceChildren(
      ...this.candidateBlock(),
      h("p", { class: "hint" }, `Lines of “${fit.title}”. Press `, h("kbd", {}, "M"), " (or choose Mark line) and drag along a line in the image; it snaps to the nearest ridge and takes the hkl of the closest simulated line. ● marks lines that form intersections used by the fit."),
      h("table", { class: "lines" }, h("thead", {}, h("tr", {}, ...["#", "hkl", "Δ (px)", "fit", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rows)),
      h("p", { class: "hint" }, `${lines.length} lines, ${lines.filter((l) => l.assigned).length} assigned, ${used.size} used in ${fit.waves.interList?.length ?? 0} intersections.`));
  }
}

// ------------------------------------------------------------------ fit
/** Run the least-squares fit on this pattern or jointly on all included patterns. */
export class FitPanel {
  constructor(root, store) { this.root = root; this.store = store; store.subscribe((k) => { if (["fit", "all", "lines", "pattern", "structure"].includes(k)) this.render(); }); }
  render() {
    const s = this.store, f = s.fit; if (!s.project || !s.ctx) return;
    const ids = s.scopeFitIds(), free = s.freeList(), pats = s.patterns;
    const nData = ids.reduce((n, id) => n + s.nDataOf(s.obj(s.project, id)), 0);
    const nIncluded = pats.filter((p) => p.include).length;
    const last = f.log.slice(-10).map((l) => h("tr", {}, h("td", {}, l.iter), h("td", { class: "r" }, l.fom.toFixed(4))));
    const nUsers = (id) => ids.filter((fid) => s.objectsOf(fid).some((o) => o.id === id)).length;
    const freeRows = free.map((q) => { const o = s.obj(s.project, q.id), p = o.params[q.index], n = nUsers(q.id);
      return h("tr", {}, h("td", {}, q.label), h("td", { class: "dim" }, o.title || o.id), h("td", { class: "r" }, fmt(p.value, 7)), h("td", { class: "r dim" }, p.del != null ? "± " + sci(p.del) : ""), h("td", {}, n > 1 ? h("span", { class: "badge" }, `×${n}`) : "")); });
    const radio = (v, text) => h("label", {}, h("input", { type: "radio", name: "scope", checked: s.scope === v, disabled: f.running, onchange: () => s.setScope(v) }), " " + text);
    this.root.replaceChildren(
      h("div", { class: "fitscope" }, radio("active", `This pattern only (“${s.ctx.fit.title}”)`), radio("all", `All included patterns, jointly (${nIncluded} of ${pats.length})`)),
      h("div", { class: "row" },
        h("button", { class: "primary", disabled: f.running, onclick: () => s.runFit(parseInt(this.iters.value, 10) || 20) }, f.running ? "Fitting…" : "Run fit"),
        h("button", { disabled: !f.running, onclick: () => s.stopFit() }, "Stop"),
        h("label", { class: "inline" }, "iterations ", this.iters = h("input", { type: "number", value: this.iters?.value ?? 20, min: 1, max: 500, class: "step" }))),
      h("dl", {},
        h("dt", {}, "Patterns in fit"), h("dd", {}, ids.length),
        h("dt", {}, "Free parameters"), h("dd", {}, free.length),
        h("dt", {}, "Data points"), h("dd", {}, nData),
        h("dt", {}, "FOM"), h("dd", {}, f.fom == null ? "–" : f.fom.toFixed(4)),
        h("dt", {}, "Status"), h("dd", {}, f.status)),
      h("h3", {}, "Free parameters"),
      free.length ? h("table", { class: "lines" }, h("tbody", {}, freeRows)) : h("p", { class: "hint" }, "Everything is held. Untick “hold” next to a parameter in the Parameters tab."),
      h("p", { class: "hint" }, "A parameter of an object shared by several patterns (×n) is fitted once, against the lines of all of them. FOM is the root-sum-square of the intersection-point residuals in pixels (σ = 1 px)."),
      h("h3", {}, "Patterns"),
      h("table", { class: "lines" }, h("thead", {}, h("tr", {}, ...["pattern", "pairs", "FOM"].map((t) => h("th", {}, t)))),
        h("tbody", {}, pats.map((p) => h("tr", { class: p.id === s.activeFitId ? "sel" : "", onclick: () => s.setActiveFit(p.id) },
          h("td", {}, p.title, ids.includes(p.id) ? "" : h("small", { class: "dim" }, " (not in fit)")), h("td", { class: "r" }, p.nPairs), h("td", { class: `r${p.stale ? " dim" : ""}` }, p.fom == null ? "–" : p.fom.toFixed(3)))))),
      last.length ? h("h3", {}, "Last iterations") : null,
      last.length ? h("table", { class: "lines" }, h("thead", {}, h("tr", {}, h("th", {}, "iter"), h("th", {}, "FOM"))), h("tbody", {}, last)) : null,
      s.error ? h("p", { class: "error" }, s.error) : null);
  }
}
