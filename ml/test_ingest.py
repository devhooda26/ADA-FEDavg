"""Tests for ml/ingest.py. Run from the ml/ directory:  python -m unittest test_ingest -v"""
import csv, gzip, io, json, os, subprocess, sys, tempfile, unittest, zipfile
import numpy as np
import ingest

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    import openpyxl
except ImportError:
    openpyxl = None
try:
    import pyarrow  # noqa: F401
    import pyarrow.parquet as pq
    HAVE_ARROW = True
except ImportError:
    HAVE_ARROW = False


def make_rows(n=900, seed=0):
    """Three separable classes with numeric, categorical and datetime columns, plus some NA values."""
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        c = i % 3
        proto = ["tcp", "udp", "icmp"][(c + rng.integers(0, 2)) % 3]
        rows.append({"duration": round(float(rng.normal(c * 2, 0.7)), 4), "bytes": int(rng.normal(500 + 400 * c, 60)),
                     "rate": round(float(rng.normal(-c, 0.5)), 4), "proto": proto,
                     "seen": f"2024-03-{1 + i % 28:02d}T10:00:00", "label": ["normal", "scan", "flood"][c]})
    return rows


HEADER = ["duration", "bytes", "rate", "proto", "seen", "label"]


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.reader(f))


class IngestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.rows = make_rows()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, data):
        p = os.path.join(self.dir, name)
        with open(p, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
        return p

    def conv(self, name, data, **kw):
        p = self.write(name, data)
        out = os.path.join(self.dir, "out.csv")
        info = ingest.convert(p, out, name, **kw)
        return info, read_csv(out)

    def as_csv(self, delim=","):
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=delim, lineterminator="\n")
        w.writerow(HEADER)
        for r in self.rows:
            w.writerow([r[h] for h in HEADER])
        return buf.getvalue()


class Formats(IngestBase):
    def check_table(self, info, table):
        self.assertEqual(table[0], HEADER)
        self.assertEqual(len(table) - 1, len(self.rows))
        self.assertEqual(info["rows"], len(self.rows))
        self.assertEqual(table[1][5], "normal")
        self.assertEqual(float(table[1][0]), self.rows[0]["duration"])

    def test_csv(self):
        info, t = self.conv("a.csv", self.as_csv())
        self.check_table(info, t)

    def test_tsv_semicolon_pipe(self):
        for d, name in (("\t", "a.tsv"), (";", "a.csv"), ("|", "a.txt")):
            info, t = self.conv(name, self.as_csv(d))
            self.check_table(info, t)

    def test_whitespace_txt(self):
        text = "\n".join(["duration bytes rate proto seen label"] + [" ".join(str(r[h]) for h in HEADER) for r in self.rows])
        info, t = self.conv("a.txt", text)
        self.check_table(info, t)

    def test_utf8_bom_and_cp1252(self):
        info, t = self.conv("a.csv", b"\xef\xbb\xbf" + self.as_csv().encode())
        self.assertEqual(t[0][0], "duration")
        text = self.as_csv().replace("normal", "norm\u00e9l").encode("cp1252")
        info, t = self.conv("b.csv", text)
        self.assertTrue(any("Windows-1252" in n for n in info["notes"]))

    def test_json_array_of_objects(self):
        info, t = self.conv("a.json", json.dumps(self.rows))
        self.check_table(info, t)

    def test_json_wrapped_and_columnar_and_keyed(self):
        info, t = self.conv("w.json", json.dumps({"meta": {"x": 1}, "data": self.rows}))
        self.check_table(info, t)
        cols = {h: [r[h] for r in self.rows] for h in HEADER}
        info, t = self.conv("c.json", json.dumps(cols))
        self.check_table(info, t)
        keyed = {f"r{i}": r for i, r in enumerate(self.rows)}
        info, t = self.conv("k.json", json.dumps(keyed))
        self.assertEqual(t[0][0], "_key")
        self.assertEqual(len(t) - 1, len(self.rows))

    def test_json_array_of_arrays(self):
        data = [HEADER] + [[r[h] for h in HEADER] for r in self.rows]
        info, t = self.conv("a.json", json.dumps(data))
        self.check_table(info, t)
        info, t = self.conv("b.json", json.dumps([[r[h] for h in HEADER[:3]] for r in self.rows]))
        self.assertEqual(t[0], ["col_1", "col_2", "col_3"])

    def test_json_nested_flattened(self):
        recs = [{"id": i, "net": {"bytes": i * 2, "proto": "tcp"}, "label": "a" if i % 2 else "b"} for i in range(50)]
        info, t = self.conv("n.json", json.dumps(recs))
        self.assertEqual(t[0], ["id", "net.bytes", "net.proto", "label"])

    def test_jsonl_and_json_lines_in_json_file(self):
        lines = "\n".join(json.dumps(r) for r in self.rows)
        for name in ("a.jsonl", "a.ndjson", "a.json"):
            info, t = self.conv(name, lines)
            self.check_table(info, t)

    def test_jsonl_skips_bad_lines(self):
        lines = "\n".join(json.dumps(r) for r in self.rows[:20]) + "\nnot json\n"
        info, t = self.conv("a.jsonl", lines)
        self.assertEqual(len(t) - 1, 20)
        self.assertTrue(any("invalid JSON lines" in n for n in info["notes"]))

    @unittest.skipIf(openpyxl is None, "openpyxl not installed")
    def test_xlsx(self):
        wb = openpyxl.Workbook()
        ws0 = wb.active
        ws0.title = "notes"
        ws0.append(["readme"])
        ws0.append(["nothing here"])
        ws = wb.create_sheet("data")
        ws.append(HEADER)
        for r in self.rows:
            ws.append([r[h] for h in HEADER])
        buf = io.BytesIO()
        wb.save(buf)
        info, t = self.conv("a.xlsx", buf.getvalue())
        self.check_table(info, t)
        self.assertEqual(info["format"], "Excel workbook")

    def test_arff(self):
        lines = ["% comment", "@relation demo", "@attribute duration numeric", "@attribute bytes numeric", "@attribute rate numeric",
                 "@attribute 'proto' {tcp,udp,icmp}", "@attribute seen string", "@attribute label {normal,scan,flood}", "@data"]
        lines += [",".join(str(r[h]) for h in HEADER) for r in self.rows]
        info, t = self.conv("a.arff", "\n".join(lines))
        self.check_table(info, t)

    def test_arff_missing_and_sparse(self):
        text = "@relation d\n@attribute a numeric\n@attribute b {x,y}\n@data\n1,x\n?,y\n"
        _, t = self.conv("m.arff", text)
        self.assertEqual(t[2], ["", "y"])
        with self.assertRaises(ingest.IngestError):
            self.conv("s.arff", "@relation d\n@attribute a numeric\n@attribute b numeric\n@data\n{0 1}\n")

    @unittest.skipUnless(HAVE_ARROW, "pyarrow not installed (optional)")
    def test_parquet(self):
        import pyarrow as pa
        tbl = pa.table({h: [r[h] for r in self.rows] for h in HEADER})
        buf = io.BytesIO()
        pq.write_table(tbl, buf)
        info, t = self.conv("a.parquet", buf.getvalue())
        self.check_table(info, t)

    def test_gzip_and_zip(self):
        info, t = self.conv("a.csv.gz", gzip.compress(self.as_csv().encode()))
        self.check_table(info, t)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("__MACOSX/._x.csv", "junk")
            z.writestr("data/export.json", json.dumps(self.rows))
        info, t = self.conv("bundle.zip", buf.getvalue())
        self.check_table(info, t)

    def test_zip_with_two_data_files_is_rejected(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("a.csv", self.as_csv())
            z.writestr("b.csv", self.as_csv())
        with self.assertRaisesRegex(ingest.IngestError, "2 data files"):
            self.conv("two.zip", buf.getvalue())

    def test_zip_path_traversal_name_is_harmless(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("../../evil.csv", self.as_csv())
        info, t = self.conv("t.zip", buf.getvalue())
        self.check_table(info, t)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "..", "..", "evil.csv")))

    def test_decompression_bomb_is_capped(self):
        bomb = gzip.compress(b"a,b\n" + b"1,2\n" * 2_000_000)  # ~8 MB expanded, tiny compressed
        with self.assertRaisesRegex(ingest.IngestError, "larger than"):
            self.conv("bomb.csv.gz", bomb, max_mb=1)  # limit = 3 MB


class Normalisation(IngestBase):
    def test_nulls_and_infinity_in_numeric_columns(self):
        text = "a,b,label\n" + "\n".join(f"{i},{'NA' if i % 10 == 0 else 'Infinity' if i % 7 == 0 else i * 1.5},{'x' if i % 2 else 'y'}" for i in range(1, 300))
        info, t = self.conv("n.csv", text)
        col = [r[1] for r in t[1:]]
        self.assertNotIn("NA", col)
        self.assertNotIn("Infinity", col)
        self.assertIn("", col)

    def test_labels_named_none_are_preserved(self):
        text = "a,label\n" + "\n".join(f"{i},{'None' if i % 2 else 'attack'}" for i in range(100))
        _, t = self.conv("l.csv", text)
        self.assertEqual({r[1] for r in t[1:]}, {"None", "attack"})

    def test_datetime_to_epoch(self):
        _, t = self.conv("d.csv", self.as_csv())
        self.assertTrue(t[1][4].isdigit())
        self.assertEqual(int(t[1][4]), 1709287200)  # 2024-03-01T10:00:00Z

    def test_headerless_generic(self):
        text = "\n".join(f"{i},{i * 2},{i % 3}" for i in range(100))
        info, t = self.conv("h.csv", text)
        self.assertEqual(t[0], ["col_1", "col_2", "col_3"])
        self.assertEqual(len(t) - 1, 100)

    def test_headerless_nsl_kdd(self):
        row = ["0", "tcp", "http", "SF"] + ["1"] * 37 + ["normal", "20"]
        info, t = self.conv("KDDTrain+.txt", "\n".join([",".join(row)] * 50))
        self.assertEqual(t[0][1:4], ["protocol_type", "service", "flag"])
        self.assertEqual(t[0][-2:], ["label", "difficulty"])
        self.assertEqual(len(t) - 1, 50)

    def test_duplicate_and_empty_headers(self):
        text = "a,a,,label\n" + "\n".join(f"{i},{i},{i},{'x' if i % 2 else 'y'}" for i in range(30))
        _, t = self.conv("d.csv", text)
        self.assertEqual(len(set(t[0])), 4)

    def test_ragged_rows_skipped_and_reported(self):
        text = "a,b,label\n1,2,x\n3,y\n4,5,y\n"
        info, t = self.conv("r.csv", text)
        self.assertEqual(len(t) - 1, 2)
        self.assertTrue(any("wrong number" in n for n in info["notes"]))

    def test_quoted_newlines_and_commas_survive(self):
        text = 'a,note,label\n1,"hello, world\nsecond line",x\n2,plain,y\n'
        _, t = self.conv("q.csv", text)
        self.assertEqual(t[1][1], "hello, world\nsecond line")


class Rejections(IngestBase):
    def test_friendly_errors_for_unsupported_types(self):
        cases = {
            "cap.pcap": (b"\xd4\xc3\xb2\xa1" + b"\x00" * 100, "packet capture"),
            "old.xls": (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 100, "xls"),
            "doc.pdf": (b"%PDF-1.7 hello", "PDF"),
            "pic.png": (b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, "Images"),
            "blob.bin": (bytes(range(256)) * 4, "binary"),
            "empty.csv": (b"   \n", "empty"),
            "one.csv": (b"a\n1\n2\n", "one column"),
            "fake.xlsx": (b"hello,world\n1,2\n", "not a valid Excel"),
        }
        for name, (data, frag) in cases.items():
            with self.subTest(name), self.assertRaisesRegex(ingest.IngestError, frag):
                self.conv(name, data)

    def test_docx_zip_rejected(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("word/document.xml", "<x/>")
        with self.assertRaisesRegex(ingest.IngestError, "Word"):
            self.conv("a.zip", buf.getvalue())

    def test_cli_returns_json_error(self):
        p = self.write("x.pcap", b"\xd4\xc3\xb2\xa1" + b"\x00" * 50)
        r = subprocess.run([sys.executable, os.path.join(HERE, "ingest.py"), p, os.path.join(self.dir, "o.csv"), "x.pcap"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("packet capture", json.loads(r.stdout)["error"])


class EndToEnd(IngestBase):
    """Upload in several formats -> profile -> federated training -> saved model. Real code, no mocks."""

    def run_pipeline(self, name, data):
        p = self.write(name, data)
        csv_path = os.path.join(self.dir, "norm.csv")
        r = subprocess.run([sys.executable, os.path.join(HERE, "ingest.py"), p, csv_path, name, "50"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        prof = subprocess.run([sys.executable, os.path.join(HERE, "profile_dataset.py"), csv_path, "label"], capture_output=True, text=True, cwd=HERE)
        self.assertEqual(prof.returncode, 0, prof.stdout)
        prof = json.loads(prof.stdout)
        kinds = {c["name"]: c["kind"] for c in prof["columns"]}
        self.assertEqual(kinds["duration"], "numeric")
        self.assertEqual(kinds["proto"], "categorical")
        self.assertIn("label", prof["labelCandidates"])
        cmap = os.path.join(self.dir, "map.json")
        with open(cmap, "w") as f:
            json.dump({"normal": "benign", "scan": "probe", "flood": "dos"}, f)
        model_dir = os.path.join(self.dir, "model")
        t = subprocess.run([sys.executable, os.path.join(HERE, "ada_fedavg.py"), "--method", "ada", "--rounds", "30", "--clients", "4", "--clusters", "2",
                            "--dataset-file", csv_path, "--label-col", "label", "--class-map", cmap, "--save-model", model_dir],
                           capture_output=True, text=True, cwd=HERE, timeout=300)
        self.assertEqual(t.returncode, 0, t.stdout[-600:] + t.stderr[-600:])
        events = [json.loads(l) for l in t.stdout.splitlines() if l.startswith("{")]
        res = [e for e in events if e.get("type") == "result"]
        self.assertTrue(res, "no result event")
        return res[0], model_dir

    def test_train_from_json(self):
        res, model_dir = self.run_pipeline("flows.json", json.dumps(self.rows))
        acc = res["test"]["accuracy"]
        self.assertGreater(acc, 0.9, f"accuracy {acc}")  # separable classes; 3-class chance is 0.33
        self.assertTrue(os.path.isdir(model_dir) and os.listdir(model_dir))

    @unittest.skipIf(openpyxl is None, "openpyxl not installed")
    def test_train_from_xlsx(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(HEADER)
        for r in self.rows:
            ws.append([r[h] for h in HEADER])
        buf = io.BytesIO()
        wb.save(buf)
        res, _ = self.run_pipeline("flows.xlsx", buf.getvalue())
        self.assertGreater(res["test"]["accuracy"], 0.9)

    def test_train_from_gzipped_jsonl(self):
        res, _ = self.run_pipeline("flows.jsonl.gz", gzip.compress("\n".join(json.dumps(r) for r in self.rows).encode()))
        self.assertGreater(res["test"]["accuracy"], 0.9)


if __name__ == "__main__":
    unittest.main()


class SparseColumns(IngestBase):
    def test_mostly_empty_column_is_dropped_not_every_row(self):
        import ada_fedavg as A
        lines = ["a,b,sparse,label"] + [f"{i},{i % 7},{'' if i % 4 else 1.5},{'x' if i % 2 else 'y'}" for i in range(400)]
        p = self.write("s.csv", "\n".join(lines))
        cat, X, y, info = A.load_table(p, "label", {"x": "x", "y": "y"})
        self.assertEqual(len(y), 400)
        self.assertEqual(X.shape[1], 1)  # "a" is a row id (ignored), "sparse" is dropped, "b" is kept
        self.assertTrue(any(d["name"] == "sparse" for d in info["dropped_columns"]))
