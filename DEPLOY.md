# Deploying ADA-FedAvg

One container runs the API, the frontend and the Python training worker. Caddy adds automatic HTTPS.

## Option A: any Linux VPS with Docker (recommended)
1. Point a DNS A record (e.g. `ada.example.com`) at the server; open ports 80 and 443.
2. Copy the project to the server, then:
   ```bash
   cp .env.production.example .env     # edit DOMAIN, APP_URL, ADMIN_*, SMTP_URL
   docker compose up -d --build
   docker compose logs -f app          # first start downloads NSL-KDD (~22 MB)
   ```
3. Open `https://<your domain>` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
4. Go to Experiments → "Run full reproduction" once the dataset is in place.

Local trial: leave `DOMAIN` unset and open `https://localhost` (accept Caddy's local certificate).

## Option B: a container platform (Render, Fly.io, Railway, ...)
Deploy the `Dockerfile` directly. Requirements: a **persistent volume mounted at `/app/data`** (database and dataset), the environment variables from `.env.production.example`, health check path `/api/health`, and **a single instance** (SQLite and the one-at-a-time worker are not multi-instance safe). Give it at least 1 GB RAM; training uses roughly 500 MB.

## Operations
* **Backup:** copy `app.db` from the volume (`docker compose cp app:/app/data/app.db ./backup.db`).
* **Update:** `git pull && docker compose up -d --build` (data volume is kept).
* **Email:** without `SMTP_URL`, users never receive verification or reset links. Set it, then keep `REQUIRE_EMAIL_VERIFICATION=true`.
* **Logs / audit:** `docker compose logs app`; security events are also in the Audit log tab.
* **Dataset missing:** `docker compose exec app ./scripts/get_dataset.sh`.

## Production checklist
- [ ] Strong, unique `ADMIN_PASSWORD`; change it in Settings after first login
- [ ] `APP_URL` starts with `https://`
- [ ] SMTP configured and a test sign-up verified
- [ ] Volume backups scheduled
- [ ] Only ports 80/443 exposed (the app container is not published)

Not covered: horizontal scaling, external database, rate limiting at the proxy level, and monitoring/alerting.
