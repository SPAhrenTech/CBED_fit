#!/usr/bin/env python3
"""Convert an unpacked v244-era Igor CBED_fit experiment ("... Folder", plural folders
Fits/Models/Layers/Experiments/Images/Beams with per-object waves) into a cbed-web project.

Usage: python3 tools/import_v244.py "<CBED_fit ... Folder>" out.json [--thresh-cap 0.05]

Step 1 (here) reads the .ibw waves into a scratch directory; step 2 (tools/build_v244.mjs)
builds the project with the web app's own factory code.  See docs/PORT_NOTES.md.
"""
import json, os, subprocess, sys, tempfile
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ibw import read_ibw

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if len(args) != 2:
    sys.exit(__doc__)
SRC, OUT = args
cap = "0.05"
if "--thresh-cap" in sys.argv:
    cap = sys.argv[sys.argv.index("--thresh-cap") + 1]
    args = [a for a in args if a != cap]
    SRC, OUT = args[:2]

def get(p):
    w = read_ibw(os.path.join(SRC, p + ".ibw"))
    return w["val"] if w["type"] == 0 else np.asarray(w["val"])

L = lambda a: [float(x) for x in np.asarray(a).ravel()]
keys = lambda p: [int(x) for x in np.asarray(get(p)).ravel()]
fit_keys, img_keys = keys("Fits/fitKey"), keys("Images/imageKey")
fit_t, expt_t = get("Fits/fitTitle"), get("Experiments/exptTitle")
lay_t, img_t = get("Layers/layerTitle"), get("Images/imageTitle")
lay_k, expt_k = keys("Layers/layerKey"), keys("Experiments/exptKey")
img_of_fit = {int(get(f"Images/i{k:06d}/keyList")[0]): (k, i) for i, k in enumerate(img_keys)}

tmp = tempfile.mkdtemp(prefix="v244_")
beam = None
pats = []
for n, fk in enumerate(fit_keys):
    fp = f"Fits/f{fk:06d}/"
    ek, mk = (int(x) for x in get(fp + "keyList")[:2])
    mp = f"Models/m{mk:06d}/"
    lk, bk = (int(x) for x in get(mp + "keyList")[:2])
    ly = f"Layers/l{lk:06d}/"
    if beam is None:
        bp = f"Beams/b{bk:06d}/"
        beam = {"E": float(get(bp + "par")[0]), "hold": bool(get(bp + "parHold")[0]),
                "del": float(get(bp + "parDel")[0]), "alpha": float(get(bp + "infoVal")[2]),
                "title": str(get("Beams/beamTitle")[0])}
    ik, _ = img_of_fit[fk]
    # image waves are stored dim0-fastest; transpose so rows are the second index
    arr = np.ascontiguousarray(get(f"Images/i{ik:06d}/i{ik:06d}")[:, :, 0].T.astype(np.float32))
    arr.tofile(os.path.join(tmp, f"img{n}.f32"))
    info = get(fp + "infoVal")
    pats.append({
        "fitTitle": fit_t[n], "exptTitle": expt_t[expt_k.index(ek)], "layerTitle": lay_t[lay_k.index(lk)],
        "imageTitle": img_t[img_keys.index(ik)],
        "fit": {"Nzmin": float(info[0]), "Nzmax": float(info[1]), "xc": float(info[2]), "yc": float(info[3]),
                "include": float(info[4])},
        "expt": {"hkl": get(f"Experiments/e{ek:06d}/hklMat").tolist(), "delr": get(f"Experiments/e{ek:06d}/delrMat").tolist()},
        "model": {"par": L(get(mp + "par")), "hold": L(get(mp + "parHold")), "del": L(get(mp + "parDel")),
                  "info": L(get(mp + "infoVal")), "uvwz": L(get(mp + "uvwzVect")), "hklx": L(get(mp + "hklxVect"))},
        "layer": {"matPar": L(get(ly + "matPar")), "matHold": L(get(ly + "matParHold")), "matDel": L(get(ly + "matParDel")),
                  "struct": L(get(ly + "structPar")), "structHold": L(get(ly + "structParHold")),
                  "structDel": L(get(ly + "structParDel")), "res": L(get(ly + "resPar")), "type": L(get(ly + "typeList"))},
        "img": {"w": int(arr.shape[1]), "h": int(arr.shape[0]), "file": f"img{n}.f32"},
    })
json.dump({"beam": beam, "patterns": pats}, open(os.path.join(tmp, "old.json"), "w"))
here = os.path.dirname(os.path.abspath(__file__))
sys.exit(subprocess.call(["node", os.path.join(here, "build_v244.mjs"), tmp, OUT, cap]))
