import { h, fmt, sci } from "./dom.js";

const GROUP_TITLE = { Beam: "Beam", Model: "Camera / geometry", Layer: "Layer strain", Material: "Material" };

/** Parameters panel: every parameter of the active fit's beam, model, layer and material. */
export class ParamsPanel {
  constructor(root, store) { this.root = root; this.store = store; this.sig = ""; this.rows = []; store.subscribe((k) => this.update(k)); }
  signature() { return this.store.activeObjects().map((o) => o.id + ":" + o.params.map((p) => `${p.label}${p.hold ? "h" : "f"}${p.step}`).join(",")).join("|") + this.store.activeFitId; }
  update(kind) {
    if (!this.store.project) return;
    const sig = this.signature();
    if (sig !== this.sig) { this.sig = sig; this.build(); }
    for (const r of this.rows) {
      const p = this.store.project.objects.find((o) => o.id === r.id).params[r.index];
      if (document.activeElement !== r.input) r.input.value = fmt(p.value);
      r.err.textContent = p.del != null && !p.hold ? "± " + sci(p.del) : "";
    }
    this.fitSelect.value = this.store.activeFitId;
  }
  build() {
    const s = this.store; this.rows = [];
    this.fitSelect = h("select", { onchange: (e) => s.setActiveFit(e.target.value) }, s.fitIds.map((id) => h("option", { value: id }, `${id}  ${s.project.objects.find((o) => o.id === id).title}`)));
    const body = [h("label", { class: "field" }, h("span", {}, "Active fit"), this.fitSelect)];
    for (const o of s.activeObjects()) {
      if (!o.params.length) continue;
      body.push(h("h3", {}, `${GROUP_TITLE[o.type]} `, h("small", {}, o.title)));
      const table = h("div", { class: "params" }, ...["", "value", "± error", "hold", "step 10ⁿ"].map((t) => h("span", { class: "colhead" }, t)));
      o.params.forEach((p, index) => {
        const input = h("input", { type: "text", inputmode: "decimal", spellcheck: "false", class: "num", value: fmt(p.value), onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) s.setParam(o.id, index, v); else e.target.value = fmt(s.obj(s.project, o.id).params[index].value); } });
        input.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); s.stepParam(o.id, index, e.key === "ArrowUp" ? 1 : -1); } });
        const err = h("span", { class: "err" });
        const stepIn = h("input", { type: "number", class: "step", title: "log10 of the arrow-button increment", value: p.step ?? -3, min: -12, max: 6, step: 1, onchange: (e) => s.setStep(o.id, index, parseInt(e.target.value, 10)) });
        table.append(
          h("span", { class: "lbl" }, p.label),
          h("span", { class: "spin" }, input,
            h("button", { class: "arrow", title: "increase", onclick: () => s.stepParam(o.id, index, 1) }, "▲"),
            h("button", { class: "arrow", title: "decrease", onclick: () => s.stepParam(o.id, index, -1) }, "▼")),
          err,
          h("label", { class: "hold", title: "tick to hold fixed" }, h("input", { type: "checkbox", checked: p.hold, onchange: (e) => s.setHold(o.id, index, e.target.checked) })),
          stepIn,
        );
        this.rows.push({ id: o.id, index, input, err });
      });
      body.push(table);
    }
    const info = s.ctx.model.info;
    body.push(h("h3", {}, "Model options"));
    body.push(h("div", { class: "params" },
      ...["alpha(mrad)", "xb (pix)", "yb (pix)", "gmax (nm^-1)", "thresh", "max_beams"].flatMap((k) => [
        h("span", { class: "lbl" }, k),
        h("input", { class: "num", value: fmt(info[k]), onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) s.mutate((p) => { s.obj(p, s.ctx.model.id).info[k] = v; }); } }),
        h("span"), h("span"), h("span")]),
      h("span", { class: "lbl" }, "dynamical corr."),
      h("label", { class: "hold" }, h("input", { type: "checkbox", checked: !!info["dyn_correction"], onchange: (e) => s.mutate((p) => { s.obj(p, s.ctx.model.id).info["dyn_correction"] = e.target.checked ? 1 : 0; }) })), h("span"), h("span"), h("span")));
    this.root.replaceChildren(...body);
  }
}

/** Marked lines table. */
export class LinesPanel {
  constructor(root, store) { this.root = root; this.store = store; store.subscribe((k) => { if (k !== "image") this.render(); }); }
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
      h("p", { class: "hint" }, "Press ", h("kbd", {}, "M"), " (or choose Mark line) and drag along a line in the image; it snaps to the nearest ridge and takes the hkl of the closest simulated line. ● marks lines that form intersections used by the fit."),
      h("table", { class: "lines" }, h("thead", {}, h("tr", {}, ...["#", "hkl", "Δ (px)", "fit", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rows)),
      h("p", { class: "hint" }, `${lines.length} lines, ${lines.filter((l) => l.assigned).length} assigned, ${used.size} used in ${fit.waves.interList?.length ?? 0} intersections.`));
  }
}

/** Fit panel. */
export class FitPanel {
  constructor(root, store) { this.root = root; this.store = store; store.subscribe((k) => { if (k === "fit" || k === "all" || k === "lines") this.render(); }); }
  render() {
    const s = this.store, f = s.fit; if (!s.project) return;
    const free = s.freeList();
    const nPairs = s.ctx.fit.waves.interList?.length ?? 0;
    const last = f.log.slice(-12).map((l) => h("tr", {}, h("td", {}, l.iter), h("td", { class: "r" }, l.fom.toFixed(4))));
    this.root.replaceChildren(
      h("div", { class: "row" },
        h("button", { class: "primary", disabled: f.running, onclick: () => s.runFit(parseInt(this.iters.value, 10) || 20) }, f.running ? "Fitting…" : "Run fit"),
        h("button", { disabled: !f.running, onclick: () => s.stopFit() }, "Stop"),
        h("label", { class: "inline" }, "iterations ", this.iters = h("input", { type: "number", value: this.iters?.value ?? 20, min: 1, max: 500, class: "step" }))),
      h("dl", {},
        h("dt", {}, "Free parameters"), h("dd", {}, free.length),
        h("dt", {}, "Data points"), h("dd", {}, nPairs * 2),
        h("dt", {}, "FOM"), h("dd", {}, f.fom == null ? "–" : f.fom.toFixed(4)),
        h("dt", {}, "Status"), h("dd", {}, f.status)),
      h("p", { class: "hint" }, "FOM is the root-sum-square of the intersection-point residuals in pixels (σ = 1 px). Hold a parameter to keep it fixed; errors are shown next to each fitted parameter."),
      last.length ? h("table", { class: "lines" }, h("thead", {}, h("tr", {}, h("th", {}, "iter"), h("th", {}, "FOM"))), h("tbody", {}, last)) : null,
      s.error ? h("p", { class: "error" }, s.error) : null);
  }
}
