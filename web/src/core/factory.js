// Creating, copying, linking and deleting project objects (pure functions on a project draft).
// A "pattern" is a Fit: it ties one Experiment (marked lines) to one Model (camera + orientation); the Model points to a
// Beam (energy) and a Layer (strain, growth direction), the Layer to a Material. Objects can be shared between patterns,
// and every parameter of a shared object is fitted once, jointly, over all patterns that use it.
import { reparametrizeLayerStrain } from "./project.js";

export const GROUP_NAMES = ["Beam", "Experiment", "Model", "Simulation", "Fit", "Image", "Layer", "Table", "Graph", "Dynamical", "Hough", "Plot", "Analysis", "Material"];
export const STRAIN_TYPES = ["Unstrained", "Uniaxial stress", "Biaxial (epitaxial layer)", "Triaxial (free strain)"];

export const find = (p, id) => p.objects.find((o) => o.id === id);
export const linkOf = (p, o, field) => { const l = o?.links.find((x) => x.field === field); return l ? find(p, l.to) : undefined; };
export const dependents = (p, id) => p.objects.filter((o) => o.links.some((l) => l.to === id));
export const nextKey = (p, type) => 1 + Math.max(-1, ...p.objects.filter((o) => o.type === type).map((o) => o.key));

const param = (label, value, { hold = false, tol, step }) => ({ label, value, hold, tol, step, increment: 10 ** step, del: null });
const make = (type, key, title, { vars = {}, info = {}, params = [], waves = {}, links = [] } = {}) =>
  ({ id: `${type}:${key}`, type, key, title, vars: { status: 0, ...vars }, params, info, waves, links, _igorDependents: [] });
const link = (field, to) => ({ field, to });

/** A small integer reflection perpendicular to the direction uvw (default x-axis reference for an orientation). */
export function perpHkl([u, v, w]) {
  const c = [];
  for (let h = 3; h >= -3; h--) for (let k = 3; k >= -3; k--) for (let l = 3; l >= -3; l--)
    if ((h || k || l) && h * u + k * v + l * w === 0) c.push([h, k, l]);
  c.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  return c[0] ?? [1, 0, 0];
}

/**
 * Lowest positive Laue-zone index N = hkl.uvw that has an allowed zincblende/diamond reflection (h, k, l all even or all odd).
 * This is the first HOLZ layer that can show lines (for [110], N = 1 is forbidden and the first layer is N = 2).
 */
export function firstLaueZone([u, v, w]) {
  let best = Infinity;
  for (let h = -6; h <= 6; h++) for (let k = -6; k <= 6; k++) for (let l = -6; l <= 6; l++) {
    const par = [h, k, l].map((x) => Math.abs(x) % 2);
    if (par[0] !== par[1] || par[1] !== par[2]) continue;
    const N = h * u + k * v + l * w;
    if (N > 0 && N < best) best = N;
  }
  return Number.isFinite(best) ? best : 1;
}

export const makeBeam = (key, E, title = `${E} keV`) =>
  make("Beam", key, title, { params: [param("E (KeV)", E, { hold: true, tol: 0.01, step: -1 })] });

export function makeMaterial(key, materType, x = 1, y = 1, title) {
  const params = materType === 1 ? [param("xGa", x, { hold: true, tol: 1e-6, step: -1 }), param("yAs", y, { hold: true, tol: 1e-6, step: -1 })] : [];
  return make("Material", key, title ?? (materType === 1 ? `Ga${x}In${+(1 - x).toFixed(3)}P${+(1 - y).toFixed(3)}As${y}` : "Si"), { vars: { materType }, params });
}

/** Layer with the given constraints; strain parameters are the canonical strain components (all held). */
export function makeLayer(key, mat, K, o = {}) {
  const structType = o.structType ?? 0;
  const uvwz = o.uvwz ?? [0, 0, 1], hklx = o.hklx ?? perpHkl(uvwz);
  const layer = make("Layer", key, o.title ?? "Layer", {
    vars: { structType },
    info: { "offcut (deg)": o.offcut ?? 0, "in-plane symmetry": o.symmetric ?? (structType === 2 ? 1 : 0), "no shear": o.noShear ?? 0, "T(K)": o.T ?? 300 },
    waves: { uvwzVect: uvwz, hklxVect: hklx, hklmVect: o.hklm ?? hklx },
    links: [link("materKey", mat.id)],
  });
  return applyStrainConstraints(layer, mat, K);
}

/** Re-derive a layer's strain parameters for its current constraints, keeping the physical strain. */
export function applyStrainConstraints(layer, mat, K) {
  if (layer.vars.structType === 0) return { ...layer, params: [], waves: { ...layer.waves, epsVectL: undefined, epsVect: undefined } };
  const seeded = layer.params.length && layer.waves.epsVectL ? layer
    : { ...layer, params: [param("coef", 0, { hold: true, tol: 1e-9, step: -4 })], waves: { ...layer.waves, epsVectL: [[0], [0], [0], [0], [0], [0]] } };
  const out = reparametrizeLayerStrain(seeded, mat, K);
  delete out._strainResidual;
  return out;
}

export const makeModel = (key, o) => make("Model", key, o.title ?? "Model", {
  params: [
    param("L (pix)", o.L ?? 50000, { tol: 1e-5, step: 2 }),
    param("phi (deg)", o.phi ?? 0, { hold: true, tol: 1e-6, step: -1 }),
    param("xc (pix)", o.xc ?? 400, { tol: 1e-4, step: 0 }),
    param("yc (pix)", o.yc ?? 400, { tol: 1e-4, step: 0 }),
    param("eccX", o.eccX ?? 0, { hold: true, tol: 1e-6, step: -3 }),
    param("eccY", o.eccY ?? 0, { hold: true, tol: 1e-6, step: -3 }),
  ],
  info: { "dyn_correction": 1, "gmax (nm^-1)": 30, "thresh": 0.01, "max_beams": 100, "xb (pix)": 0, "yb (pix)": 0, "alpha(mrad)": 6.1, ...(o.info ?? {}) },
  waves: { uvwzVect: o.uvwz ?? [1, 1, 0], hklxVect: o.hklx ?? perpHkl(o.uvwz ?? [1, 1, 0]) },
  links: [link("layerKey", o.layerId), link("beamKey", o.beamId)],
});

export const makeExperiment = (key, title) => make("Experiment", key, title, {
  info: { excess: 0 },
  waves: { delRMat: [], hklMat: [], interRMat: [], interRhklList: [], pointRMat: [], pointRhklList: [] },
});

export const makeFit = (key, o) => make("Fit", key, o.title, {
  info: { Nzmin: o.Nz ?? 1, Nzmax: o.Nz ?? 1, xc: o.xc ?? 400, yc: o.yc ?? 400, include: 1, method: 1 },
  waves: { delList: [], interList: [] },
  links: [link("modelKey", o.modelId), link("exptKey", o.exptId)],
});

export const makeImage = (key, title, fitId, ref) => make("Image", key, title, { vars: { ref }, links: [link("fitKey", fitId)] });

/** Default camera length (pix) such that the pattern disk fills ~40% of the shorter image side. */
export const defaultL = (width, height, alphaMrad = 6.1) => (0.4 * Math.min(width, height)) / Math.tan(alphaMrad / 1000);

/**
 * A new project with one pattern.
 * o: { materType, x, y, E, T, structType, growth: [uvw], zone: [uvw], hklx, width, height, title, L, alpha, imageRef }
 */
export function newProject(K, o = {}) {
  const width = o.width ?? 800, height = o.height ?? 800;
  const p = { format: "cbed-web", groups: GROUP_NAMES, objects: [] };
  const mat = makeMaterial(0, o.materType ?? 0, o.x ?? 1, o.y ?? 1);
  const beam = makeBeam(0, o.E ?? 200);
  const layer = makeLayer(0, mat, K, { structType: o.structType ?? 0, uvwz: o.growth ?? [0, 0, 1], T: o.T ?? 300, title: "Layer" });
  p.objects.push(mat, beam, layer);
  const fitId = addPatternObjects(p, {
    title: o.title ?? "Pattern 1", layerId: layer.id, beamId: beam.id, zone: o.zone ?? [1, 1, 0], hklx: o.hklx, width, height, L: o.L, alpha: o.alpha, imageRef: o.imageRef,
  });
  return { project: p, fitId };
}

/** Append Experiment + Model + Fit (+ Image) for a pattern using existing Beam/Layer (or an existing Model). Returns the Fit id. */
function addPatternObjects(p, o) {
  const alpha = o.alpha ?? 6.1;
  const key = (t) => nextKey(p, t);
  const expt = makeExperiment(key("Experiment"), o.title);
  p.objects.push(expt);
  let model = o.modelId ? find(p, o.modelId) : null;
  if (!model) {
    model = makeModel(key("Model"), {
      title: o.title, layerId: o.layerId, beamId: o.beamId, uvwz: o.zone, hklx: o.hklx, L: o.L ?? defaultL(o.width, o.height, alpha),
      xc: o.xc ?? o.width / 2, yc: o.yc ?? o.height / 2, phi: o.phi, info: { "alpha(mrad)": alpha, ...(o.modelInfo ?? {}) },
    });
    p.objects.push(model);
  }
  const fit = makeFit(key("Fit"), { title: o.title, modelId: model.id, exptId: expt.id, Nz: firstLaueZone(model.waves.uvwzVect), xc: model.params[2].value, yc: model.params[3].value });
  p.objects.push(fit);
  p.objects.push(makeImage(key("Image"), o.title, fit.id, o.imageRef ?? null));
  return fit.id;
}

/**
 * Add a pattern next to `baseFitId`.
 * o: { title, share: { beam, layer, model }, zone, hklx, width, height, imageRef }
 * Beam / Layer that are not shared are copied, so they can be fitted independently.
 */
export function addPattern(p, K, baseFitId, o = {}) {
  const base = find(p, baseFitId), bm = linkOf(p, base, "modelKey");
  const title = o.title ?? `Pattern ${p.objects.filter((x) => x.type === "Fit").length + 1}`;
  const share = { beam: true, layer: true, model: false, ...(o.share ?? {}) };
  let beamId = linkOf(p, bm, "beamKey").id, layerId = linkOf(p, bm, "layerKey").id;
  if (!share.beam) beamId = copyObject(p, beamId, `${title} beam`).id;
  if (!share.layer) layerId = copyObject(p, layerId, `${title} layer`).id;
  const baseInfo = bm.info;
  return addPatternObjects(p, {
    title, beamId, layerId, zone: o.zone ?? bm.waves.uvwzVect, hklx: o.hklx, width: o.width ?? 800, height: o.height ?? 800, imageRef: o.imageRef,
    modelId: share.model ? bm.id : null, alpha: baseInfo["alpha(mrad)"], modelInfo: { ...baseInfo },
  });
}

/** Copy of an object (new key, parameter errors cleared, links kept). Returns the copy. */
export function copyObject(p, id, title) {
  const src = find(p, id), c = structuredClone(src);
  c.key = nextKey(p, src.type); c.id = `${src.type}:${c.key}`; c.title = title ?? `${src.title} (copy)`;
  c.params.forEach((q) => { q.del = null; });
  p.objects.push(c);
  return c;
}

/** Point `from`'s link `field` to `toId`, then drop objects nothing refers to any more. */
export function relink(p, fromId, field, toId) {
  find(p, fromId).links.find((l) => l.field === field).to = toId;
  pruneOrphans(p);
}

/** Remove a pattern: its Fit, Experiment and Image, and any Model/Beam/Layer/Material no other pattern uses. */
export function removePattern(p, fitId) {
  const fit = find(p, fitId);
  const dead = new Set([fitId, linkOf(p, fit, "exptKey")?.id, ...dependents(p, fitId).filter((o) => o.type === "Image").map((o) => o.id)]);
  p.objects = p.objects.filter((o) => !dead.has(o.id));
  pruneOrphans(p);
}

/** Delete Models/Beams/Layers/Materials that no remaining object links to. */
export function pruneOrphans(p) {
  for (let changed = true; changed;) {
    changed = false;
    for (const type of ["Model", "Beam", "Layer", "Material"]) {
      const used = new Set(p.objects.flatMap((o) => o.links.map((l) => l.to)));
      const keep = p.objects.filter((o) => o.type !== type || used.has(o.id));
      if (keep.length !== p.objects.length) { p.objects = keep; changed = true; }
    }
  }
}

/** Replace a Layer's constraints/orientation (patch: {structType, info:{...}, waves:{...}}) keeping the strain tensor. */
export function editLayer(p, K, layerId, patch) {
  const i = p.objects.findIndex((o) => o.id === layerId), l = p.objects[i];
  const next = { ...l, vars: { ...l.vars, ...(patch.vars ?? {}), ...(patch.structType != null ? { structType: patch.structType } : {}) }, info: { ...l.info, ...(patch.info ?? {}) }, waves: { ...l.waves, ...(patch.waves ?? {}) } };
  if (patch.structType != null && patch.structType !== l.vars.structType && patch.info?.["in-plane symmetry"] == null) next.info["in-plane symmetry"] = patch.structType === 2 ? 1 : 0;
  p.objects[i] = applyStrainConstraints(next, linkOf(p, next, "materKey"), K);
  return p.objects[i];
}

/** Change a Material's type (Si / GaInPAs) and re-derive the strain of every layer made of it. */
export function editMaterialType(p, K, matId, materType) {
  const i = p.objects.findIndex((o) => o.id === matId), m = p.objects[i];
  if (m.vars.materType === materType) return m;
  p.objects[i] = makeMaterial(m.key, materType, 1, 1);
  for (const l of p.objects.filter((o) => o.type === "Layer" && o.links.some((x) => x.to === matId))) editLayer(p, K, l.id, {});
  return p.objects[i];
}

/** Change a Model's zone axis (and x reference); the Laue-zone range of the patterns using it resets to the first allowed layer. */
export function setZone(p, modelId, uvw, hklx) {
  const m = find(p, modelId);
  m.waves.uvwzVect = uvw; m.waves.hklxVect = hklx ?? perpHkl(uvw);
  const Nz = firstLaueZone(uvw);
  for (const f of dependents(p, modelId).filter((o) => o.type === "Fit")) { f.info.Nzmin = Nz; f.info.Nzmax = Nz; }
}
