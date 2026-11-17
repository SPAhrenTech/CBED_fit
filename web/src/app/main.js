import { Store } from "./store.js";
import { Viewer } from "./viewer.js";
import { ParamsPanel, LinesPanel, FitPanel, PatternStrip } from "./panels.js";
import { loadImageFile, decodeRaster, withStats } from "./tiff.js";
import { formDialog } from "./dialog.js";
import { STRAIN_TYPES } from "../core/factory.js";
import { h } from "./dom.js";

const $ = (id) => document.getElementById(id);
const store = new Store();
const viewer = new Viewer($("canvas"), store, {
  onCursor: (m) => { $("coords").textContent = m ? `x ${m[0].toFixed(1)}  y ${m[1].toFixed(1)}` : ""; },
  setTool: (t) => setTool(t),
});
new ParamsPanel($("tab-params"), store); new LinesPanel($("tab-lines"), store); new FitPanel($("tab-fit"), store);
new PatternStrip($("patterns"), store, { onAdd: () => addPattern() });

function setTool(t) { viewer.tool = t; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); $("canvas").style.cursor = t === "mark" ? "crosshair" : "grab"; }
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
document.querySelectorAll("[data-show]").forEach((c) => c.addEventListener("change", () => { viewer.show[c.dataset.show] = c.checked; viewer.draw(); }));
$("snap").addEventListener("change", (e) => (viewer.snap = e.target.checked));
$("dark").addEventListener("change", (e) => (viewer.dark = e.target.checked));
const win = () => viewer.setWindow(+$("lo").value, +$("hi").value);
$("lo").addEventListener("input", win); $("hi").addEventListener("input", win);
$("fitview").addEventListener("click", () => { viewer.fitToWindow(); viewer.draw(); });

document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + b.dataset.tab));
}));

store.subscribe(() => {
  viewer.setSource(`${store.activeFitId}|${store.imageObj()?.vars.ref ?? ""}`) || viewer.draw();
  $("undo").disabled = !store.canUndo; $("redo").disabled = !store.canRedo;
  document.title = `CBED Fit — ${store.ctx?.fit.title ?? ""}`;
});

// ---- files ----
const IMAGE_ACCEPT = ".tif,.tiff,.png,.jpg,.jpeg";
async function readImage(file) { try { return await loadImageFile(file); } catch (e) { alert(`Could not open ${file.name}: ${e.message}`); return null; } }
async function openImage(file) { const img = await readImage(file); if (img) store.setImage(img, file.name); }
const discardOk = () => !store.canUndo || confirm("Replace the current project? Changes since it was opened or last saved are lost.");
async function openProject(file) { if (!discardOk()) return; try { store.loadJSON(await file.text()); } catch (e) { alert(`Could not open ${file.name}: ${e.message}`); } }
$("open-image").addEventListener("change", (e) => { if (e.target.files[0]) openImage(e.target.files[0]); e.target.value = ""; });
$("open-project").addEventListener("change", (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ""; });
$("save").addEventListener("click", () => {
  const a = h("a", { href: URL.createObjectURL(new Blob([store.exportJSON()], { type: "application/json" })), download: "cbed-project.json" }); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) (f.name.endsWith(".json") ? openProject(f) : openImage(f)); });

// ---- undo / redo / navigation ----
$("undo").addEventListener("click", () => store.undo());
$("redo").addEventListener("click", () => store.redo());
addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, textarea, select")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); store.redo(); }
  else if (e.key === "]" || e.key === "PageDown") { e.preventDefault(); store.stepPattern(1); }
  else if (e.key === "[" || e.key === "PageUp") { e.preventDefault(); store.stepPattern(-1); }
});

// ---- new project / add pattern ----
const vecOk = (v) => v.every(Number.isInteger) && v.some((x) => x !== 0);
async function newProject() {
  if (!discardOk()) return;
  const v = await formDialog("New project", [
    { key: "image", label: "Image (optional)", type: "file", accept: IMAGE_ACCEPT, hint: "Grayscale TIFF/PNG; sets the pattern centre and a first guess of the camera length." },
    { key: "title", label: "Pattern name", type: "text", value: "Pattern 1" },
    { key: "materType", label: "Material", type: "select", value: 0, options: [{ value: 0, label: "Si" }, { value: 1, label: "GaInPAs (zincblende)" }] },
    { key: "x", label: "Ga fraction x", type: "number", value: 1, show: (v) => v.materType === 1 },
    { key: "y", label: "As fraction y", type: "number", value: 1, show: (v) => v.materType === 1 },
    { key: "E", label: "Beam energy (keV)", type: "number", value: 200 },
    { key: "T", label: "Temperature (K)", type: "number", value: 300 },
    { key: "growth", label: "Growth direction [uvw]", type: "vec3", value: [0, 0, 1] },
    { key: "structType", label: "Strain", type: "select", value: 0, options: STRAIN_TYPES.map((t, i) => ({ value: i, label: t })) },
    { key: "zone", label: "Pattern zone axis [uvw]", type: "vec3", value: [1, 1, 0], hint: "Crystal direction along the beam. Further patterns can be added afterwards." },
    { key: "alpha", label: "Convergence α (mrad)", type: "number", value: 6.1 },
  ], { ok: "Create", intro: "Starts a project with one pattern. Beam energy and camera length are only first guesses: they are fitted later." });
  if (!v) return;
  if (!vecOk(v.zone) || !vecOk(v.growth)) { alert("Zone axis and growth direction must be non-zero integer vectors."); return; }
  const image = v.image ? await readImage(v.image) : null;
  store.newProject({ ...v, title: v.title || "Pattern 1" }, image);
}
async function addPattern() {
  const c = store.ctx; if (!c) return;
  const v = await formDialog("Add pattern", [
    { key: "image", label: "Image", type: "file", accept: IMAGE_ACCEPT },
    { key: "title", label: "Name", type: "text", value: `Pattern ${store.fitIds.length + 1}` },
    { key: "zone", label: "Zone axis [uvw]", type: "vec3", value: c.model.waves.uvwzVect.slice(), hint: "Use another zone axis for a different orientation." },
    { key: "beam", label: "Same beam energy", type: "check", value: true, hint: "Share the energy parameter with the current pattern (otherwise it gets its own)." },
    { key: "layer", label: "Same layer / strain", type: "check", value: true, hint: "Share strain and growth direction with the current pattern." },
  ], { ok: "Add", intro: "The new pattern gets its own camera geometry (L, centre, rotation) and its own marked lines. Shared parameters are fitted jointly." });
  if (!v) return;
  if (!vecOk(v.zone)) { alert("The zone axis must be a non-zero integer vector."); return; }
  const image = v.image ? await readImage(v.image) : null;
  store.addPattern({ title: v.title, zone: v.zone, share: { beam: v.beam, layer: v.layer } }, image);
}
$("new").addEventListener("click", newProject);

// ---- boot: default project (a self-contained cbed-web file; change the name to use another) ----
const DEFAULT_PROJECT = "data/GaAs_300K_GIF.json";
(async () => {
  try {
    store.K = await fetch("data/constants.json").then((r) => r.json());
    store.loadJSON(await fetch(DEFAULT_PROJECT).then((r) => { if (!r.ok) throw new Error(`${DEFAULT_PROJECT}: ${r.status}`); return r.text(); }));
    store.clearHistory(); store.emit("all");
    setTool("pan");
  } catch (e) { $("coords").textContent = "Failed to load default project: " + e.message; }
})();
window.cbed = { store, viewer };
