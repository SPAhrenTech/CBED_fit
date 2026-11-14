import { Store } from "./store.js";
import { Viewer } from "./viewer.js";
import { ParamsPanel, LinesPanel, FitPanel } from "./panels.js";
import { loadImageFile, decodeRaster, withStats } from "./tiff.js";
import { h } from "./dom.js";

const $ = (id) => document.getElementById(id);
const store = new Store();
const viewer = new Viewer($("canvas"), store, {
  onCursor: (m) => { $("coords").textContent = m ? `x ${m[0].toFixed(1)}  y ${m[1].toFixed(1)}` : ""; },
  setTool: (t) => setTool(t),
});
new ParamsPanel($("tab-params"), store); new LinesPanel($("tab-lines"), store); new FitPanel($("tab-fit"), store);

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

store.subscribe((k) => { viewer.draw(); if (k === "image") viewer.imageChanged(); });

// ---- files ----
async function openImage(file) {
  try { store.setImage(await loadImageFile(file)); } catch (e) { alert(`Could not open ${file.name}: ${e.message}`); }
}
$("open-image").addEventListener("change", (e) => e.target.files[0] && openImage(e.target.files[0]));
$("open-project").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) store.load(JSON.parse(await f.text()), store.K); });
$("save").addEventListener("click", () => {
  const a = h("a", { href: URL.createObjectURL(new Blob([store.exportJSON()], { type: "application/json" })), download: "cbed-project.json" }); a.click();
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return; (f.name.endsWith(".json") ? f.text().then((t) => store.load(JSON.parse(t), store.K)) : openImage(f)); });

// ---- boot: bundled example ----
(async () => {
  try {
    const [project, K] = await Promise.all([fetch("data/project.json").then((r) => r.json()), fetch("data/constants.json").then((r) => r.json())]);
    store.load(project, K);
    const imgObj = project.objects.find((o) => o.imageFile);
    if (imgObj) store.setImage(withStats(await decodeRaster(await (await fetch("data/" + imgObj.imageFile)).blob())));
    setTool("pan");
  } catch (e) { $("coords").textContent = "Failed to load example: " + e.message; }
})();
window.cbed = { store, viewer };
