#!/usr/bin/env python3
"""Score records with a saved model.  Usage: predict.py MODEL_DIR < records.json   (JSON list of {feature: value})
Prints {"classes": [...], "results": [...]}.  Never executes input; values are only parsed as numbers or strings."""
import json, math, os, sys
import numpy as np
from ada_fedavg import forward

def load(path):
    S = {k: v for k, v in np.load(os.path.join(path, "model.npz"), allow_pickle=False).items()}
    with open(os.path.join(path, "prep.json")) as f: return S, json.load(f)

def encode(P, records):
    num, cat = P["numeric"], P["categorical"]
    rows, meta = [], []
    for i, rec in enumerate(records):
        warn, vec, bad = [], [], None
        if not isinstance(rec, dict): meta.append({"error": "record must be an object"}); continue
        missing = []
        for f in num:
            v = rec.get(f["name"])
            if v is None or (isinstance(v, str) and v.strip() == ""): missing.append(f["name"]); z = 0.0
            else:
                try: x = float(v)
                except (TypeError, ValueError): bad = f"{f['name']}: '{str(v)[:30]}' is not a number"; break
                if not math.isfinite(x): bad = f"{f['name']}: value is not finite"; break
                if f.get("log"): x = math.log1p(max(x, 0.0))  # column was log-transformed in training
                z = (x - f["mean"]) / f["std"]
                if P.get("clip"): z = max(-P["clip"], min(P["clip"], z))
            vec.append(z)
        if bad: meta.append({"error": bad}); continue
        for f in cat:
            v = str(rec.get(f["name"], "")).strip(); hot = [0.0] * len(f["values"])
            if v in f["values"]: hot[f["values"].index(v)] = 1.0
            else: warn.append(f"{f['name']}: " + (f"unknown value '{v[:30]}'" if v else "missing") + " (treated as no category)")
            vec.extend(hot)
        if missing: warn.append(f"{len(missing)} missing numeric field(s) set to the training average" + (": " + ", ".join(missing[:5]) if len(missing) <= 5 else ""))
        rows.append(vec); meta.append({"warnings": warn})
    return np.array(rows, dtype=np.float32).reshape(len(rows), -1), meta

def predict_records(path, records):
    S, P = load(path); X, meta = encode(P, records); classes = P["classes"]
    if len(X):
        lg = forward(S, X, False)[0].astype(np.float64); lg -= lg.max(1, keepdims=True); pr = np.exp(lg); pr /= pr.sum(1, keepdims=True)
    out, k = [], 0
    for i, m in enumerate(meta):
        if "error" in m: out.append({"index": i, "error": m["error"]}); continue
        p = pr[k]; k += 1; j = int(p.argmax())
        out.append({"index": i, "class": classes[j], "confidence": float(p[j]), "probabilities": {c: float(v) for c, v in zip(classes, p)}, "warnings": m["warnings"]})
    return {"classes": classes, "meta": P.get("meta", {}), "results": out}

if __name__ == "__main__":
    try: print(json.dumps(predict_records(sys.argv[1], json.load(sys.stdin))))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:200]})); sys.exit(1)
