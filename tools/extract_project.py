#!/usr/bin/env python3
"""Export the unpacked Igor experiment ("CBED_fit Folder") to normalized JSON.

Usage: python3 tools/extract_project.py ["CBED_fit Folder"] [out_dir]
Writes <out>/project.json, <out>/schema.json and <out>/images/<key>.png
"""
import json, os, sys
import numpy as np
from ibw import read_ibw
from vars import read_vars

SRC = sys.argv[1] if len(sys.argv) > 1 else "CBED_fit Folder"
OUT = sys.argv[2] if len(sys.argv) > 2 else "web/data"

# Group index -> type name, and the object variables that point at other objects.
# (kind, field) => target group.  A key of -1 means "unset".
LINKS = {
    "Model":      {"layerKey": "Layer", "beamKey": "Beam"},
    "Layer":      {"materKey": "Material"},
    "Simulation": {"modelKey": "Model"},
    "Dynamical":  {"modelKey": "Model"},
    "Fit":        {"modelKey": "Model", "exptKey": "Experiment"},
    "Image":      {"fitKey": "Fit"},
    "Graph":      {"defPlotKey": "Plot", "modelKey": "Model"},
    "Plot":       {"graphKey": "Graph"},   # plus sourceType/sourceKey, see below
    "Table":      {},                      # sourceType/sourceKey only
}
# Group-index list from Group/nameList (read at runtime; asserted below).
def wave(path):
    return read_ibw(path)

def val(w):
    v = w["val"]
    if w["type"] == 0:
        return v
    a = np.asarray(v)
    if np.iscomplexobj(a):
        a = np.stack([a.real, a.imag], -1)
    return a.tolist()

def read_group_meta():
    g = lambda n: val(wave(f"{SRC}/Group/{n}.ibw"))
    return g("nameList"), g("prefixList")

def load_object(folder):
    """All waves + variables of one object folder."""
    o = {"waves": {}, "vars": {}}
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        if f.endswith(".ibw"):
            w = wave(p)
            o["waves"][f[:-4]] = {"shape": w["shape"], "value": val(w), "type": w["type"]}
        elif f == "variables":
            o["vars"] = {k: (int(v) if v == v and v == int(v) else v) for k, v in read_vars(p)[0].items()}
    return o

def zip_params(w):
    """parLabel/parVal/parHold/parTol/parStep/parDel -> list of dicts."""
    lab = w.get("parLabel", {}).get("value", [])
    n = len(w.get("parVal", {}).get("value", []))
    def col(name, default=None):
        v = w.get(name, {}).get("value", [])
        return [v[i] if i < len(v) else default for i in range(n)]
    out = []
    for i, (l, v, h, t, s, d) in enumerate(zip(
            (lab + [""] * n)[:n], col("parVal"), col("parHold", 1), col("parTol"), col("parStep"), col("parDel", 0))):
        out.append({"label": l, "value": v, "hold": bool(h), "tol": t, "step": s,
                    "increment": (10 ** s) if s is not None and s == s else None, "del": d})
    return out

def clean(x):  # NaN/inf are not valid JSON
    if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
        return None
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [clean(v) for v in x]
    return x

def export_constants():
    """Physical constants and material tables from root:Constants."""
    base = f"{SRC}/Constants"
    g = lambda *p: val(wave(os.path.join(base, *p) + ".ibw"))
    c = {"x": g("xVect"), "y": g("yVect"), "z": g("zVect")}
    c.update(read_vars(f"{base}/variables")[0])          # hc, mc2
    c["eDiff"] = {n[:-4]: g("eDiff", n[:-4]) for n in os.listdir(f"{base}/eDiff") if n.endswith(".ibw") and "desc" not in n}
    mp = {n[:-4]: g("materProps", n[:-4]) for n in os.listdir(f"{base}/materProps") if n.endswith(".ibw")}
    c["materProps"] = mp
    types = g("materTypes", "title")
    c["materTypes"] = {i: {"name": t, **{n[:-4]: g("materTypes", t, n[:-4]) for n in os.listdir(f"{base}/materTypes/{t}") if n.endswith(".ibw")}} for i, t in enumerate(types)}
    return c

def main():
    names, prefixes = read_group_meta()
    gi = {n: i for i, n in enumerate(names)}
    project = {"groups": names, "objects": [], "analysis": None}
    schema = {"groups": {}}
    seen = {}      # (group_idx, key) -> object

    for gidx, gname in enumerate(names):
        gdir = os.path.join(SRC, gname)
        if not os.path.isdir(gdir):
            continue
        pre = prefixes[gidx]
        group_waves = {f[:-4]: val(wave(os.path.join(gdir, f)))
                       for f in os.listdir(gdir) if f.endswith(".ibw")}
        full = group_waves.get("fullKey", [])
        titles = group_waves.get("title", [])
        keys = group_waves.get("key", [])
        # 'key' is the live-key list; 'title' is parallel to it (GetObjectTitle uses GetObjectIndex)
        tmap = {k: titles[i] if i < len(titles) else "" for i, k in enumerate(keys)}
        # default-object template
        dflt = load_object(os.path.join(gdir, "default")) if os.path.isdir(os.path.join(gdir, "default")) else None
        schema["groups"][gname] = {
            "index": gidx, "prefix": pre,
            "labels": {k: v for k, v in group_waves.items() if k.endswith("Label") or k in ("actionNameList", "tolLabel", "sigLabel", "varyMessages")},
            "prefs": group_waves.get("prefVal"),
            "defaultVars": dflt["vars"] if dflt else {},
            "defaultParams": zip_params(dflt["waves"]) if dflt else [],
            "defaultWaves": sorted(dflt["waves"]) if dflt else [],
            "links": LINKS.get(gname, {}),
        }
        for k in sorted(set(keys)):
            d = os.path.join(gdir, f"{pre}{int(k):06d}")
            if not os.path.isdir(d):
                continue
            o = load_object(d)
            obj = {"id": f"{gname}:{int(k)}", "type": gname, "key": int(k), "title": tmap.get(k, ""),
                   "vars": o["vars"], "params": zip_params(o["waves"]), "info": {}, "waves": {}}
            info_l = group_waves.get("infoLabel") or o["waves"].get("infoLabel", {}).get("value", [])
            if "infoLabel" in o["waves"]:
                info_l = o["waves"]["infoLabel"]["value"]
            info_v = o["waves"].get("infoVal", {}).get("value", [])
            obj["info"] = {(info_l[i] if i < len(info_l) and info_l[i] else f"info{i}"): v for i, v in enumerate(info_v)}
            for wn, w in o["waves"].items():
                if wn.startswith(f"{pre}{int(k):06d}") or wn.startswith("dynCalc"):
                    continue  # derived caches: plot copies of data, Dynamical intensity maps
                if wn in ("parLabel", "parVal", "parHold", "parTol", "parStep", "parDel", "infoLabel", "infoVal",
                          "refGroupKey", "refObjectKey", "image"):
                    continue
                obj["waves"][wn] = w["value"]
            # dependents as stored by Igor (downstream objects to refresh)
            rg = o["waves"].get("refGroupKey", {}).get("value", [])
            ro = o["waves"].get("refObjectKey", {}).get("value", [])
            obj["_igorDependents"] = [f"{names[int(a)]}:{int(b)}" for a, b in zip(rg, ro)]
            if "image" in o["waves"]:
                img = np.asarray(o["waves"]["image"]["value"]).astype(np.uint8)
                os.makedirs(f"{OUT}/images", exist_ok=True)
                from PIL import Image
                Image.fromarray(img.T).save(f"{OUT}/images/{obj['id'].replace(':','_')}.png")
                obj["imageFile"] = f"images/{obj['id'].replace(':','_')}.png"
                obj["imageSize"] = [int(img.shape[0]), int(img.shape[1])]  # [nx, ny] (Igor dim0, dim1)
            project["objects"].append(obj)
            seen[(gidx, int(k))] = obj
        if gname == "Analysis":
            project["analysisRoot"] = {k: v for k, v in group_waves.items() if k in ("infoLabel", "tolLabel", "tolVal", "sigLabel", "parLabel")}

    # Forward links from variables
    for o in project["objects"]:
        links = []
        for field, target in LINKS.get(o["type"], {}).items():
            k = o["vars"].get(field, -1)
            if k is not None and k >= 0:
                links.append({"field": field, "to": f"{target}:{int(k)}"})
        if o["type"] in ("Plot", "Table"):
            st, sk = o["vars"].get("sourceType", -1), o["vars"].get("sourceKey", -1)
            if st >= 0 and sk >= 0:
                links.append({"field": "source", "to": f"{names[int(st)]}:{int(sk)}"})
        o["links"] = links

    # Integrity report: dangling forward links; Igor dependents vs derived
    ids = {o["id"] for o in project["objects"]}
    derived = {i: set() for i in ids}
    report = {"danglingLinks": [], "staleDependents": [], "missingDependents": []}
    for o in project["objects"]:
        for l in o["links"]:
            if l["to"] not in ids:
                report["danglingLinks"].append([o["id"], l["field"], l["to"]])
            else:
                derived[l["to"]].add(o["id"])
    for o in project["objects"]:
        igor = set(o["_igorDependents"])
        for d in sorted(igor - derived[o["id"]]):
            (report["staleDependents"] if d not in ids else report["missingDependents"]).append([o["id"], d])
    project["integrity"] = report
    os.makedirs(OUT, exist_ok=True)
    project = clean(project)
    json.dump(clean(export_constants()), open(f"{OUT}/constants.json", "w"), indent=1)
    json.dump(project, open(f"{OUT}/project.json", "w"), indent=1)
    json.dump(schema, open(f"{OUT}/schema.json", "w"), indent=1)
    print(f"{len(project['objects'])} objects")
    print(json.dumps(report, indent=1))

main()
