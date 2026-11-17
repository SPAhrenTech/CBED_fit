// Doyle & Turner (1968) four-term electron scattering factors against their own Table 2 (values in Angstrom, s in 1/Angstrom).
import test from "node:test";
import assert from "node:assert/strict";
import { K } from "./helpers.mjs";
import { ffac } from "../web/src/core/physics.js";

// [Z, s (1/A), f_el (A)] read from Table 2
const TABLE2 = [
  [14, 0.0, 5.828], [14, 0.2, 2.589], [14, 0.5, 0.743],
  [31, 0.0, 7.108], [31, 0.1, 5.564], [31, 0.2, 3.629], [31, 0.5, 1.492], [31, 1.0, 0.558],
  [33, 0.0, 7.320], [33, 0.1, 6.048], [33, 0.3, 2.733], [33, 0.5, 1.533], [33, 1.0, 0.589],
  [15, 0.0, 5.488], [49, 0.0, 10.434], [49, 0.2, 5.601], [49, 0.5, 2.257],
];
test("4-term fits reproduce Doyle & Turner Table 2", () => {
  for (const [Z, s, f] of TABLE2) {
    const fit = ffac(Z, s * 10, K.eDiff) * 10;          // model units: nm and 1/nm
    assert.ok(Math.abs(fit - f) < 0.03,  // fit error of the paper (rms 0.07-0.1% of f(0), up to ~0.02 A)
       `Z=${Z} s=${s}: ${fit.toFixed(3)} vs ${f}`);
  }
});
test("indium is no longer a copy of gallium", () => {
  assert.ok(ffac(49, 3, K.eDiff) > 1.3 * ffac(31, 3, K.eDiff));
});
