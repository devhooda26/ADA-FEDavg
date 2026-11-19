#!/usr/bin/env python3
"""ADA-FedAvg: Attack-Distribution-Aware Clustered Federated Averaging (NSL-KDD, numpy).
Emits JSON lines on stdout: {"type":"progress",...} ... {"type":"result",...}"""
import argparse, json, sys, time
import numpy as np

CLASSES = ["benign", "dos", "probe", "r2l", "u2r"]
ATTACK = {}
for c, names in {
    1: "back land neptune pod smurf teardrop apache2 mailbomb processtable udpstorm worm",
    2: "ipsweep nmap portsweep satan mscan saint",
    3: "ftp_write guess_passwd imap multihop phf spy warezclient warezmaster sendmail named snmpgetattack snmpguess xlock xsnoop httptunnel",
    4: "buffer_overflow loadmodule perl rootkit ps sqlattack xterm"}.items():
    for n in names.split(): ATTACK[n] = c
ALPHA = {"mild": 1.0, "moderate": 0.5, "extreme": 0.1}
NSL_COLS = ("duration protocol_type service flag src_bytes dst_bytes land wrong_fragment urgent hot num_failed_logins logged_in num_compromised root_shell su_attempted "
            "num_root num_file_creations num_shells num_access_files num_outbound_cmds is_host_login is_guest_login count srv_count serror_rate srv_serror_rate rerror_rate "
            "srv_rerror_rate same_srv_rate diff_srv_rate srv_diff_host_rate dst_host_count dst_host_srv_count dst_host_same_srv_rate dst_host_diff_srv_rate "
            "dst_host_same_src_port_rate dst_host_srv_diff_host_rate dst_host_serror_rate dst_host_srv_serror_rate dst_host_rerror_rate dst_host_srv_rerror_rate").split()

# ---------------- data ----------------
def load_nsl(path, max_rows=None, seed=0, extras=False):
    rows = [l.rstrip("\n").split(",") for l in open(path) if l.strip()]
    if max_rows and len(rows) > max_rows:
        idx = np.random.default_rng(seed).choice(len(rows), max_rows, replace=False)
        rows = [rows[i] for i in sorted(idx)]
    y = np.array([0 if r[41] == "normal" else ATTACK[r[41]] for r in rows])
    cat = [r[1:4] for r in rows]
    num = np.array([[float(v) for i, v in enumerate(r[:41]) if i not in (1, 2, 3)] for r in rows], dtype=np.float32)
    if extras: return cat, num, y, [r[41] for r in rows], np.array([int(r[42]) for r in rows])
    return cat, num, y

def col_kind(vals):
    """numeric / categorical / text / constant for a list of stripped strings."""
    if len(set(vals)) <= 1: return "constant"
    ne = [v for v in vals if v != ""]; ok = 0
    for v in ne:
        try:
            if np.isfinite(float(v)): ok += 1
        except ValueError: pass
    if ne and ok / len(ne) >= 0.98:
        if len(vals) > 20 and len(set(vals)) == len(vals) and all(v.lstrip("-").isdigit() for v in vals): return "identifier"
        return "numeric"
    return "categorical" if len(set(vals)) <= 100 else "text"

def read_csv(path):
    import csv
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        rd = csv.reader(f); header = [h.strip() for h in next(rd)]
        rows, ragged = [], 0
        for r in rd:
            if len(r) == len(header): rows.append([c.strip() for c in r])
            elif r: ragged += 1
    return header, rows, ragged

def load_table(path, label_col, class_map, max_rows=None, seed=0):
    """Generic CSV loader. Returns cat, num, y plus a report of what was used or dropped."""
    header, rows, ragged = read_csv(path)
    if label_col not in header: raise ValueError(f"label column '{label_col}' not found")
    li = header.index(label_col); rows_in = len(rows)
    rows = [r for r in rows if r[li] in class_map]; unmapped = rows_in - len(rows)
    if max_rows and len(rows) > max_rows:
        idx = np.random.default_rng(seed).choice(len(rows), max_rows, replace=False); rows = [rows[i] for i in sorted(idx)]
    classes = sorted(set(class_map.values())); cidx = {c: i for i, c in enumerate(classes)}
    y = np.array([cidx[class_map[r[li]]] for r in rows])
    num_cols, cat_cols, dropped, nums = [], [], [], []
    for j, name in enumerate(header):
        if j == li: continue
        vals = [r[j] for r in rows]; kind = col_kind(vals)
        if kind == "numeric":
            a = np.array([float(v) if v != "" else np.nan for v in vals], dtype=np.float64)
            a[~np.isfinite(a)] = np.nan
            if len(a) and np.isnan(a).mean() > 0.3:  # mostly empty: drop the column rather than every row that lacks it
                dropped.append({"name": name, "reason": "more than 30% missing"}); continue
            num_cols.append(name); nums.append(a)
        elif kind == "categorical": cat_cols.append((name, j))
        else: dropped.append({"name": name, "reason": kind})
    if not nums and not cat_cols: raise ValueError("no usable feature columns")
    X = np.column_stack(nums) if nums else np.zeros((len(rows), 0))
    keep = ~np.isnan(X).any(1) if nums else np.ones(len(rows), bool)
    bad = int((~keep).sum())
    cat = [[rows[i][j] for _, j in cat_cols] for i in range(len(rows)) if keep[i]]
    info = {"rows_read": rows_in, "rows_used": int(keep.sum()), "rows_unmapped_label": unmapped, "rows_ragged": ragged, "rows_dropped_missing_or_nonfinite": bad,
            "numeric_columns": len(num_cols), "numeric_names": num_cols, "categorical_columns": [n for n, _ in cat_cols], "dropped_columns": dropped, "classes": classes}
    return cat, X[keep].astype(np.float32), y[keep], info

class Prep:
    """Fit on the training split only (no validation/test leakage).
    auto_log: columns that are non-negative and strongly right-skewed (skewness > 2: bytes, counts, durations) get log1p
    before standardising, which keeps a few huge values from flattening every other value. Decided on training data, saved with the model."""
    def __init__(self, clip=None, auto_log=False): self.clip, self.auto_log = clip, auto_log
    def _tf(self, num):
        if not self.log.any(): return num
        out = num.astype(np.float64).copy(); out[:, self.log] = np.log1p(np.maximum(out[:, self.log], 0)); return out
    def fit(self, cat, num):
        self.vocab = [sorted(set(c[j] for c in cat)) for j in range(len(cat[0]) if cat else 0)]
        self.log = np.zeros(num.shape[1], bool)
        if self.auto_log and len(num):
            mu, sd = num.mean(0), num.std(0) + 1e-12
            skew = (((num - mu) / sd) ** 3).mean(0)
            self.log = (num.min(0) >= 0) & (skew > 2.0)
        t = self._tf(num)
        self.mu, self.sd = t.mean(0), t.std(0) + 1e-6
        return self
    def transform(self, cat, num):
        oh = np.zeros((len(cat), sum(len(v) for v in self.vocab)), dtype=np.float32)
        off = 0
        for j, v in enumerate(self.vocab):
            pos = {k: i for i, k in enumerate(v)}
            for r, c in enumerate(cat):
                if c[j] in pos: oh[r, off + pos[c[j]]] = 1
            off += len(v)
        z = (self._tf(num) - self.mu) / self.sd
        if self.clip: z = np.clip(z, -self.clip, self.clip)
        return np.hstack([z, oh]).astype(np.float32)

def stratified_split(y, frac, rng):
    val = []
    for c in np.unique(y):
        i = rng.permutation(np.where(y == c)[0]); val += list(i[: max(1, int(len(i) * frac))])
    mask = np.zeros(len(y), bool); mask[val] = True
    return ~mask, mask

def dirichlet_partition(y, n_clients, alpha, rng, min_size=50, qw=None):
    min_size = max(2, min(min_size, len(y) // (n_clients * 4)))
    for attempt in range(600):
        if attempt and attempt % 200 == 0: min_size = max(2, min_size // 2)   # relax only when the skew makes the target unreachable
        parts = [[] for _ in range(n_clients)]
        for c in range(len(CLASSES)):
            idx = rng.permutation(np.where(y == c)[0])
            p = rng.dirichlet(alpha * np.ones(n_clients))
            if qw is not None: p = p * qw; p = p / p.sum()
            cuts = (np.cumsum(p) * len(idx)).astype(int)[:-1]
            for k, chunk in enumerate(np.split(idx, cuts)): parts[k] += chunk.tolist()
        if min(len(p) for p in parts) >= min_size: return [np.array(p) for p in parts]
    raise RuntimeError("could not build a valid partition; increase data or alpha")

def make_partition(y, n, alpha, rng, modes=("label",), qalpha=0.5):
    """Heterogeneity: 'label' (Dirichlet class skew), 'quantity' (Dirichlet client sizes); 'feature' shift is applied by the caller."""
    qw = None
    if "quantity" in modes:
        qw = np.maximum(rng.dirichlet(qalpha * np.ones(n)) * n, 0.05); qw = qw * n / qw.sum()   # floor: no client is (almost) empty
    if "label" in modes: return dirichlet_partition(y, n, alpha, rng, qw=qw)
    idx = rng.permutation(len(y)); w = qw if qw is not None else np.ones(n)
    return [np.array(c) for c in np.split(idx, (np.cumsum(w / w.sum()) * len(idx)).astype(int)[:-1])]

# ---------------- ADA-FedAvg core ----------------
def class_dist(y, k=None):
    k = k or len(CLASSES)
    c = np.bincount(y, minlength=k).astype(float); return c / c.sum()

def js_divergence(p, q):
    p, q = np.asarray(p, float), np.asarray(q, float); m = 0.5 * (p + q)
    kl = lambda a, b: float(np.sum(a[a > 0] * np.log2(a[a > 0] / b[a > 0])))
    return 0.5 * kl(p, m) + 0.5 * kl(q, m)

def jsd_matrix(dists):
    n = len(dists); M = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n): M[i, j] = M[j, i] = js_divergence(dists[i], dists[j])
    return M

def feat_dists(dists, mode, gdist):
    """Representation used for clustering. jsd: raw proportions (paper). jsd-invfreq: reweight by inverse global class frequency.
    jsd-log: log-compress shares so presence of rare classes is not drowned by benign/DoS shares."""
    D = np.asarray(dists, float)
    if mode == "jsd-invfreq": D = D / np.maximum(np.asarray(gdist, float), 1e-6)
    elif mode == "jsd-log": D = np.log1p(D / 1e-3)
    elif mode != "jsd": raise ValueError("unknown distance " + mode)
    return D / D.sum(1, keepdims=True)

def cluster_clients(dists, k):
    from sklearn.cluster import AgglomerativeClustering
    D = np.sqrt(jsd_matrix(dists))  # JS distance
    return AgglomerativeClustering(n_clusters=k, metric="precomputed", linkage="average").fit_predict(D)

def wavg(states, weights):
    w = np.asarray(weights, float); w = w / w.sum()
    return {k: sum(wi * s[k] for wi, s in zip(w, states)).astype(np.float32) for k in states[0]}

def fedavg_aggregate(states, sizes): return wavg(states, sizes)

def two_stage_aggregate(states, sizes, labels, blend=0.0):
    """Stage 1: sample-weighted inside each cluster. Stage 2: equal weight across clusters (blend=0, the paper).
    blend=b mixes equal weights with sample-share weights: (1-b)*equal + b*share. b=1 equals FedAvg; intermediate values bound a small cluster's influence."""
    cluster_models, tot = [], []
    for c in sorted(set(labels)):
        ids = [i for i, l in enumerate(labels) if l == c]
        cluster_models.append(wavg([states[i] for i in ids], [sizes[i] for i in ids])); tot.append(sum(sizes[i] for i in ids))
    k = len(cluster_models); share = np.asarray(tot, float) / sum(tot)
    return wavg(cluster_models, (1 - blend) / k + blend * share)

def class_weights(y, K, power=0.5):
    c = np.bincount(y, minlength=K).astype(float)
    return np.where(c > 0, (c.sum() / (K * np.maximum(c, 1))) ** power, 0.0)

# ---------------- MLP (128-64-32, BatchNorm, ReLU, Dropout) ----------------
def init_model(rng, d_in, hidden=(128, 64, 32), n_out=None):
    n_out = n_out or len(CLASSES)
    S, d = {}, d_in
    for i, h in enumerate(hidden):
        S[f"W{i}"] = (rng.standard_normal((d, h)) * np.sqrt(2 / d)).astype(np.float32)
        S[f"b{i}"] = np.zeros(h, np.float32); S[f"g{i}"] = np.ones(h, np.float32); S[f"e{i}"] = np.zeros(h, np.float32)
        S[f"rm{i}"] = np.zeros(h, np.float32); S[f"rv{i}"] = np.ones(h, np.float32); d = h
    S["Wo"] = (rng.standard_normal((d, n_out)) * np.sqrt(1 / d)).astype(np.float32); S["bo"] = np.zeros(n_out, np.float32)
    return S

def n_layers(S): return sum(1 for k in S if k.startswith("W") and k != "Wo")
TRAINABLE = lambda S: [k for k in S if not k.startswith("r")]
def n_bytes(S): return sum(v.nbytes for v in S.values())

def forward(S, X, train, rng=None, p=0.0, mom=0.1, eps=1e-5):
    a, cache = X, []
    for i in range(n_layers(S)):
        z = a @ S[f"W{i}"] + S[f"b{i}"]
        if train:
            mu, var = z.mean(0), z.var(0)
            S[f"rm{i}"] = (1 - mom) * S[f"rm{i}"] + mom * mu; S[f"rv{i}"] = (1 - mom) * S[f"rv{i}"] + mom * var
        else: mu, var = S[f"rm{i}"], S[f"rv{i}"]
        inv = 1 / np.sqrt(var + eps); xh = (z - mu) * inv; y = S[f"g{i}"] * xh + S[f"e{i}"]; r = np.maximum(y, 0)
        mask = ((rng.random(r.shape) >= p) / (1 - p)).astype(np.float32) if train and p > 0 else None
        cache.append((a, xh, inv, y, mask)); a = r * mask if mask is not None else r
    return a @ S["Wo"] + S["bo"], a, cache

def loss_grads(S, X, y, rng=None, p=0.0, cw=None):
    logits, a, cache = forward(S, X, True, rng, p)
    sh = logits - logits.max(1, keepdims=True); P = np.exp(sh); P /= P.sum(1, keepdims=True)
    N = len(y); sw = cw[y] if cw is not None else np.ones(N); sw = sw / sw.sum()
    loss = float((-np.log(P[np.arange(N), y] + 1e-12) * sw).sum())
    d = P.copy(); d[np.arange(N), y] -= 1; d *= sw[:, None]
    G = {"Wo": a.T @ d, "bo": d.sum(0)}; ga = d @ S["Wo"].T
    for i in reversed(range(n_layers(S))):
        a_prev, xh, inv, yv, mask = cache[i]
        if mask is not None: ga = ga * mask
        dy = ga * (yv > 0); G[f"g{i}"] = (dy * xh).sum(0); G[f"e{i}"] = dy.sum(0)
        dxh = dy * S[f"g{i}"]; dz = inv * (dxh - dxh.mean(0) - xh * (dxh * xh).mean(0))
        G[f"W{i}"] = a_prev.T @ dz; G[f"b{i}"] = dz.sum(0); ga = dz @ S[f"W{i}"].T
    return loss, G

class Adam:
    def __init__(self, S, lr=1e-3): self.lr, self.t, self.m, self.v = lr, 0, {}, {}
    def step(self, S, G, b1=0.9, b2=0.999):
        self.t += 1
        for k, g in G.items():
            m = self.m.get(k, 0) * b1 + (1 - b1) * g; v = self.v.get(k, 0) * b2 + (1 - b2) * g * g
            self.m[k], self.v[k] = m, v
            S[k] = (S[k] - self.lr * (m / (1 - b1 ** self.t)) / (np.sqrt(v / (1 - b2 ** self.t)) + 1e-8)).astype(np.float32)

def train_epochs(S, X, y, rng, epochs=1, bs=256, p=0.3, opt=None, cw=None, prox=None):
    opt = opt or Adam(S); last = 0.0
    for _ in range(epochs):
        order = rng.permutation(len(y))
        for s in range(0, len(y), bs):
            b = order[s:s + bs]
            if len(b) < 2: continue
            last, G = loss_grads(S, X[b], y[b], rng, p, cw)
            if prox:  # FedProx: gradient of (mu/2)||w - w_global||^2
                mu, ref = prox
                for k in G: G[k] = G[k] + mu * (S[k] - ref[k])
            opt.step(S, G)
    return last

def predict(S, X, bs=8192):
    return np.concatenate([forward(S, X[i:i + bs], False)[0].argmax(1) for i in range(0, len(X), bs)])

def metrics(y, pred):
    from sklearn.metrics import accuracy_score, f1_score, precision_recall_fscore_support, confusion_matrix
    K = len(CLASSES)
    pr, rc, f1, sup = precision_recall_fscore_support(y, pred, labels=range(K), zero_division=0)
    bi = next((i for i, c in enumerate(CLASSES) if c.lower() in ("benign", "normal")), None); far = det = None
    if bi is not None:
        nb = y == bi; ab = ~nb
        far = float((pred[nb] != bi).mean()) if nb.any() else None          # benign flagged as attack
        det = float((pred[ab] != bi).mean()) if ab.any() else None          # attacks not called benign
    return {"false_alarm_rate": far, "attack_detection_rate": det, "accuracy": float(accuracy_score(y, pred)), "macro_f1": float(f1_score(y, pred, average="macro", labels=range(K), zero_division=0)),
            "weighted_f1": float(f1_score(y, pred, average="weighted", labels=range(K), zero_division=0)),
            "per_class": [{"class": CLASSES[i], "precision": float(pr[i]), "recall": float(rc[i]), "f1": float(f1[i]), "support": int(sup[i])} for i in range(K)],
            "confusion": confusion_matrix(y, pred, labels=range(K)).tolist()}

def emit(o): print(json.dumps(o), flush=True)

def save_model(path, S, prep, classes, meta):
    """Persist the final global model and everything needed to score new records (schema, vocabularies, scaling)."""
    import os
    os.makedirs(path, exist_ok=True)
    np.savez(os.path.join(path, "model.npz"), **S)
    doc = {"classes": list(classes), "clip": prep.clip, "meta": meta,
           "numeric": [{"name": n, "mean": float(m), "std": float(sd), "log": bool(lg)} for n, m, sd, lg in zip(prep.num_names, prep.mu, prep.sd, prep.log)],
           "categorical": [{"name": n, "values": v} for n, v in zip(prep.cat_names, prep.vocab)]}
    with open(os.path.join(path, "prep.json"), "w") as f: json.dump(doc, f)

# ---------------- run ----------------
def ce_loss(S, X, y):
    lg = forward(S, X, False)[0]; lg = lg - lg.max(1, keepdims=True)
    return float(-(lg[np.arange(len(y)), y] - np.log(np.exp(lg).sum(1))).mean())

def cluster_report(yc, labels):
    out = {}
    for i, l in enumerate(labels): out.setdefault(int(l), []).append(i)
    rep = []
    for c, ids in sorted(out.items()):
        cnt = sum(np.bincount(yc[i], minlength=len(CLASSES)) for i in ids)
        rep.append({"cluster": c, "clients": ids, "samples": int(cnt.sum()), "class_counts": cnt.tolist(), "class_share": (cnt / cnt.sum()).tolist()})
    return rep

def run(a):
    t0 = time.time(); pseed = a.seed if a.partition_seed is None else a.partition_seed
    rng, mrng = np.random.default_rng(pseed), np.random.default_rng(a.seed)   # data/partition randomness vs model-init randomness
    modes = tuple(m for m in a.hetero.split(",") if m)
    emit({"type": "progress", "stage": "preparing", "message": "loading dataset"})
    dinfo, names_tr, tn, td = None, None, None, None
    if a.dataset_file:
        cmap = json.load(open(a.class_map)); CLASSES[:] = sorted(set(cmap.values()))
        cat, num, y, dinfo = load_table(a.dataset_file, a.label_col, cmap, a.max_train, a.seed)
        counts = np.bincount(y, minlength=len(CLASSES))
        if (counts < 10).any(): raise ValueError("class '%s' has only %d usable rows; merge it into another class" % (CLASSES[int(counts.argmin())], counts.min()))
        trm, tem = stratified_split(y, a.test_frac, np.random.default_rng(pseed + 1))
        tcat, tnum, ty = [c for c, m in zip(cat, tem) if m], num[tem], y[tem]
        cat, num, y = [c for c, m in zip(cat, trm) if m], num[trm], y[trm]
        emit({"type": "progress", "stage": "preparing", "message": "dataset loaded", "data_info": dinfo})
    else:
        cat, num, y, names_all, _ = load_nsl(a.train, a.max_train, a.seed, extras=True); tcat, tnum, ty, tn, td = load_nsl(a.test, a.max_test, a.seed, extras=True)
        names_tr = set(names_all)
    K = len(CLASSES)
    tr, va = stratified_split(y, 0.1, rng)
    prep = (Prep(clip=20, auto_log=not a.no_auto_log) if a.dataset_file else Prep()).fit([c for c, m in zip(cat, tr) if m], num[tr])
    if a.dataset_file: prep.num_names, prep.cat_names = dinfo["numeric_names"], dinfo["categorical_columns"]
    else: prep.num_names, prep.cat_names = [c for i, c in enumerate(NSL_COLS) if i not in (1, 2, 3)], list(NSL_COLS[1:4])
    X = prep.transform(cat, num); Xt = prep.transform(tcat, tnum); nn = len(prep.mu)
    Xtr, ytr, Xva, yva = X[tr], y[tr], X[va], y[va]
    gdist = class_dist(ytr, K)
    cw_fn = lambda yy: None if a.loss_weights == "none" else class_weights(ytr if (a.loss_weights == "global" or a.method == "centralized") else yy, K, a.cw_power)
    S = init_model(mrng, X.shape[1], n_out=K); hist = []; clients = labels = jm = cstats = None; comm = None; summary_bytes = 0

    select_best = bool(a.dataset_file) and not a.no_select_best   # uploaded datasets keep the best round by VALIDATION macro-F1 (never by test); the paper's NSL-KDD runs keep the last round
    best = {"f1": -1.0, "S": None, "round": 0}

    def record(r, S_, loss):
        m = metrics(yva, predict(S_, Xva))
        if select_best and m["macro_f1"] > best["f1"] + 1e-9: best.update(f1=m["macro_f1"], S={k: v.copy() for k, v in S_.items()}, round=r)
        hist.append({"round": r, "val_macro_f1": m["macro_f1"], "val_accuracy": m["accuracy"], "loss": float(loss)})
        emit({"type": "progress", "stage": "training", "round": r, "rounds": a.rounds, **hist[-1]})

    if a.method == "centralized":
        opt = Adam(S, a.lr); cw = cw_fn(ytr)
        for r in range(1, a.rounds + 1):
            loss = train_epochs(S, Xtr, ytr, rng, a.local_epochs, a.batch, a.dropout, opt, cw=cw); record(r, S, loss)
    else:
        parts = make_partition(ytr, a.clients, ALPHA[a.skew], rng, modes, a.quantity_alpha)
        shifts = [rng.normal(0, a.feature_shift, nn) if "feature" in modes else None for _ in parts]
        Xc = []
        for i, p in enumerate(parts):
            xi = Xtr[p].copy()
            if shifts[i] is not None: xi[:, :nn] += shifts[i]
            Xc.append(xi)
        yc = [ytr[p] for p in parts]; sizes = [len(p) for p in parts]
        ytrain = list(yc)
        reported = [class_dist(v, K) for v in yc]
        if a.sybil:  # toy attack: client 0 flips labels and reports a distinctive fake histogram
            ytrain[0] = (yc[0] + 1) % K; f = np.full(K, 1e-3); f[int(np.argmin(gdist))] = 1.0; reported[0] = f / f.sum()
        jm = jsd_matrix(reported)
        if a.method == "ada":
            labels = cluster_clients(feat_dists(reported, a.distance, gdist), min(a.clusters, a.clients)).tolist()
            if a.cluster_mode == "random": labels = rng.permutation(labels).tolist()      # same cluster sizes, random membership
            elif a.cluster_mode == "singleton": labels = list(range(a.clients))            # K = N: every client its own cluster
            summary_bytes = a.clients * K * 4
        clients = [{"id": i, "samples": sizes[i], "distribution": reported[i].tolist(), "cluster": labels[i] if labels else None} for i in range(a.clients)]
        emit({"type": "progress", "stage": "partitioned", "clients": clients, "classes": list(CLASSES)})
        def local(S0, i, r):
            L = {k: v.copy() for k, v in S0.items()}
            loss = train_epochs(L, Xc[i], ytrain[i], np.random.default_rng(a.seed * 1000 + r * 50 + i), a.local_epochs, a.batch, a.dropout, Adam(L, a.lr),
                                cw=cw_fn(ytrain[i]), prox=(a.prox_mu, S0) if a.method == "fedprox" else None)
            return L, loss
        if a.method == "ifca":
            models = [init_model(np.random.default_rng(a.seed + 100 + k), X.shape[1], n_out=K) for k in range(min(a.clusters, a.clients))]
        for r in range(1, a.rounds + 1):
            if a.method == "ifca":
                by = [[] for _ in models]; sz = [[] for _ in models]; labels = []; losses = []
                for i in range(a.clients):
                    sub = np.random.default_rng(r * 77 + i).permutation(len(ytrain[i]))[:2000]
                    k = int(np.argmin([ce_loss(m, Xc[i][sub], ytrain[i][sub]) for m in models])); labels.append(k)
                    L, l = local(models[k], i, r); by[k].append(L); sz[k].append(sizes[i]); losses.append(l)
                for k in range(len(models)):
                    if by[k]: models[k] = wavg(by[k], sz[k])
                emit({"type": "progress", "stage": "aggregating", "round": r, "rounds": a.rounds})
                vf = [metrics(yva, predict(m, Xva))["macro_f1"] for m in models]; S = models[int(np.argmax(vf))]  # best-by-validation cluster model
                record(r, S, np.mean(losses))
            else:
                res = [local(S, i, r) for i in range(a.clients)]; states = [x[0] for x in res]
                emit({"type": "progress", "stage": "aggregating", "round": r, "rounds": a.rounds})
                S = two_stage_aggregate(states, sizes, labels, a.blend) if a.method == "ada" else fedavg_aggregate(states, sizes)
                record(r, S, np.mean([x[1] for x in res]))
        mb = n_bytes(S)
        comm = (a.clients * a.rounds * mb * (len(models) + 1) if a.method == "ifca" else 2 * a.clients * a.rounds * mb) / 1e6
        if labels is not None: cstats = cluster_report(yc, labels)
        if a.method == "ifca":
            for c in clients: c["cluster"] = labels[c["id"]]
    selected_round = a.rounds
    if select_best and best["S"] is not None: S, selected_round = best["S"], best["round"]
    emit({"type": "progress", "stage": "evaluating"})
    pred = predict(S, Xt); test = metrics(ty, pred); gen = None
    if tn is not None:   # NSL-KDD only: generalisation views
        tn = np.array(tn); m21 = td < 21; known = np.array([n in names_tr for n in tn]); atk = ty != 0
        sub = lambda m: {k: v for k, v in metrics(ty[m], pred[m]).items() if k in ("accuracy", "macro_f1", "weighted_f1", "per_class")}
        gen = {"test21": {"n": int(m21.sum()), **sub(m21)},
               "novel_attacks": {"n": int((atk & ~known).sum()), "detection_rate": float((pred[atk & ~known] != 0).mean()) if (atk & ~known).any() else None},
               "known_attacks": {"n": int((atk & known).sum()), "detection_rate": float((pred[atk & known] != 0).mean()) if (atk & known).any() else None}}
    saved = False
    if a.save_model:
        save_model(a.save_model, S, prep, CLASSES, {"method": a.method, "dataset": "custom" if a.dataset_file else "nsl-kdd", "label_col": a.label_col}); saved = True
    emit({"type": "result", "source": "generated", "model_saved": saved, "selected_round": selected_round, "rounds_run": a.rounds, "classes": list(CLASSES), "dataset_info": dinfo,
          "config": {k: getattr(a, k) for k in ["method", "skew", "rounds", "clients", "clusters", "seed", "partition_seed", "local_epochs", "batch", "lr", "dropout", "loss_weights", "cw_power", "prox_mu", "cluster_mode", "distance", "blend", "sybil", "hetero", "feature_shift", "quantity_alpha", "max_train", "max_test"]},
          "test": test, "generalization": gen, "history": hist, "clients": clients, "jsd": jm.tolist() if jm is not None else None, "clusters": labels, "cluster_stats": cstats,
          "comm_mb": comm, "summary_bytes": summary_bytes, "train_samples": int(len(ytr)), "test_samples": int(len(ty)), "duration_s": round(time.time() - t0, 1)})

def parser():
    p = argparse.ArgumentParser()
    p.add_argument("--method", choices=["centralized", "fedavg", "fedprox", "ifca", "ada"], required=True)
    p.add_argument("--skew", choices=list(ALPHA), default="moderate")
    p.add_argument("--rounds", type=int, default=30); p.add_argument("--clients", type=int, default=8); p.add_argument("--clusters", type=int, default=3)
    p.add_argument("--seed", type=int, default=42); p.add_argument("--partition-seed", type=int, default=None, help="defaults to --seed")
    p.add_argument("--local-epochs", type=int, default=1); p.add_argument("--batch", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3); p.add_argument("--dropout", type=float, default=0.3)
    p.add_argument("--loss-weights", choices=["none", "local", "global"], default="none"); p.add_argument("--cw-power", type=float, default=0.5)
    p.add_argument("--prox-mu", type=float, default=0.01)
    p.add_argument("--cluster-mode", choices=["agglom", "random", "singleton"], default="agglom")
    p.add_argument("--distance", choices=["jsd", "jsd-log", "jsd-invfreq"], default="jsd")
    p.add_argument("--blend", type=float, default=0.0); p.add_argument("--sybil", action="store_true")
    p.add_argument("--hetero", default="label", help="comma list of: label, quantity, feature")
    p.add_argument("--feature-shift", type=float, default=0.5); p.add_argument("--quantity-alpha", type=float, default=0.5)
    p.add_argument("--train"); p.add_argument("--test")
    p.add_argument("--no-select-best", action="store_true", help="evaluate the last round instead of the best validation round (uploaded datasets)"); p.add_argument("--no-auto-log", action="store_true", help="disable the automatic log transform of skewed columns (uploaded datasets)"); p.add_argument("--dataset-file"); p.add_argument("--label-col"); p.add_argument("--class-map"); p.add_argument("--test-frac", type=float, default=0.2)
    p.add_argument("--save-model", default=None, help="directory to store the final model for the Detect tab")
    p.add_argument("--max-train", type=int, default=None); p.add_argument("--max-test", type=int, default=None)
    return p

if __name__ == "__main__":
    try: run(parser().parse_args())
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"}); sys.exit(1)
