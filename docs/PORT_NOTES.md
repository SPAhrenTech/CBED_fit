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
2. `Constants/materTypes`: `dCoordMat` has 2 rows for GaInPAs (4 atoms) and 4 rows for Si (2 atoms), apparently
   swapped. Igor's Model keeps its own correct copy; the JS also uses the Model copy. Reading the Constants copy
   gives dE1 = 5.29 instead of 0.78.
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
  After changing a layer's constraints or orientation call `reparametrizeLayerStrain` so the strain is preserved.
- Fit method 0 (line vectors, not intersections) is ported but not covered by a test; the saved Fit uses method 1.
- Igor treats every object in Beam/Model/Layer/Material as fit parameters. The JS does too (`freeParams`), with an
  optional `only` filter; the web app should restrict it to objects reachable from included fits.
- The LM loop converges slowly along a flat valley (E, L, yc and the strain coefficients are strongly correlated), as in Igor.
