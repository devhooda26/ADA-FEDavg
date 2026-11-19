#!/usr/bin/env python3
"""Profile an uploaded CSV (stdlib + ada_fedavg.col_kind). Usage: profile_dataset.py FILE [LABEL_COLUMN]
Prints one JSON object. Never executes file contents."""
import json, sys, collections
from ada_fedavg import read_csv, col_kind

def main():
    path = sys.argv[1]; label = sys.argv[2] if len(sys.argv) > 2 else None
    header, rows, ragged = read_csv(path)
    if len(header) < 2 or len(set(header)) != len(header): raise ValueError("need at least 2 columns with unique header names")
    if len(rows) == 0: raise ValueError("no data rows")
    sample = rows if len(rows) <= 20000 else rows[:: len(rows) // 20000 + 1]
    cols = []
    for j, h in enumerate(header):
        vals = [r[j] for r in sample]; kind = col_kind(vals)
        cols.append({"name": h[:80], "kind": kind, "unique": len(set(vals)), "missing": sum(1 for v in vals if v == "")})
    out = {"rows": len(rows), "ragged": ragged, "columns": cols, "preview": [dict(zip([c["name"] for c in cols], r)) for r in rows[:5]],
           "labelCandidates": [c["name"] for c in cols if 2 <= c["unique"] <= 30 and c["kind"] != "text"]}
    if label:
        if label not in header: raise ValueError("label column not found")
        cnt = collections.Counter(r[header.index(label)] for r in rows)
        if len(cnt) > 30: raise ValueError("label column has more than 30 distinct values")
        out["labels"] = [{"value": k, "count": v} for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])]
    print(json.dumps(out))

if __name__ == "__main__":
    try: main()
    except Exception as e:
        print(json.dumps({"error": str(e)[:200]})); sys.exit(1)
