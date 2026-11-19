import unittest, numpy as np
import ada_fedavg as A

class T(unittest.TestCase):
    def test_jsd(self):
        p, q = np.array([1, 0, 0, 0, 0.]), np.array([0, 1, 0, 0, 0.])
        self.assertAlmostEqual(A.js_divergence(p, q), 1.0); self.assertAlmostEqual(A.js_divergence(p, p), 0.0)
        r = np.random.default_rng(0).dirichlet(np.ones(5), 2); self.assertAlmostEqual(A.js_divergence(r[0], r[1]), A.js_divergence(r[1], r[0]))
    def test_clustering_groups_similar(self):
        d = [[.9, .1, 0, 0, 0], [.88, .12, 0, 0, 0], [0, .1, .9, 0, 0], [0, .12, .88, 0, 0], [0, 0, 0, .5, .5]]
        l = A.cluster_clients(d, 3); self.assertEqual(l[0], l[1]); self.assertEqual(l[2], l[3]); self.assertEqual(len(set(l)), 3)
    def test_two_stage(self):
        s = [{"w": np.array([1.], np.float32)}, {"w": np.array([3.], np.float32)}, {"w": np.array([10.], np.float32)}]
        out = A.two_stage_aggregate(s, [1, 3, 100], [0, 0, 1])  # cluster0=(1*1+3*3)/4=2.5 ; cluster1=10 ; equal -> 6.25
        self.assertAlmostEqual(float(out["w"][0]), 6.25, 5)
        self.assertAlmostEqual(float(A.fedavg_aggregate(s, [1, 3, 100])["w"][0]), (1 + 9 + 1000) / 104, 4)
    def test_partition_reproducible(self):
        y = np.random.default_rng(1).integers(0, 5, 4000)
        a = A.dirichlet_partition(y, 8, .5, np.random.default_rng(7)); b = A.dirichlet_partition(y, 8, .5, np.random.default_rng(7))
        self.assertTrue(all((x == z).all() for x, z in zip(a, b))); self.assertEqual(sum(len(x) for x in a), len(y))
    def test_gradcheck(self):
        rng = np.random.default_rng(0); S = {k: v.astype(np.float64) for k, v in A.init_model(rng, 6, (5, 4), 3).items()}
        X, y = rng.standard_normal((16, 6)), rng.integers(0, 3, 16)
        _, G = A.loss_grads({k: v.copy() for k, v in S.items()}, X, y, None, 0.0)
        for k in ["W0", "g1", "e0", "Wo", "b1"]:
            i = (0,) * S[k].ndim; h = 1e-6
            P, M = {a: b.copy() for a, b in S.items()}, {a: b.copy() for a, b in S.items()}; P[k][i] += h; M[k][i] -= h
            num = (A.loss_grads(P, X, y)[0] - A.loss_grads(M, X, y)[0]) / (2 * h)
            self.assertAlmostEqual(float(G[k][i]), num, places=5, msg=k)
if __name__ == "__main__": unittest.main()

class T2(unittest.TestCase):
    def test_weighted_gradcheck(self):
        rng = np.random.default_rng(3); S = {k: v.astype(np.float64) for k, v in A.init_model(rng, 6, (5, 4), 3).items()}
        X, y = rng.standard_normal((20, 6)), rng.integers(0, 3, 20); cw = np.array([0.5, 2.0, 5.0])
        _, G = A.loss_grads({k: v.copy() for k, v in S.items()}, X, y, None, 0.0, cw)
        for k in ["W0", "Wo", "e1"]:
            i = (0,) * S[k].ndim; h = 1e-6
            P, M = {a: b.copy() for a, b in S.items()}, {a: b.copy() for a, b in S.items()}; P[k][i] += h; M[k][i] -= h
            self.assertAlmostEqual(float(G[k][i]), (A.loss_grads(P, X, y, None, 0.0, cw)[0] - A.loss_grads(M, X, y, None, 0.0, cw)[0]) / (2 * h), places=5)
    def test_blend_interpolates_between_paper_and_fedavg(self):
        s = [{"w": np.array([v], np.float32)} for v in (1., 3., 10.)]; sz, lab = [1, 3, 100], [0, 0, 1]
        self.assertAlmostEqual(float(A.two_stage_aggregate(s, sz, lab, 0.0)["w"][0]), 6.25, 4)
        self.assertAlmostEqual(float(A.two_stage_aggregate(s, sz, lab, 1.0)["w"][0]), float(A.fedavg_aggregate(s, sz)["w"][0]), 4)
    def test_singleton_clusters_equal_uniform_client_weights(self):
        s = [{"w": np.array([v], np.float32)} for v in (1., 3., 10.)]
        self.assertAlmostEqual(float(A.two_stage_aggregate(s, [1, 3, 100], [0, 1, 2])["w"][0]), 14 / 3, 4)
    def test_prox_pulls_towards_reference(self):
        rng = np.random.default_rng(0); S0 = A.init_model(rng, 6, (8,), 3); X, y = rng.standard_normal((200, 6)).astype(np.float32), rng.integers(0, 3, 200)
        def dist(mu):
            L = {k: v.copy() for k, v in S0.items()}; A.train_epochs(L, X, y, np.random.default_rng(1), 3, 32, 0.0, prox=(mu, S0) if mu else None)
            return sum(float(np.abs(L[k] - S0[k]).sum()) for k in A.TRAINABLE(S0))
        self.assertLess(dist(50.0), dist(0.0))
    def test_invfreq_distance_exposes_rare_presence(self):
        g = np.array([.6, .38, .01, .009, .001]); a_, b_, c_ = [.899, .1, .001, 0, 0], [.9, .1, 0, 0, 0], [.8, .2, 0, 0, 0]
        raw = lambda x, y: A.js_divergence(x, y)
        r1 = raw(a_, b_) / raw(b_, c_)
        F = A.feat_dists([a_, b_, c_], "jsd-invfreq", g); r2 = A.js_divergence(F[0], F[1]) / A.js_divergence(F[1], F[2])
        self.assertGreater(r2, r1 * 5)
    def test_quantity_skew_and_reproducibility(self):
        y = np.random.default_rng(1).integers(0, 5, 6000)
        a = A.make_partition(y, 8, 1.0, np.random.default_rng(5), ("label", "quantity"), 0.3); b = A.make_partition(y, 8, 1.0, np.random.default_rng(5), ("label", "quantity"), 0.3)
        self.assertTrue(all((p == q).all() for p, q in zip(a, b)))
        u = A.make_partition(y, 8, 1.0, np.random.default_rng(5), ("label",)); self.assertGreater(np.std([len(p) for p in a]), np.std([len(p) for p in u]))
    def test_far_and_detection(self):
        A.CLASSES[:] = ["benign", "dos", "probe", "r2l", "u2r"]
        y = np.array([0, 0, 0, 0, 1, 1, 2, 2]); p = np.array([0, 0, 1, 0, 1, 0, 2, 2]); m = A.metrics(y, p)
        self.assertAlmostEqual(m["false_alarm_rate"], 0.25); self.assertAlmostEqual(m["attack_detection_rate"], 0.75)

import os, subprocess, sys, json
D = os.path.join(os.path.dirname(__file__), "..", "data", "nsl-kdd")
@unittest.skipUnless(os.path.exists(os.path.join(D, "KDDTrain+.txt")), "NSL-KDD not installed")
class Smoke(unittest.TestCase):
    def run_w(self, *extra):
        out = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "ada_fedavg.py"), "--rounds", "1", "--max-train", "4000", "--max-test", "3000",
                              "--train", os.path.join(D, "KDDTrain+.txt"), "--test", os.path.join(D, "KDDTest+.txt"), *extra], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout[-300:] + out.stderr[-300:]); return json.loads(out.stdout.strip().split("\n")[-1])
    def test_all_methods_and_options(self):
        for extra in (["--method", "centralized", "--loss-weights", "global"], ["--method", "fedavg"], ["--method", "fedprox"], ["--method", "ifca", "--clusters", "3"],
                      ["--method", "ada", "--cluster-mode", "random"], ["--method", "ada", "--cluster-mode", "singleton"], ["--method", "ada", "--distance", "jsd-log", "--blend", "0.5"],
                      ["--method", "ada", "--sybil", "--hetero", "label,quantity,feature", "--clients", "12", "--clusters", "4", "--partition-seed", "9"]):
            r = self.run_w(*extra); self.assertIn("generalization", r); self.assertIn("false_alarm_rate", r["test"])
            self.assertGreaterEqual(r["generalization"]["test21"]["n"], 1)
if __name__ == "__main__": unittest.main()

import tempfile, predict as PR
class Predict(unittest.TestCase):
    def setUp(self):
        A.CLASSES[:] = ["benign", "dos", "probe", "r2l", "u2r"]
        rng = np.random.default_rng(0); self.cat = [["tcp", "http"], ["udp", "dns"], ["tcp", "ftp"]] * 20
        self.num = rng.standard_normal((60, 3)).astype(np.float32) * 5 + 10
        self.prep = A.Prep(clip=20).fit(self.cat, self.num); self.prep.num_names = ["a", "b", "c"]; self.prep.cat_names = ["proto", "svc"]
        self.S = A.init_model(rng, 3 + sum(len(v) for v in self.prep.vocab)); self.dir = tempfile.mkdtemp(); A.save_model(self.dir, self.S, self.prep, A.CLASSES, {"dataset": "t"})
    def test_roundtrip_matches_training_pipeline(self):
        recs = [{"a": float(self.num[i, 0]), "b": str(self.num[i, 1]), "c": float(self.num[i, 2]), "proto": self.cat[i][0], "svc": self.cat[i][1]} for i in range(6)]
        out = PR.predict_records(self.dir, recs)["results"]
        ref = A.forward(self.S, self.prep.transform(self.cat[:6], self.num[:6]), False)[0].argmax(1)
        self.assertEqual([r["class"] for r in out], [A.CLASSES[i] for i in ref]); self.assertAlmostEqual(sum(out[0]["probabilities"].values()), 1.0, 5)
    def test_bad_input_is_reported_not_crashing(self):
        out = PR.predict_records(self.dir, [{"a": "abc", "b": 1, "c": 1, "proto": "tcp", "svc": "http"}, {"a": 1, "b": float("inf"), "c": 1}, "oops", {"a": 1, "b": 2, "c": 3, "proto": "zzz", "svc": "http"}, {}])["results"]
        self.assertIn("not a number", out[0]["error"]); self.assertIn("not finite", out[1]["error"]); self.assertIn("object", out[2]["error"])
        self.assertTrue(any("unknown value" in w for w in out[3]["warnings"])); self.assertTrue(any("missing numeric" in w for w in out[4]["warnings"]))
if __name__ == "__main__": unittest.main()
