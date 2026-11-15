import { vary, residuals } from "../core/index.js";
self.onmessage = ({ data: { project, K, free, maxIter, fitIds } }) => {
  try {
    const res = vary(project, K, free, { maxIter, fitIds, onIteration: ({ iter, fom, params }) => self.postMessage({ type: "iteration", iter, fom, params }) });
    // root-sum-square residual of each pattern at the solution (sigma = 1 px)
    const perFit = {};
    for (const id of fitIds) perFit[id] = Math.sqrt(residuals(project, K, res.values, free, 1, [id]).reduce((s, x) => s + x * x, 0));
    self.postMessage({ type: "done", values: res.values, errors: res.errors, fom: res.fom, status: res.status, iterations: res.iterations, perFit });
  } catch (e) { self.postMessage({ type: "error", message: e.message }); }
};
