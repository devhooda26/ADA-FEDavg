#!/usr/bin/env python3
"""Benchmark the platform's model on varied data, against independent references.   Usage: python benchmark.py [--seeds 3] [--rounds 40]

Datasets (all offline): two real ones bundled with scikit-learn (breast cancer, handwritten digits) and a synthetic heavy-tailed
traffic-like set (lognormal bytes/packets/duration, a categorical protocol, imbalanced classes).
Every dataset goes through the real pipeline: CSV -> ingest.py -> ada_fedavg.py CLI (same split for every method).
References: scikit-learn HistGradientBoosting and LogisticRegression on the identical split.
Reports mean +- std of test macro-F1 over seeds. Federated runs use a label-skewed partition across 5 clients (the hard case)."""
import argparse, csv, json, os, subprocess, sys, tempfile
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
import ada_fedavg as A


def datasets():
    from sklearn.datasets import load_breast_cancer, load_digits
    out = {}
    d = load_breast_cancer(); out["breast_cancer"] = (list(d.feature_names), d.data, [d.target_names[i] for i in d.target], None)
    d = load_digits(); out["digits"] = ([f"px{i}" for i in range(64)], d.data, [f"d{i}" for i in d.target], None)
    rng = np.random.default_rng(7); n = 6000; cls = rng.choice(4, n, p=[0.55, 0.25, 0.15, 0.05]); names = ["benign", "dos", "probe", "r2l"]
    X = np.column_stack([rng.lognormal(6 + 0.8 * cls, 1.4), rng.lognormal(2 + 0.5 * (cls == 1) + 0.3 * cls, 1.1), rng.lognormal(0.5 + 0.9 * (cls == 2), 1.3),
                         rng.poisson(1 + 3 * (cls == 3)), rng.normal(0, 1, n)])
    proto = np.array(["tcp", "udp", "icmp"])[(rng.integers(0, 3, n) + (cls == 1)) % 3]
    out["traffic_heavy_tail"] = (["bytes", "packets", "duration", "failed_logins", "noise"], X, [names[i] for i in cls], proto)
    return out


def write_csv(path, cols, X, y, proto):
    with open(path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(cols + (["proto"] if proto is not None else []) + ["label"])
        for i in range(len(y)): w.writerow([repr(float(v)) for v in X[i]] + ([proto[i]] if proto is not None else []) + [y[i]])


def fed(csv_path, cmap_path, method, seed, rounds, extra=()):
    r = subprocess.run([sys.executable, os.path.join(HERE, "ada_fedavg.py"), "--method", method, "--rounds", str(rounds), "--clients", "5", "--clusters", "2", "--seed", str(seed),
                        "--dataset-file", csv_path, "--label-col", "label", "--class-map", cmap_path, *extra], capture_output=True, text=True, cwd=HERE, timeout=900)
    ev = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]
    res = [e for e in ev if e.get("type") == "result"]
    if not res: raise RuntimeError(r.stdout[-300:] + r.stderr[-300:])
    return res[0]["test"]["macro_f1"]


def reference(csv_path, cmap, seed):
    """Same rows, same stratified split as the CLI uses (partition seed = seed), independent learners."""
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score
    a = A.parser().parse_args(["--method", "ada", "--seed", str(seed)])
    cat, num, y, info = A.load_table(csv_path, "label", cmap, None, seed)
    trm, tem = A.stratified_split(y, a.test_frac, np.random.default_rng(seed + 1))
    prep = A.Prep(clip=20, auto_log=True).fit([c for c, m in zip(cat, trm) if m], num[trm])
    X = prep.transform(cat, num)
    r = {}
    r["HistGradientBoosting"] = f1_score(y[tem], HistGradientBoostingClassifier(random_state=seed).fit(X[trm], y[trm]).predict(X[tem]), average="macro")
    r["LogisticRegression"] = f1_score(y[tem], LogisticRegression(max_iter=2000).fit(X[trm], y[trm]).predict(X[tem]), average="macro")
    return r


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--seeds", type=int, default=3); ap.add_argument("--rounds", type=int, default=40); a = ap.parse_args()
    table = {}
    with tempfile.TemporaryDirectory() as d:
        for name, (cols, X, y, proto) in datasets().items():
            p = os.path.join(d, name + ".csv"); write_csv(p, cols, X, y, proto)
            cmap = {c: c for c in sorted(set(y))}; mp = os.path.join(d, name + ".map.json"); json.dump(cmap, open(mp, "w"))
            rows = {}
            for s in range(a.seeds):
                for label, method, extra in (("ADA-FedAvg (this platform)", "ada", ()), ("ADA-FedAvg, no log transform", "ada", ("--no-auto-log",)),
                                             ("FedAvg", "fedavg", ()), ("Centralized (same network)", "centralized", ())):
                    rows.setdefault(label, []).append(fed(p, mp, method, s, a.rounds, extra))
                for k, v in reference(p, cmap, s).items(): rows.setdefault(k + " (centralized reference)", []).append(v)
            table[name] = rows
            print(f"\n{name}  ({len(y)} rows, {len(set(y))} classes, {a.seeds} seeds, {a.rounds} rounds, 5 clients, label-skewed)", flush=True)
            for k, v in rows.items(): print(f"  {k:<44} macro-F1 {np.mean(v):.3f} +- {np.std(v):.3f}", flush=True)
    return table


if __name__ == "__main__":
    main()
