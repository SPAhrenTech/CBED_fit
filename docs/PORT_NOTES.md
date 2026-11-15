# Core port: status and findings

`web/src/core/` is a dependency-free ES-module port of the physics and fitting code.
`npm test` runs 11 parity tests against values stored in the Igor experiment (`test/parity.test.mjs`).

| Module | Ports | Verified against Igor |
|---|---|---|
| `linalg.js` | matrix ops, Jacobi eigen (symmetric / Hermitian) | indirectly |
| `physics.js` | wavelength, scattering factors, U_hkl, rotations | via the rows below |
| `crystal.js` | Material, Layer (strain, elasticity), Model matrices, `GetDelRV`, `FindDelRV`, `FindInter` | AMat/CMat/TMat/C2D exact (<1e-12); Model U/V/Up/Vp exact |
| `dynamical.js` | `make_hkl0Mat`, `get_dE1` | beam list identical; dE1 within 6e-7 (Igor stores hkl0Mat in float32) |
| `lines.js` | `MakeSimhklMat`, `IsLineInCircle`, `Find_hklV` | same 30 lines as stored Simulation |
| `fit.js` | parameter list, residuals, central-difference Jacobian, damped LM (`VaryParams`), errors | FOM 50.393826 vs stored 50.393826; parameter errors within 0.3-1.3% |

## Conventions confirmed (no longer open)
Line coordinates, y direction, rotation sign and eccentricity handling all come out right: the stored fit's 101
line intersections are reproduced to 2e-5 px and its figure of merit to 8 digits.

## Differences found in the Igor data
1. The saved Simulation (`delrMat`, `magUVect`) is slightly stale: it differs from a recomputation at the saved
   parameters by up to 0.01 px. The Fit data reproduce exactly, so the model code is not the cause.
2. Several Igor results are float32 (`EccMat`, `hkl0Mat`), which limits agreement to about 1e-7.

## Suspected bugs in the Igor code (ported as-is so results match; decide whether to fix)
1. `get_ffac` (**fixed in the JS**): Si (Z=14) returned the Ga parameters; P (15) and In (listed as 40, In is 49)
   returned 0. `ffac()` in `physics.js` now maps Z to the right table and throws for unknown elements. GaAs results
   are unchanged. **Still open:** `fIn_pars` in the Igor experiment is an exact copy of `fGa_pars`, so In needs real
   parameters before InGaAsP compositions are right.
2. `Constants/materTypes` (**fixed in the JS**): `dCoordMat` has 2 rows for GaInPAs (4 atoms) and 4 rows for Si
   (2 atoms), apparently swapped. Igor's Model keeps its own correct copy, which is why GaAs works there; a Si model
   built from the Constants tables would be wrong. `buildMaterial` now derives the atom positions from the number of
   atoms (cations at 0, anions at 1/4 1/4 1/4), so new Si/GaInPAs models need no per-model copy. GaAs parity is unchanged.
3. `RefreshLayer` rotates by the offcut angle using the pre-rotation `BMat` and `zAxis`; with offcut = 0 (the saved
   data) this is harmless, so it is untested. Layer 0 stores 0.56553 (its lattice constant) in the "offcut" slot.
4. The Model keeps its own `occVect`, which does not follow Material composition; the JS derives it from the Material.
5. `MakeSimhklMat` shifts rows past the end of `hklMat` once the list is full.

## Known limits
- Strain parameters: Igor's `coef` values are coefficients along an arbitrary eigenvector basis. The JS uses
  canonical strain parameters instead (`strainBasis`, `reparametrizeLayerStrain`, `canonicalizeProject` in
  `crystal.js` / `project.js`): independent strain components chosen in the order eps11, eps22, gamma12, eps33,
  gamma23, gamma31 become the parameters, the rest follow from the stress-free conditions. The saved layer
  (biaxial, in-plane symmetric) becomes eps11 = 0.358% and gamma12 = 1.75%. Importing keeps the strain tensor and the
  fit FOM exactly; parameter errors are cleared (re-run the fit or `parameterErrors` for strain errors).
  After changing a layer's constraints, orientation or material the app calls `reparametrizeLayerStrain`: the pivot
  strain components you set (eps11, eps22, gamma12 ...) are kept exactly and the dependent ones are re-derived from
  the stress-free conditions of the new constraints.
- Fit method 0 (line vectors, not intersections) is ported but not covered by a test; the saved Fit uses method 1.
- Igor treats every object in Beam/Model/Layer/Material as fit parameters. The JS `freeParams` does too, with an
  optional `only` filter; the web app uses it to fit only the objects reachable from the patterns in the fit scope.
- The LM loop converges slowly along a flat valley (E, L, yc and the strain coefficients are strongly correlated), as in Igor.

## Multi-pattern projects (web app)
A **pattern** is a Fit: it ties one Experiment (marked lines), one Model (camera L, centre, rotation, eccentricity, zone
axis `uvw`, x reference `hkl`) and one Image. The Model points to a Beam (energy) and a Layer (growth direction, strain
constraints, temperature), the Layer to a Material. Any of these can be shared by several patterns, or copied to make
it independent (`factory.js`: `addPattern`, `copyObject`, `relink`, `removePattern`, `pruneOrphans`).

- *Fit scope:* "this pattern" or "all included patterns" (`Fit.info.include`). `residuals`/`jacobian`/`vary` take an
  optional `fitIds` list; the free-parameter list is the union over the objects of the fits in scope, so a shared
  parameter appears once and is constrained by the lines of every pattern that uses it.
- *Laue zones:* a new pattern starts with the first allowed HOLZ layer for its zone axis (`firstLaueZone`: all-even or
  all-odd reflections only). For [110] that is N = 2; N = 1 has no allowed reflections and no lines. Editable per pattern.
- *Images* are kept outside the project (`Store.images`, referenced from `Image.vars.ref`), so undo snapshots stay
  small; a saved project embeds them (`imageio.js`: u8/u16/f32, base64).
- *Undo/redo* snapshots the project before every edit (edits of one field within 1.5 s share a step; a whole fit is
  one step). Selection, view and window/level are not part of history.
- Per-pattern FOMs shown after a fit are marked stale as soon as any parameter changes.
- Not covered yet: weighting patterns against each other (all residuals use sigma = 1 px), per-pattern sigma, and
  fitting a pattern's image-independent quantities without any image (the fit needs only marked lines).
