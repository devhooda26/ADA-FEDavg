#!/usr/bin/env python3
"""Universal tabular ingestion for the ADA-FedAvg platform.

Usage:  ingest.py INPUT OUTPUT.csv [ORIGINAL_FILENAME] [MAX_MB]
Prints ONE JSON object on stdout:
    {"format": "...", "rows": N, "columns": M, "notes": [...]}      (exit 0)
    {"error": "..."}                                                  (exit 1)

Turns an uploaded file into the normalized CSV that the rest of the pipeline (profiling, label
mapping, federated training, Detect) already understands. Supported inputs:

    CSV / TSV / TXT / DAT   comma, tab, semicolon, pipe or whitespace separated; header optional
                            (the headerless 43-column NSL-KDD layout is recognised)
    JSON                    array of objects, array of arrays, {"data": [...]}, column-oriented
                            {"col": [...]}, or an object keyed by id; nested objects are flattened
    JSONL / NDJSON          one JSON object per line
    XLSX / XLSM             first sheet with data (largest wins); needs openpyxl
    ARFF                    Weka format (dense); nominal attributes become categories
    PARQUET                 only if the optional 'pyarrow' package is installed
    .gz / .zip              wrapping exactly one of the formats above

The file is only ever PARSED. Nothing inside it is executed, and archive member names are never
used as paths (members are read into memory with a size cap).

Not supported, with a clear message: legacy .xls, raw packet captures (pcap), images, audio, PDF.
Those are not tabular; for traffic captures extract flow records first (CICFlowMeter, Zeek, tshark).
"""
import csv, gzip, io, json, math, re, sys, zipfile
from datetime import datetime, timezone

MAX_COLS = 1000
NULL_TOKENS = {"", "na", "n/a", "nan", "null", "none", "nil", "?", "#n/a", "#na", "missing"}
INF_TOKENS = {"inf", "+inf", "-inf", "infinity", "+infinity", "-infinity"}
DATA_EXT = {".csv", ".tsv", ".txt", ".dat", ".data", ".json", ".jsonl", ".ndjson", ".xlsx", ".xlsm", ".arff", ".parquet"}
ISO_DT = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$")


class IngestError(Exception):
    pass


# ----------------------------------------------------------------------------- helpers
def _ext(name):
    name = (name or "").lower()
    i = name.rfind(".")
    return name[i:] if i >= 0 else ""


def _is_num(s):
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def _decode(b, notes):
    """bytes -> str. Handles UTF-8/16 BOMs; falls back to cp1252 (never fails)."""
    if b.startswith(b"\xef\xbb\xbf"):
        return b[3:].decode("utf-8", "replace")
    if b.startswith((b"\xff\xfe", b"\xfe\xff")):
        return b.decode("utf-16", "replace")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        notes.append("File is not UTF-8; decoded as Windows-1252 (some characters may differ).")
        return b.decode("cp1252", "replace")


def _cell(v):
    """Any Python value -> CSV string."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return ""
        return str(int(v)) if v.is_integer() and abs(v) < 1e15 else repr(v)
    if isinstance(v, datetime):
        return v.isoformat()
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8", "replace")
    if isinstance(v, (dict, list, tuple)):
        return json.dumps(v, ensure_ascii=False, default=str, separators=(",", ":"))
    return str(v)


def _flatten(obj, prefix="", out=None, depth=0):
    """Nested dict -> {"a.b": value}. Lists and very deep structures are kept as JSON text."""
    out = {} if out is None else out
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict) and v and depth < 4:
            _flatten(v, key, out, depth + 1)
        else:
            out[key] = v
    return out


# ----------------------------------------------------------------------------- byte-level detection
def sniff(data, name):
    """Return a format key from magic bytes first, then extension, then content."""
    if data[:2] == b"\x1f\x8b":
        return "gzip"
    if data[:4] == b"PAR1":
        return "parquet"
    if data[:4] == b"PK\x03\x04" or data[:4] == b"PK\x05\x06":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
            if "[Content_Types].xml" in names and any(n.startswith("xl/") for n in names):
                return "xlsx"
            if any(n.startswith(("word/", "ppt/")) for n in names):
                raise IngestError("This is a Word or PowerPoint file, not a data table. Export your data as CSV or XLSX.")
        except zipfile.BadZipFile:
            raise IngestError("The file looks like a ZIP archive but is damaged.")
        return "zip"
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise IngestError("Legacy .xls (or other old Office) files are not supported. In Excel choose Save As > CSV or .xlsx.")
    if data[:4] in (b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4", b"\x0a\x0d\x0d\x0a", b"\x4d\x3c\xb2\xa1"):
        raise IngestError("This is a packet capture (pcap). It is raw traffic, not a table of features. Extract flow records "
                          "first (for example with CICFlowMeter, Zeek or tshark) and upload the resulting CSV.")
    if data[:5] == b"%PDF-":
        raise IngestError("PDF files are not data tables. Upload CSV, TSV, JSON, JSONL, XLSX or ARFF.")
    if data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff" or data[:4] in (b"GIF8", b"RIFF", b"OggS", b"fLaC") or data[4:8] == b"ftyp":
        raise IngestError("Images, audio and video are not supported. This platform trains on tabular records.")
    ext = _ext(name)
    if ext in (".xlsx", ".xlsm"):
        raise IngestError("This file is named .xlsx but is not a valid Excel workbook.")
    if ext == ".xls":
        raise IngestError("Legacy .xls files are not supported. In Excel choose Save As > CSV or .xlsx.")
    if ext == ".parquet":
        raise IngestError("This file is named .parquet but is not a valid Parquet file.")
    if ext in (".jsonl", ".ndjson"):
        return "jsonl"
    if ext == ".json":
        return "json"
    if ext == ".arff":
        return "arff"
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head[:1] in (b"[", b"{"):
        return "json"  # a JSON document; JSON Lines is tried as a fallback inside the JSON reader
    if b"@attribute" in data[:20000].lower():
        return "arff"
    if b"\x00" in data[:8192] and not data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        raise IngestError("This file looks binary, not text. Upload CSV, TSV, JSON, JSONL, XLSX or ARFF.")
    return "delimited"


def unwrap(data, name, limit, notes, depth=0):
    """Resolve .gz / .zip wrappers; return (bytes, name, format)."""
    if depth > 2:
        raise IngestError("Archives nested too deeply.")
    fmt = sniff(data, name)
    if fmt == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as g:
            inner = g.read(limit + 1)
        if len(inner) > limit:
            raise IngestError(f"The decompressed file is larger than {limit // 1048576} MB.")
        inner_name = name[:-3] if name.lower().endswith(".gz") else name
        notes.append("Decompressed gzip.")
        return unwrap(inner, inner_name, limit, notes, depth + 1)
    if fmt == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            members = [i for i in z.infolist() if not i.is_dir() and not i.filename.startswith("__MACOSX/")
                       and not i.filename.split("/")[-1].startswith(".") and _ext(i.filename) in DATA_EXT]
            if not members:
                raise IngestError("The ZIP archive contains no supported data file (csv, tsv, txt, json, jsonl, xlsx, arff, parquet).")
            if len(members) > 1:
                shown = ", ".join(m.filename.split("/")[-1] for m in members[:5])
                raise IngestError(f"The ZIP archive contains {len(members)} data files ({shown}). Upload one file at a time, or one file per ZIP.")
            m = members[0]
            if m.file_size > limit:
                raise IngestError(f"The file inside the ZIP is larger than {limit // 1048576} MB.")
            with z.open(m) as f:
                inner = f.read(limit + 1)  # size cap enforced even if the header lies
            if len(inner) > limit:
                raise IngestError(f"The file inside the ZIP is larger than {limit // 1048576} MB.")
            notes.append(f"Read '{m.filename.split('/')[-1]}' from the ZIP archive.")
            return unwrap(inner, m.filename, limit, notes, depth + 1)
    return data, name, fmt


# ----------------------------------------------------------------------------- readers
def _sniff_delimiter(text):
    lines = [l for l in text[:200000].splitlines() if l.strip()][:40]
    if not lines:
        raise IngestError("The file is empty.")
    best, best_score = None, 0.0
    for d in (",", "\t", ";", "|"):
        counts = [len(r) for r in csv.reader(lines, delimiter=d)]
        modal = max(set(counts), key=counts.count)
        if modal < 2:
            continue
        score = (counts.count(modal) / len(counts)) * (1 + min(modal, 50) / 100)
        if score > best_score:
            best, best_score = d, score
    if best and best_score >= 0.6:
        return best
    if all(len(re.split(r"\s+", l.strip())) >= 2 for l in lines[:10]):
        return " "  # whitespace separated
    return best or ","


def _nsl_header(first):
    """Headerless NSL-KDD rows have 41 features + label (+ difficulty); protocol is column 2."""
    if len(first) in (42, 43) and first[1].lower() in ("tcp", "udp", "icmp"):
        try:
            from ada_fedavg import NSL_COLS
        except Exception:
            return None
        hdr = list(NSL_COLS) + ["label"] + (["difficulty"] if len(first) == 43 else [])
        return hdr
    return None


def read_delimited(data, notes):
    text = _decode(data, notes)
    d = _sniff_delimiter(text)
    if d == " ":
        rows = [re.split(r"\s+", l.strip()) for l in text.splitlines() if l.strip()]
    else:
        rows = [r for r in csv.reader(io.StringIO(text, newline=""), delimiter=d) if r and any(c.strip() for c in r)]
    rows = [[c.strip() for c in r] for r in rows]
    if not rows:
        raise IngestError("The file is empty.")
    first = rows[0]
    width = len(first)
    numeric_frac = sum(1 for c in first if _is_num(c)) / max(width, 1)
    nsl = _nsl_header(first) if numeric_frac >= 0.5 else None
    if nsl:
        header, body = nsl, rows
        notes.append("No header row; recognised the NSL-KDD column layout (41 features + label" + (" + difficulty)." if width == 43 else ")."))
    elif numeric_frac >= 0.5 and width >= 2:
        header, body = [f"col_{i + 1}" for i in range(width)], rows
        notes.append("No header row detected; columns were named col_1, col_2, ...")
    else:
        header, body = first, rows[1:]
    names = {"," : "comma", "\t": "tab", ";": "semicolon", "|": "pipe", " ": "whitespace"}
    notes.append(f"Delimiter: {names.get(d, d)}.")
    return header, body


def _records_to_table(records, notes):
    cols, seen, flat = [], set(), []
    for rec in records:
        f = _flatten(rec) if isinstance(rec, dict) else {"value": rec}
        flat.append(f)
        for k in f:
            if k not in seen:
                if len(cols) >= MAX_COLS:
                    raise IngestError(f"More than {MAX_COLS} distinct fields; this is not a regular table.")
                seen.add(k)
                cols.append(k)
    if not cols:
        raise IngestError("No fields found in the JSON records.")
    body = [[_cell(f.get(c)) for c in cols] for f in flat]
    if any(isinstance(v, (list, dict)) for f in flat[:200] for v in f.values()):
        notes.append("Lists inside records were kept as JSON text in one column.")
    return cols, body


def _find_records(obj, depth=0):
    """Locate the list of row objects inside an arbitrary JSON document."""
    if isinstance(obj, list):
        return obj
    if not isinstance(obj, dict) or depth > 3:
        return None
    vals = list(obj.values())
    if vals and all(isinstance(v, list) for v in vals) and len({len(v) for v in vals}) == 1 and len(vals[0]) > 0 \
            and all(not isinstance(x, (dict, list)) for v in vals for x in v[:5]):
        n = len(vals[0])                      # column-oriented {"a": [..], "b": [..]}
        return [{k: obj[k][i] for k in obj} for i in range(n)]
    cands = [(len(v), k) for k, v in obj.items() if isinstance(v, list) and v and isinstance(v[0], (dict, list))]
    if cands:
        return obj[max(cands)[1]]
    if vals and all(isinstance(v, dict) for v in vals):   # {"id1": {...}, "id2": {...}}
        return [{"_key": k, **v} for k, v in obj.items()]
    for v in vals:                                        # nested wrapper such as {"result": {"rows": [...]}}
        if isinstance(v, dict):
            r = _find_records(v, depth + 1)
            if r:
                return r
    return None


def read_json(data, notes):
    text = _decode(data, notes).strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        notes.append("Not a single JSON document; read as JSON Lines.")
        return read_jsonl(data, notes)
    recs = _find_records(obj)
    if recs is None:
        raise IngestError("Could not find a list of records in this JSON. Expected an array of objects, "
                          "an array of arrays, or an object with a list under a key such as \"data\" or \"records\".")
    if not recs:
        raise IngestError("The JSON contains an empty list of records.")
    if all(isinstance(r, list) for r in recs):          # array of arrays
        first = recs[0]
        if all(isinstance(c, str) for c in first) and not all(_is_num(c) for c in first):
            header, body = [str(c) for c in first], [[_cell(c) for c in r] for r in recs[1:]]
        else:
            w = max(len(r) for r in recs)
            header, body = [f"col_{i + 1}" for i in range(w)], [[_cell(c) for c in r] + [""] * (w - len(r)) for r in recs]
            notes.append("JSON arrays have no header; columns were named col_1, col_2, ...")
        return header, body
    return _records_to_table(recs, notes)


def read_jsonl(data, notes):
    text = _decode(data, notes)
    recs, bad = [], 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            v = json.loads(line)
        except json.JSONDecodeError:
            bad += 1
            continue
        recs.append(v if isinstance(v, dict) else {"value": v})
    if not recs or bad > len(recs):
        raise IngestError("This is not valid JSON Lines (one JSON object per line).")
    if bad:
        notes.append(f"{bad} invalid JSON lines were skipped.")
    return _records_to_table(recs, notes)


def read_xlsx(data, notes):
    try:
        import openpyxl
    except ImportError:
        raise IngestError("Reading .xlsx needs the 'openpyxl' package on the server (pip install openpyxl).")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if sum(i.file_size for i in z.infolist()) > 600 * 1048576:
                raise IngestError("This workbook expands to more than 600 MB; export it as CSV instead.")
    except zipfile.BadZipFile:
        raise IngestError("The .xlsx file is damaged.")
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:
        raise IngestError(f"Could not open the workbook: {str(e)[:120]}")
    best = None
    for ws in wb.worksheets[:10]:
        rows = []
        for r in ws.iter_rows(values_only=True):
            if r is None or all(v is None or (isinstance(v, str) and not v.strip()) for v in r):
                continue
            rows.append(r)
        if len(rows) >= 2 and (best is None or len(rows) > len(best[1])):
            best = (ws.title, rows)
    wb.close()
    if not best:
        raise IngestError("No sheet with a header row and at least one data row was found.")
    title, rows = best
    width = 0
    for r in rows:
        for i in range(len(r) - 1, -1, -1):
            if r[i] is not None and not (isinstance(r[i], str) and not r[i].strip()):
                width = max(width, i + 1)
                break
    header = [_cell(v).strip() for v in rows[0][:width]] + [""] * (width - len(rows[0][:width]))
    body = [[_cell(v) for v in r[:width]] + [""] * (width - len(r[:width])) for r in rows[1:]]
    notes.append(f"Read sheet '{title}'" + (f" (largest of {len(wb.sheetnames)})." if len(wb.sheetnames) > 1 else "."))
    return header, body


def _split_arff(line):
    """Split one dense ARFF data line, honouring ' and " quotes."""
    out, cur, q, i = [], [], None, 0
    while i < len(line):
        c = line[i]
        if q:
            if c == "\\" and i + 1 < len(line):
                cur.append(line[i + 1]); i += 2; continue
            if c == q:
                q = None
            else:
                cur.append(c)
        elif c in "'\"":
            q = c
        elif c == ",":
            out.append("".join(cur).strip()); cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur).strip())
    return out


def read_arff(data, notes):
    text = _decode(data, notes)
    attrs, in_data, body = [], False, []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("%"):
            continue
        low = line.lower()
        if not in_data:
            if low.startswith("@attribute"):
                rest = line[len("@attribute"):].strip()
                m = re.match(r"""^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S+))\s+(.*)$""", rest)
                if not m:
                    raise IngestError(f"Cannot read ARFF attribute line: {line[:60]}")
                attrs.append((m.group(1) or m.group(2) or m.group(3)))
            elif low.startswith("@data"):
                in_data = True
            continue
        if line.startswith("{"):
            raise IngestError("Sparse ARFF files are not supported. Convert to dense ARFF or CSV.")
        row = _split_arff(line)
        if len(row) == len(attrs):
            body.append(["" if c == "?" else c for c in row])
    if not attrs or not in_data:
        raise IngestError("Not a valid ARFF file (no @attribute / @data sections).")
    return attrs, body


def read_parquet(data, notes):
    try:
        import pyarrow.parquet as pq
    except ImportError:
        raise IngestError("Reading .parquet needs the optional 'pyarrow' package on the server (pip install pyarrow), "
                          "or export the file as CSV.")
    try:
        tbl = pq.read_table(io.BytesIO(data))
    except Exception as e:
        raise IngestError(f"Could not read the Parquet file: {str(e)[:120]}")
    cols = tbl.column_names
    if len(cols) > MAX_COLS:
        raise IngestError(f"More than {MAX_COLS} columns.")
    py = [tbl.column(i).to_pylist() for i in range(len(cols))]
    body = [[_cell(py[j][i]) for j in range(len(cols))] for i in range(tbl.num_rows)]
    return cols, body


READERS = {"delimited": read_delimited, "json": read_json, "jsonl": read_jsonl, "xlsx": read_xlsx, "arff": read_arff, "parquet": read_parquet}


# ----------------------------------------------------------------------------- normalisation
def _clean_header(header, notes):
    out, seen = [], {}
    for i, h in enumerate(header):
        h = re.sub(r"\s+", " ", str(h)).strip()[:80] or f"col_{i + 1}"
        if h in seen:
            seen[h] += 1
            h = f"{h[:74]}_{seen[h]}"
        else:
            seen[h] = 1
        out.append(h)
    if out != [str(h).strip() for h in header]:
        notes.append("Some column names were empty, duplicated or too long and were adjusted.")
    return out


def _normalise_columns(header, body, notes):
    """Per column: null/inf tokens -> blank in numeric-looking columns; ISO datetimes -> epoch seconds."""
    nulls = infs = dts = 0
    for j in range(len(header)):
        vals = [r[j] for r in body]
        non_null = [v for v in vals if v.strip().lower() not in NULL_TOKENS]
        if not non_null:
            continue
        sample = non_null if len(non_null) <= 5000 else non_null[:: len(non_null) // 5000 + 1]
        numeric_like = sum(1 for v in sample if _is_num(v) or v.strip().lower() in INF_TOKENS) / len(sample) >= 0.9
        if numeric_like:
            for r in body:
                s = r[j].strip().lower()
                if s in NULL_TOKENS and s != "":
                    r[j] = ""; nulls += 1
                elif s in INF_TOKENS:
                    r[j] = ""; infs += 1
            continue
        if sum(1 for v in sample if ISO_DT.match(v.strip())) / len(sample) >= 0.98:
            ok = True
            conv = []
            for r in body:
                s = r[j].strip()
                if not s or s.lower() in NULL_TOKENS:
                    conv.append(""); continue
                try:
                    s2 = s.replace("Z", "+00:00")
                    if "T" not in s2 and " " in s2:
                        s2 = s2.replace(" ", "T", 1)
                    dt = datetime.fromisoformat(s2)
                except ValueError:
                    ok = False; break
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                conv.append(str(int(dt.timestamp())))
            if ok:
                for r, c in zip(body, conv):
                    r[j] = c
                dts += 1
    if nulls or infs:
        notes.append(f"Normalised {nulls} placeholder values (NA, null, ?) and {infs} infinite values to blank in numeric columns.")
    if dts:
        notes.append(f"{dts} date/time column(s) converted to Unix seconds.")


def convert(in_path, out_path, name="", max_mb=50):
    notes = []
    limit = int(max_mb * 1048576 * 3)
    with open(in_path, "rb") as f:
        raw = f.read(int(max_mb * 1048576) * 2 + 1)
    if len(raw) > int(max_mb * 1048576) * 2:
        raise IngestError(f"The file is larger than {max_mb * 2} MB.")
    if not raw.strip():
        raise IngestError("The file is empty.")
    data, inner_name, fmt = unwrap(raw, name or in_path, limit, notes)
    label = {"delimited": "CSV / delimited text", "json": "JSON", "jsonl": "JSON Lines", "xlsx": "Excel workbook", "arff": "ARFF", "parquet": "Parquet"}[fmt]
    ext = _ext(inner_name)
    if fmt == "delimited" and ext == ".tsv":
        label = "TSV"
    header, body = READERS[fmt](data, notes)
    width = len(header)
    if width < 2:
        raise IngestError("The table has only one column; at least a label column and one feature column are needed.")
    if width > MAX_COLS:
        raise IngestError(f"More than {MAX_COLS} columns.")
    header = _clean_header(header, notes)
    good = [r for r in body if len(r) == width]
    ragged = len(body) - len(good)
    if ragged:
        notes.append(f"{ragged} rows with the wrong number of fields were skipped.")
    if not good:
        raise IngestError("No data rows could be read (every row had the wrong number of fields).")
    _normalise_columns(header, good, notes)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(good)
    return {"format": label, "rows": len(good), "columns": width, "notes": notes[:12]}


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"error": "usage: ingest.py INPUT OUTPUT.csv [ORIGINAL_NAME] [MAX_MB]"}))
        return 2
    try:
        res = convert(argv[1], argv[2], argv[3] if len(argv) > 3 else "", float(argv[4]) if len(argv) > 4 else 50)
        print(json.dumps(res))
        return 0
    except IngestError as e:
        print(json.dumps({"error": str(e)[:300]}))
    except MemoryError:
        print(json.dumps({"error": "The file is too large to process on this server. Sample it or export a smaller CSV."}))
    except Exception as e:  # never leak a traceback to the API caller
        print(json.dumps({"error": f"Could not read this file ({type(e).__name__})."}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
