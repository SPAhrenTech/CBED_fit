// Project-level helpers: moving the layer strain parameters from Igor's arbitrary eigenvector basis to strain components.
import { matmul, matvec, pinvLeft } from "./linalg.js";
import { buildMaterial, buildLayer, strainBasis } from "./crystal.js";

const linkOf = (project, o, field) => { const l = o.links.find((x) => x.field === field); return l && project.objects.find((x) => x.id === l.to); };
const strainLayer = (l) => l.params.length > 0 && l.params.every((p) => p.label === "coef" || /^(eps|gamma)\d+$/.test(p.label));

/**
 * Re-express a layer's strain parameters in the canonical strain basis for its CURRENT constraints
 * (structType, in-plane symmetry, no shear), keeping the physical strain tensor unchanged. Use it to import Igor
 * layers, and after any change of constraints or orientation so the parameter values keep their meaning.
 * Returns a new layer object; parameter errors are cleared because they refer to the old parameters.
 */
export function reparametrizeLayerStrain(layer, mat, K) {
  const M = buildMaterial(mat, K);
  const old = buildLayer(layer, M, { basis: layer.waves.epsVectL });        // current strain tensor and C2D
  const B = strainBasis(old.C2D, layer.vars.structType, layer.info["in-plane symmetry"], layer.info["no shear"]);
  const n = B[0].length;
  const pinv = n ? pinvLeft(B) : null;
  const coef = n ? matvec(pinv, old.epsVect) : [];
  const resid = n ? Math.hypot(...matvec(B, coef).map((v, i) => v - old.epsVect[i])) : Math.hypot(...old.epsVect);
  const tmpl = layer.params[0] ?? { hold: false, tol: 1e-9, step: -4, del: null };
  return {
    ...layer,
    waves: { ...layer.waves, epsVectL: B.map((r) => r.slice()), epsVect: matvec(B, coef) },
    params: B.labels.map((label, i) => ({ label, value: coef[i], hold: layer.params[i]?.hold ?? false, tol: tmpl.tol, step: -4, increment: 1e-4, del: null })),
    _strainResidual: resid,   // > 0 only if the old strain was not representable under the new constraints
  };
}

/** Apply reparametrizeLayerStrain to every strained layer of a project (returns a new project). */
export function canonicalizeProject(project, K) {
  const objects = project.objects.map((o) => {
    if (o.type !== "Layer" || !strainLayer(o) || o.vars.structType === 0) return o;
    const mat = linkOf(project, o, "materKey");
    return mat ? reparametrizeLayerStrain(o, mat, K) : o;
  });
  return { ...project, objects };
}
