import { vary } from "../core/index.js";
self.onmessage = ({ data: { project, K, free, maxIter } }) => {
  try {
    const res = vary(project, K, free, { maxIter, onIteration: ({ iter, fom, params }) => self.postMessage({ type: "iteration", iter, fom, params }) });
    self.postMessage({ type: "done", values: res.values, errors: res.errors, fom: res.fom, status: res.status, iterations: res.iterations });
  } catch (e) { self.postMessage({ type: "error", message: e.message }); }
};
