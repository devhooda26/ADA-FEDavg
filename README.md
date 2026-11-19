# ADA-FedAvg Platform

Full-stack research platform for **ADA-FedAvg** (Attack-Distribution-Aware Clustered Federated Averaging, NSL-KDD).
Node/Express + SQLite API, a real numpy training worker, and an editorial "Serif" frontend served by the same server.

## Quick start (VS Code, Windows / macOS / Linux)
Requirements: **Node 20+** (22 recommended) and **Python 3.9+**. Docker is optional.
```bash
npm install
npm run setup      # creates .env (with a generated admin password), a Python .venv, downloads NSL-KDD
npm run dev        # starts the server with auto-restart
```
Open **http://localhost:4000** and sign in with the admin email and password printed by `npm run setup` (also stored in `.env`).

In VS Code: open the folder, accept the recommended extensions, then press **F5** (“ADA-FedAvg: run server”). The browser opens by itself. `Ctrl+Shift+B` starts the dev server, `Ctrl+Shift+T` runs all checks, and `api.http` lets you try the API with the REST Client extension.

**Reaching the site from another device or from the cloud**
* *Remote / Codespaces / Dev Container:* port 4000 is forwarded automatically (see the **Ports** tab; set visibility to Public to share a link).
* *Another device on your Wi-Fi:* the server listens on `0.0.0.0` (`HOST` in `.env`), so use `http://<your-computer-ip>:4000`. Set `HOST=127.0.0.1` to keep it private to your machine.
* *A public HTTPS site:* see [DEPLOY.md](DEPLOY.md).

| Command | What it does |
|---|---|
| `npm run setup` | one-time setup, safe to re-run |
| `npm run doctor` | checks Node, Python packages, dataset, `.env`, port |
| `npm run dev` / `npm start` | development (auto-restart) / production start |
| `npm run dataset` | (re)download NSL-KDD; `-- --force` re-downloads |
| `npm run benchmark` | model benchmark against independent baselines (a few minutes, offline) |
| `npm run verify` | syntax check + API tests + algorithm and ingestion tests |
| `npm run docker:up` | build and run the Docker stack |

Health check: `GET /api/health` (version, database, dataset and email status). The footer of every page shows it.

### Troubleshooting
* **“Port 4000 is already in use”**: set `PORT=4001` in `.env`.
* **Experiments stay “failed: dataset_missing”**: `npm run dataset`.
* **“Python is not available”**: run `npm run setup` (it writes the `.venv` path into `PYTHON`).
* **Sign-up emails never arrive**: without `SMTP_URL` they appear in the server console and under Admin → Outbox.
* **Restarting the dev server marks a running experiment as failed** (the worker is stopped with it). Use `npm start` for long runs.
* Something odd? `npm run doctor`.

## Model quality (uploaded datasets)
The model is a 128-64-32 network with batch norm and dropout, trained with Adam, class weighting and optional FedProx. For uploaded data three things were added, all fitted or chosen on training and validation data only, never on the test split:

- **Automatic log transform** of non-negative, heavily right-skewed columns (bytes, counts, durations), saved with the model and applied identically in Detect. Off for the paper's NSL-KDD runs, so reproduction is unchanged (`--no-auto-log` disables it).
- **Best-round checkpoint**: the model from the round with the best validation macro-F1 is evaluated and saved, and the experiment page says which round it was (`--no-select-best` keeps the last round).
- **Training effort presets** on the experiment form: Quick (30 rounds, 1 local epoch), Balanced (60, 2), Thorough (100, 3).

`npm run benchmark` reproduces the numbers below in a few minutes, offline (real datasets bundled with scikit-learn, plus a synthetic heavy-tailed traffic set; 5 clients with label skew). Test macro-F1:

| Dataset | Centralized, same network | Logistic regression | Gradient boosting | Federated, Quick | Balanced | Thorough |
|---|---|---|---|---|---|---|
| Breast cancer (569 rows) | 0.971 | 0.971 | 0.962 | 0.880 | 0.934 | 0.930 |
| Handwritten digits (1,797 rows) | 0.967 | 0.970 | 0.974 | 0.686 | 0.890 | 0.941 |
| Synthetic traffic (6,000 rows, noisy) | 0.549 | 0.561 | 0.520 | 0.480 | 0.494 | 0.497 |

How to read this honestly: the network matches strong independent baselines when trained centrally, so the model itself is sound. Federated training under label skew needs a larger budget, which is why Quick under-trains harder data; Thorough closes most of the gap on digits. The federated columns use 2 seeds and the centralized and reference columns 3, so differences of a few hundredths are within noise. Checkpointing by a small validation split can pick a slightly early round (digits: 0.941 with it versus 0.970 without, but it protected the noisy traffic set from drifting: 0.404 to 0.506 at 120 rounds). The log transform helped on heavy-tailed data (0.376 to 0.429 over 3 seeds) and was neutral elsewhere, with wide seed-to-seed spread. These are tabular classification results; the platform does not do regression, images, audio or text.

## Design system ("Aurora Glass")
The whole interface is one token-driven stylesheet (`public/style.css`): a midnight base with aurora light behind frosted-glass panels in dark mode, and a bright lavender-white version of the same in light mode. Switch themes, motion and text size from Settings or the controls in the top bar.

- **Illustrations and diagrams** are hand-built inline SVG in `public/app.js` (hero network, the three step diagrams, the FedAvg versus ADA-FedAvg weighting donuts, the file-formats pipeline), coloured from the CSS tokens so they follow the theme. There are no photographs; to add some, put images in `public/img/` and reference them from the landing page markup (the server's CSP allows same-origin images).
- **Layout**: floating glass top bar; a sidebar for the dashboard on desktop that becomes a scrollable tab row on phones; every page usable at 390 px wide.
- **Accessibility**: text and controls are checked against WCAG AA in the worst case (a bright aurora blob directly under a panel): lowest text ratio 4.97:1, chart colours at least 3:1 on both themes. Glass is decoration only: `prefers-reduced-transparency` and `prefers-contrast: more` switch panels to solid, `prefers-reduced-motion` (or the Motion setting) stops all animation, and every control keeps a visible focus ring.
- **Fonts** (Inter, Sora, JetBrains Mono) load from Google Fonts; offline, the system UI fonts are used and the layout still holds.
- Colour tokens live at the top of `style.css`; change `--accent`, `--accent2`, `--accent3` and the `--blob*` values to re-theme everything. Re-check contrast if you do.

## Pages and URLs
Every page has its own address, so links can be bookmarked, shared and refreshed, and the browser Back button works: `/` (home), `/login`, `/register`, `/forgot`, `/reset`, `/verify`, `/review`, and, after signing in, `/app` (overview), `/app/detect`, `/app/experiments`, `/app/experiments/<id>`, `/app/studies`, `/app/studies/<id>`, `/app/datasets`, `/app/datasets/<id>`, `/app/compare`, `/app/paper`, `/app/privacy`, `/app/settings`, and for admins `/app/users`, `/app/audit`, `/app/outbox`. Unknown addresses return HTTP 404. Old `/#/...` links are converted automatically.

## Deployment
Docker + automatic HTTPS: see [DEPLOY.md](DEPLOY.md) (`docker compose up -d --build`).

## What is real
* **Experiments** run `ml/ada_fedavg.py` in a background worker (one at a time, queued, cancellable, 30-min limit). Nothing is simulated in the UI: every number on Overview, Experiments and Compare comes from a finished run stored in the database.
* **Paper results** are clearly labelled *Paper-reported* (Tables I and II of the paper). *Generated* means produced by this server.
* The worker implements: five-class NSL-KDD mapping, preprocessing fitted on the training split only, Dirichlet non-IID partitioning (mild α=1.0, moderate 0.5, extreme 0.1), Jensen–Shannon divergence, agglomerative clustering (average linkage on JS distance), sample-weighted aggregation inside clusters then equal weight across clusters, a 128-64-32 MLP with BatchNorm, ReLU and dropout, and metrics (accuracy, macro/weighted F1, per-class P/R/F1, confusion matrix, communication volume).
* Federated training is a **single-machine simulation** (the server holds the data and splits it across simulated clients).

## Features
Landing page · sign up / sign in · email verification · forgot/reset password · session expiry handling · access-denied page · overview dashboard · experiment queue (create, monitor, cancel, delete, full 7-run reproduction) · experiment detail (round chart, per-class table, confusion matrix, client distributions, clusters, JSD matrix) · paper-vs-generated comparison · paper results · privacy page · profile and password settings · admin: users/roles/delete, audit log, dev outbox · light/dark/system theme · responsive layout with mobile menu.

## Studies, ablations and statistics
**Studies** run a preset (core comparison, full ablation, K sweep, robustness, heterogeneity) over many seeds and report mean ± sd, 95% CIs, paired differences, per-class F1, rounds-to-target and convergence curves, with CSV and LaTeX export. Methods: centralized, FedAvg, FedProx, IFCA, ADA-FedAvg, with switches for cluster membership, distance, cluster-weight blend, class-weighted loss, label/quantity/feature heterogeneity and a Sybil client. See `docs/REVIEW_RESPONSE.md` for how each is meant to answer common reviewer criticisms, and what is not covered.

## Your own data
**Datasets** tab: upload a table, check the detected column types, pick the label column, map label values to classes (merge or exclude), then use it in Experiments and Studies.

**Accepted formats** (detected from the file's bytes, not just its extension): CSV, TSV, TXT/DAT (comma, tab, semicolon, pipe or whitespace separated; header optional, headerless NSL-KDD recognised), JSON (array of objects, array of arrays, `{"data": [...]}`, column-oriented, keyed by id; nested objects are flattened), JSONL/NDJSON, XLSX/XLSM (largest sheet), ARFF (dense), Parquet (only if you uncomment `pyarrow` in `ml/requirements.txt`), and `.gz` or `.zip` containing one of these. Mixed column types are handled: numeric columns are scaled, categorical ones one-hot encoded, ISO dates become Unix seconds, `NA`/`null`/`?`/`Infinity` in numeric columns become blanks, mostly-empty columns are dropped, and free text and row ids are ignored. The upload response and the dataset page say how the file was read and what was adjusted.

**Not accepted, with a clear message:** legacy `.xls`, raw packet captures (`.pcap`), images, audio, PDF and Word files. These are not tables of records. For traffic, extract flow records first (CICFlowMeter, Zeek, tshark) and upload that CSV.

Files are stored under `data/uploads/` with server-generated names (the original name is only a format hint), parsed but never executed, readable only by the owner and admins, and deleted with the dataset. The raw upload is deleted as soon as it has been converted. Default limit 50 MB (`MAX_UPLOAD_MB`; compressed uploads may expand to 3x that). Metrics use a stratified random split of your file.

## Detect: score your own records
Train a model in **Experiments** (standalone runs keep their final model; study runs do not), then open **Detect**:
1. Choose a trained model.
2. Enter data as a **single record** (a form built from the model's fields, with real example rows for NSL-KDD models), **pasted rows**, or an **uploaded CSV**. The header must name the model's columns (at least 3 must match; missing numeric fields use the training average and are flagged).
3. Press **Analyze batch** (up to 1000 records). Each record gets a verdict (alert or OK), a class, a confidence and the full class probabilities. Download the results as CSV.

Records are sent to the server for scoring and are **never stored**; only counts (records, alerts, errors) go into your history. Detect is rate limited and validates every record.

**Using it on real traffic:** NSL-KDD's 41 fields are connection-level features that a monitoring tool has to compute, so typing them by hand is only suitable for trying the form. For real use, export flow records with your own tooling, upload that CSV in **Datasets**, map its labels, train on it, and use Detect with the same columns. The model is a research model, not a replacement for a production intrusion-detection system. On the shipped examples after a short training run, normal, DoS and probe rows were classified correctly while the R2L and U2R examples were called benign: rare classes are the hard part.

## Appearance, motion and accessibility
Theme (light, dark, system), **motion** (system, full, reduced) and text size are set in **Settings** (saved per device) and from the two quick toggles in the header. Motion covers the page transitions, scroll reveals, count-up numbers, animated charts, the hero illustration, toasts and loading shimmer. "Reduced" switches all of it off, and "System" follows the device's reduce-motion setting. Background refreshes (for example while an experiment runs) never replay animations. The interface is keyboard operable, uses visible focus rings, announces changes through a live region, and never relies on colour alone (alerts carry a text label and symbol).

## Roles
`viewer` reads results · `researcher` also creates experiments and manages their own · `admin` manages users, all experiments and the audit log. New sign-ups are viewers. Enforced on the server.

## Email
Set `SMTP_URL` (and `APP_URL`, `MAIL_FROM`) for real delivery. Without it, verification/reset emails are written to the server console and an admin-only outbox (**development only**). Set `REQUIRE_EMAIL_VERIFICATION=true` once SMTP works.

## API (all under /api, JSON, HttpOnly session cookie)
auth: register, login, logout, me, verify, resend-verification, forgot, reset, change-password, profile · paper: summary (public), results · experiments: list, create, suite, compare, get, cancel, delete · overview · dataset · admin: users, role, delete user, audit, outbox.

## Security
bcrypt, hashed server-side sessions, lockout after 5 failures, rate limits, zod validation, Helmet CSP, CORS allow-list and Origin check, single-use expiring tokens, identical responses for unknown emails, audit log. Use HTTPS and a persistent volume for `data/app.db` in production.

## Known limitations
Single runs have one seed; use Studies for confidence intervals (no multiple-comparison correction). SCAFFOLD and CFL are not implemented; FedProx and IFCA are simplified. Reproduction of the paper's gains is not guaranteed: the paper does not fix every training hyper-parameter (local epochs, learning rate, batch size), so defaults here (Adam 1e-3, batch 256, 1 local epoch, dropout 0.3) are our choice. Communication volume counts all weights and BatchNorm statistics, upload plus download, so it will not match the paper's figure. No differential privacy or secure aggregation. SQLite and a single worker suit a lab server, not large scale.
# ADA-FEDavg
