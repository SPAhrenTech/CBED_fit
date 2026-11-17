// Build a cbed-web project from the intermediate files written by tools/import_v244.py.
// Usage: node tools/build_v244.mjs <scratch dir> <out.json> [thresh cap]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const A = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/src/");
const { Store } = await import(A + "app/store.js");
const F = await import(A + "core/factory.js");
const C = await import(A + "core/index.js");
const [DIR, OUT, CAP = "0.05"] = process.argv.slice(2);
const cap = Number(CAP);
const K = JSON.parse(fs.readFileSync(A + "../data/constants.json"));
const old = JSON.parse(fs.readFileSync(path.join(DIR, "old.json")));
const s = new Store(); s.K = K;
const p = { format: "cbed-web", groups: F.GROUP_NAMES, objects: [] };
const setP = (q, value, hold, del) => { q.value = value; q.hold = !!hold; q.del = del || null; };
// one shared beam, as in the old file
const beam = F.makeBeam(0, old.beam.E, `${old.beam.E} keV`); setP(beam.params[0], old.beam.E, old.beam.hold, old.beam.del); p.objects.push(beam);
const rows = [];
old.patterns.forEach((o, n) => {
  const name = o.fitTitle.replace(/^Fit_/, "").replace("Sub", "Substrate").replace("Layer#", "Layer");
  const [x, y] = o.layer.matPar;
  const mat = F.makeMaterial(n, 1, x, y, `GaAsP ${name}`);   // Ga(1-x)In(x)As(y)P(1-y); x=1 -> no In weight in the old file
  setP(mat.params[0], x, o.layer.matHold[0], o.layer.matDel[0]); setP(mat.params[1], y, o.layer.matHold[1], o.layer.matDel[1]);
  p.objects.push(mat);
  const sub = o.layer.struct.length === 1;   // cubic substrate: one lattice constant, fixed
  const layer = F.makeLayer(n, mat, K, sub ? { title: name, structType: 0, uvwz: [0, 0, 1], hklx: [1, 0, 0] }
    : { title: name, structType: 3, symmetric: 1, noShear: 1, uvwz: [0, 0, 1], hklx: [1, 0, 0] });
  if (!sub) {   // old tetragonal a (in-plane), c (growth) -> strains relative to the new unstrained a0
    const a0 = C.buildMaterial(mat, K).A0[0][0];
    const [a, c] = o.layer.struct, [da, dc] = o.layer.structDel;
    const vals = { eps11: a / a0 - 1, eps33: c / a0 - 1 }, dels = { eps11: da / a0, eps33: dc / a0 };
    layer.params.forEach((q) => { if (!(q.label in vals)) throw new Error("unexpected strain parameter " + q.label); setP(q, vals[q.label], o.layer.structHold[0], dels[q.label]); });
    rows.push(`${name}: a0 new ${a0.toFixed(6)} nm, old ${o.layer.res[0].toFixed(6)} nm`);
  }
  p.objects.push(layer);
  const m = o.model, [L, phi, xc, yc] = m.par;
  const thresh = Math.min(m.info[2], cap);
  if (thresh !== m.info[2]) rows.push(`${name}: thresh ${m.info[2]} -> ${thresh}`);
  const model = F.makeModel(n, { title: name, layerId: layer.id, beamId: beam.id, uvwz: m.uvwz.map(Math.round), hklx: m.hklx.map(Math.round), L, phi, xc, yc,
    info: { "dyn_correction": m.info[0], "gmax (nm^-1)": m.info[1], "thresh": thresh, "max_beams": m.info[3], "xb (pix)": m.info[4], "yb (pix)": m.info[5], "alpha(mrad)": m.info[6] } });
  [0, 1, 2, 3].forEach((i) => setP(model.params[i], m.par[i], m.hold[i], m.del[i]));
  p.objects.push(model);
  const expt = F.makeExperiment(n, name); expt.waves.delRMat = o.expt.delr; expt.waves.hklMat = o.expt.hkl; p.objects.push(expt);
  const fit = F.makeFit(n, { title: name, modelId: model.id, exptId: expt.id, Nz: o.fit.Nzmin, xc: o.fit.xc, yc: o.fit.yc });
  fit.info.Nzmax = o.fit.Nzmax; fit.info.include = o.fit.include; p.objects.push(fit);
  const raw = fs.readFileSync(path.join(DIR, o.img.file));
  const data = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  p.objects.push(F.makeImage(n, name, fit.id, s.registerImage({ width: o.img.w, height: o.img.h, data })));
});
s.load(p, K, { images: s.images, activeFitId: "Fit:0", canonical: false });
old.patterns.forEach((_, n) => s.refreshPairs(s.project, `Fit:${n}`));   // fill interList / delList
fs.writeFileSync(OUT, s.exportJSON());
console.log(rows.join("\n"));
for (const [n, o] of old.patterns.entries()) {
  s.setActiveFit(`Fit:${n}`);
  const free = s.freeList("active");
  const res = C.residuals(s.project, K, free.map((f) => f.value), free, 1, [s.activeFitId]);
  console.log(`${o.fitTitle}: ${o.expt.hkl.length} lines, ${s.ctx.fit.waves.interList.length} pairs, ${free.length} free, rss ${Math.sqrt(res.reduce((t, v) => t + v * v, 0)).toFixed(3)}`);
}
console.log("wrote", OUT);
