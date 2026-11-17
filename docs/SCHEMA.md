# CBED_fit object model (extracted from the Igor experiment)

Generated data: `web/data/project.json` (objects, links, params), `web/data/schema.json`
(per-type labels, defaults, link fields), `web/data/images/` (grayscale TIFF data as PNG).
Regenerate with `python3 tools/extract_project.py "CBED_fit Folder" web/data`.

## Object types (14 "groups")

| # | Type | Role | Key fields |
|---|------|------|-----------|
| 0 | Beam | Electron energy | param: E (keV) |
| 1 | Experiment | Marked HOLZ lines on one pattern | `hklMat` (line indices), `delRMat` (line position, pix), `interRMat`/`interRhklList` (line intersections) |
| 2 | Model | Camera + geometry | params: L, phi, xc, yc, eccX, eccY; info: dyn_correction, gmax, thresh, max_beams, xb, yb, alpha |
| 3 | Simulation | Predicted lines for a Model | `hklMat`, `delrMat` (output); info: Nzmin/Nzmax, bounds, gmax |
| 4 | Fit | Pairs Experiment with Model; holds residuals | `exptDelRMat`, `fitDelRMat`, `interList`; info: Nzmin/Nzmax, xc, yc, include, method |
| 5 | Image | Grayscale TIFF (uint8 here) | `image` wave |
| 6 | Layer | Strained crystal layer | `uvwzVect` zone axis, `hklxVect`, `hklmVect`, info: offcut, in-plane symmetry, no shear, T(K); params: lattice `a` or strain components (`structType` 0 = fixed lattice, 2 = free strain) |
| 7 | Table | Igor table window | UI only, drop |
| 8 | Graph | Image/line viewer window | bounds, style `valList` |
| 9 | Dynamical | Bloch-wave simulation setup | params: |g|Max, |s|Max, ..., `diskMat`, `hklMat`; outputs are caches |
| 10 | Hough | Hough-transform tool settings | UI state |
| 11 | Plot | One layer drawn in a Graph | `sourceType`/`sourceKey`, `graphKey`, style |
| 12 | Analysis | LM fit controls | `parVal[0]` = iterations; tolerances by param class |
| 13 | Material | Composition-dependent bulk crystal | `materType` (0 Si, 1 GaInPAs), params xGa, yAs |

## Model geometry fields

All positions are image pixels in model coordinates: x is the column, y is the height minus the row (y up).

| Field | Kind | Meaning |
|-------|------|---------|
| `xc`, `yc` | fit parameters | Point where the zone-axis direction meets the pattern. Origin of the line geometry. |
| `xb (pix)`, `yb (pix)` | info (not fitted) | Offset of the centre of the CBED disk from (`xc`, `yc`). The disk centre is `rBeam = (xc + xb, yc + yb)`. Default 0, 0. |
| `alpha(mrad)` | info | Convergence half-angle. The disk is the circle of radius `L * tan(alpha)` about `rBeam`. |
| `L` | fit parameter | Camera length in pixels. |
| `phi` | fit parameter | In-plane rotation of the pattern (degrees). |
| `eccX`, `eccY` | fit parameters | Eccentricity (anisotropic scaling) of the pattern, applied about `rBeam`. |

How `xb`, `yb` are used (`web/src/core/crystal.js`, `lines.js`):

- A simulated line is listed only if it crosses the disk (`isLineInCircle`, centre `rBeam`).
- The eccentricity is undone about `rBeam` when identifying a marked line (`findHklFromLine`) and when selecting line pairs whose intersection lies inside the disk (`interPairs`).
- They are plain info fields, so the fit never changes them. If the disk is visibly off-centre from the zone axis, set them by hand (Parameters tab, Camera & orientation).

## Relationships

Each object has integer **keys** (`<prefix><6-digit key>`) and optional pointer variables:

```
Model.layerKey    -> Layer         Layer.materKey -> Material
Model.beamKey     -> Beam          Fit.modelKey   -> Model
Simulation.modelKey -> Model       Fit.exptKey    -> Experiment
Dynamical.modelKey  -> Model       Image.fitKey   -> Fit      (so the image shows a fit)
Plot.sourceType/sourceKey -> Experiment | Simulation | Fit | Image | Dynamical
Plot.graphKey -> Graph             Table.sourceType/sourceKey -> any
```

Igor also stores the reverse edges in `refGroupKey`/`refObjectKey` (dependents to refresh on change).
These are **derivable** from the pointers above, so the web version stores only the forward links.
The extractor cross-checks them: it found 2 dangling pointers (`Layer:0 -> Material:1`,
`Plot:4 -> Graph:1`) and 3 stale dependents (`Experiment:0 -> Fit:0/Fit:2`, `Dynamical:0 -> Plot:17`),
all references to deleted objects.

## Fit parameter vector

Every object's `params` entry has `value`, `hold` (true = fixed), `tol` (finite-difference step),
`step` (log10 of the spinner-arrow increment; `increment` = 10^step is added in the JSON), `del` (fitted standard error).
Free parameters = all `hold == false` across all objects, in group order. The current fit
has 9: Beam E, the six Model params, and two Layer strain coefficients.
`Analysis` stores that list as `paramType`/`paramKey`/`paramNum` (derived at fit time by
`MakeParamsLists`, so not needed in the web format).

## Not carried over

Table/Hough/Graph window state, Plot marker caches, Dynamical intensity maps, per-object
`status` (refresh bookkeeping, replaced by reactive recompute).

## Open questions (need your input)

1. Confirm pixel coordinate convention (origin and y direction) used by `delRMat`/`rVect`.
2. ~~`parStep`~~ resolved: log10 of the up/down arrow increment.
3. `Model.keyList` / `Layer.keyList` (5 ints) look like indexes into `materProps`: used?
4. Is a Model always a single Layer (`layerKey`) or can multi-layer stacks occur (Model has `uvwzVect`; Layer 0 looks like the substrate)?

## Web project format (cbed-web)
The web app saves the same object list (`objects`, each with `id`, `type`, `key`, `title`, `vars`, `params`, `info`,
`waves`, `links`) plus `activeFitId` and `images: {ref: {width, height, type, b64}}`. New objects created in the app
have these shapes (`web/src/core/factory.js`): `Image.vars.ref` names the entry in `images`; `Fit.info` holds
`Nzmin/Nzmax/include/method`; `Model.waves` only needs `uvwzVect` and `hklxVect` (Igor's matrix caches are recomputed).
Projects saved from the Igor export (no `images`) open with an empty image slot; use "Set image".
