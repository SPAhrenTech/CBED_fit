import { h } from "./dom.js";

/**
 * Modal form. fields: [{key, label, type: text|number|select|vec3|check|file, value, options:[{value,label}], hint, accept,
 * show: (values) => bool}]. Resolves to {key: value} on OK (vec3 -> [n,n,n], file -> File|null), or null on cancel.
 */
export function formDialog(title, fields, { ok = "OK", intro = null } = {}) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "modal" });
    const inputs = {};
    const read = (f) => {
      const el = inputs[f.key];
      if (f.type === "vec3") return el.map((e) => parseFloat(e.value));
      if (f.type === "check") return el.checked;
      if (f.type === "number") return parseFloat(el.value);
      if (f.type === "file") return el.files[0] ?? null;
      return f.type === "select" ? (typeof f.options[0].value === "number" ? Number(el.value) : el.value) : el.value;
    };
    const values = () => Object.fromEntries(fields.map((f) => [f.key, read(f)]));
    const rows = fields.map((f) => {
      let control;
      if (f.type === "select") { control = h("select", {}, f.options.map((o) => h("option", { value: o.value }, o.label))); control.value = f.value; }
      else if (f.type === "vec3") control = h("span", { class: "vec" }, (inputs[f.key] = f.value.map((v) => h("input", { type: "number", step: 1, value: v, class: "num vec" }))));
      else if (f.type === "check") control = h("input", { type: "checkbox", checked: !!f.value });
      else if (f.type === "file") control = h("input", { type: "file", accept: f.accept });
      else control = h("input", { type: f.type === "number" ? "number" : "text", step: f.step ?? "any", value: f.value ?? "", class: "num" });
      if (f.type !== "vec3") inputs[f.key] = control;
      const row = h("label", { class: "frow" }, h("span", { class: "flabel" }, f.label), control, f.hint ? h("small", { class: "hint" }, f.hint) : null);
      row.addEventListener("input", () => refresh()); row.addEventListener("change", () => refresh());
      return row;
    });
    const refresh = () => { const v = values(); fields.forEach((f, i) => { if (f.show) rows[i].hidden = !f.show(v); }); };
    const done = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    const form = h("form", { method: "dialog", onsubmit: (e) => { e.preventDefault(); done(values()); } },
      h("h2", {}, title), intro ? h("p", { class: "hint" }, intro) : null, ...rows,
      h("div", { class: "row end" }, h("button", { type: "button", onclick: () => done(null) }, "Cancel"), h("button", { class: "primary", type: "submit" }, ok)));
    dlg.append(form);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg); refresh(); dlg.showModal();
  });
}
