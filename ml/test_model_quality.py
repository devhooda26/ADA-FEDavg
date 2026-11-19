"""Tests for the preprocessing and model-selection improvements. Run from ml/:  python -m unittest test_model_quality -v"""
import json, os, subprocess, sys, tempfile, unittest
import numpy as np
import ada_fedavg as A
import predict as P

HERE = os.path.dirname(os.path.abspath(__file__))


class AutoLog(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(0)
        n = 2000
        self.num = np.column_stack([rng.lognormal(5, 2, n),            # heavy right tail, non-negative -> log
                                    rng.normal(0, 1, n),                # symmetric -> untouched
                                    rng.lognormal(3, 2, n) - 50,        # skewed but has negatives -> untouched
                                    rng.poisson(0.05, n)]).astype(np.float32)  # rare counts, skewed, non-negative -> log
        self.cat = [["tcp"]] * n

    def test_only_skewed_nonnegative_columns_are_logged(self):
        p = A.Prep(clip=20, auto_log=True).fit(self.cat, self.num)
        self.assertEqual(p.log.tolist(), [True, False, False, True])

    def test_off_by_default_and_identical_to_old_behaviour(self):
        p = A.Prep(clip=20).fit(self.cat, self.num)
        self.assertFalse(p.log.any())
        z = (self.num - self.num.mean(0)) / (self.num.std(0) + 1e-6)
        np.testing.assert_allclose(p.transform(self.cat, self.num)[:, :4], np.clip(z, -20, 20), rtol=1e-3, atol=1e-3)

    def test_log_makes_heavy_tail_well_scaled(self):
        raw = A.Prep(clip=None).fit(self.cat, self.num).transform(self.cat, self.num)[:, 0]
        log = A.Prep(clip=None, auto_log=True).fit(self.cat, self.num).transform(self.cat, self.num)[:, 0]
        self.assertGreater(np.abs(raw).max(), 20)          # one huge value squashes everything else
        self.assertLess(np.abs(log).max(), 6)

    def test_detect_applies_exactly_the_training_transform(self):
        prep = A.Prep(clip=20, auto_log=True).fit(self.cat, self.num)
        prep.num_names, prep.cat_names = ["bytes", "sym", "neg", "count"], ["proto"]
        with tempfile.TemporaryDirectory() as d:
            S = A.init_model(np.random.default_rng(1), 5, n_out=2)
            A.save_model(d, S, prep, ["a", "b"], {})
            S2, doc = P.load(d)
            self.assertEqual([f["log"] for f in doc["numeric"]], [True, False, False, True])
            recs = [{"bytes": float(self.num[i, 0]), "sym": float(self.num[i, 1]), "neg": float(self.num[i, 2]), "count": float(self.num[i, 3]), "proto": "tcp"} for i in range(5)]
            X, meta = P.encode(doc, recs)
            np.testing.assert_allclose(X, prep.transform(self.cat[:5], self.num[:5]), rtol=1e-4, atol=1e-4)

    def test_old_saved_models_without_log_key_still_load(self):
        doc = {"numeric": [{"name": "a", "mean": 1.0, "std": 2.0}], "categorical": [], "clip": 20}
        X, _ = P.encode(doc, [{"a": 5.0}])
        self.assertAlmostEqual(float(X[0, 0]), 2.0, places=5)


class SelectBest(unittest.TestCase):
    def run_cli(self, *extra, rounds=30):
        rng = np.random.default_rng(3)
        d = self.tmp.name
        p = os.path.join(d, "d.csv")
        with open(p, "w") as f:
            f.write("a,b,label\n")
            for i in range(900):
                c = i % 3
                f.write(f"{rng.normal(c * 2, 0.8):.4f},{rng.normal(-c, 1):.4f},{['x', 'y', 'z'][c]}\n")
        m = os.path.join(d, "m.json")
        with open(m, "w") as f:
            json.dump({"x": "x", "y": "y", "z": "z"}, f)
        r = subprocess.run([sys.executable, os.path.join(HERE, "ada_fedavg.py"), "--method", "ada", "--rounds", str(rounds), "--clients", "4", "--clusters", "2",
                            "--dataset-file", p, "--label-col", "label", "--class-map", m, *extra], capture_output=True, text=True, cwd=HERE, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout[-400:] + r.stderr[-400:])
        return [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_selected_round_is_the_best_validation_round(self):
        ev = self.run_cli()
        res = [e for e in ev if e.get("type") == "result"][0]
        hist = {e["round"]: e["val_macro_f1"] for e in ev if e.get("stage") == "training"}
        best = max(hist.values())
        self.assertEqual(hist[res["selected_round"]], best)
        self.assertEqual(min(r for r, v in hist.items() if v == best), res["selected_round"])  # earliest best round wins ties
        self.assertEqual(res["rounds_run"], 30)

    def test_opt_out_keeps_last_round(self):
        res = [e for e in self.run_cli("--no-select-best") if e.get("type") == "result"][0]
        self.assertEqual(res["selected_round"], 30)


if __name__ == "__main__":
    unittest.main()
