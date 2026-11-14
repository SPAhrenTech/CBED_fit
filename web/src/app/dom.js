export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
export const fmt = (v, d = 8) => (v == null || Number.isNaN(v) ? "" : (+v.toPrecision(d)).toString());
export const sci = (v) => (v == null ? "" : Math.abs(v) >= 1e-3 && Math.abs(v) < 1e5 ? (+v.toPrecision(3)).toString() : v.toExponential(2));
