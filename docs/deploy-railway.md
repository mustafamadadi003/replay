# Deploy Rahbin Reply (openreply-v2) on Railway ($5 trial)

Trial: one-time **$5** for up to 30 days ([docs](https://docs.railway.com/reference/pricing/free-trial)).
Connect GitHub so the trial is **Full** (outbound network works — required for Meta Graph).

## Architecture on Railway

| Service | Role | Notes |
|---------|------|--------|
| **Postgres** | plugin | Railway Postgres |
| **Redis** | plugin | Railway Redis |
| **web** | `SERVICE_ROLE=web` | Dockerfile → migrate + `next start` |
| **worker** | `SERVICE_ROLE=worker` | same image → DM worker + cron loop |

One Dockerfile, one image. Role is selected with `SERVICE_ROLE`.

## 1) GitHub

Push **only** the `openreply-v2` folder as the repo root (not the parent monorepo).

- `.env` is gitignored — never commit it
- `/tools` and `/scripts/_*.mts` are gitignored

## 2) New Railway project

1. [railway.com](https://railway.com) → Login with GitHub → verify if prompted  
2. **New Project** → **Deploy from GitHub repo** → select this repo  
3. Add plugins: **PostgreSQL** + **Redis**  
4. Duplicate the GitHub service (or add a second service from the same repo) and name them:
   - `web`
   - `worker`

Both services must use the **Dockerfile** builder (Railway detects `Dockerfile` automatically).

### web service

| Setting | Value |
|---------|--------|
| Variables | see table below + `SERVICE_ROLE=web` |
| Networking | **Generate Domain** (HTTPS) |
| Healthcheck (optional) | `/login` |

### worker service

| Setting | Value |
|---------|--------|
| Variables | same as web + `SERVICE_ROLE=worker` |
| `CRON_BASE_URL` | public HTTPS URL of **web** (e.g. `https://….up.railway.app`) |
| No public domain | needed |

Share variables: in Railway, use **Shared Variables** or reference plugins:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

## 3) Required environment variables

Copy from local `.env` where noted. **ENCRYPTION_KEY must match local** if you restore the local DB (encrypted Meta tokens).

| Variable | Source |
|----------|--------|
| `DATABASE_URL` | Railway Postgres reference |
| `REDIS_URL` | Railway Redis reference |
| `NEXTAUTH_URL` | `https://YOUR-WEB.up.railway.app` (no trailing slash) |
| `NEXTAUTH_SECRET` | new random (≥16 chars) |
| `CRON_SECRET` | new random |
| `ENCRYPTION_KEY` | **same 64-hex as local `.env`** if migrating data |
| `OFFICE_ACCESS_CODE` | `rahbin@2026` |
| `FACEBOOK_APP_ID` | from local |
| `FACEBOOK_APP_SECRET` | from local |
| `INSTAGRAM_APP_ID` | usually same as Facebook app id |
| `INSTAGRAM_APP_SECRET` | usually same as Facebook app secret |
| `WEBHOOK_VERIFY_TOKEN` | from local |
| `META_GRAPH_API_VERSION` | `v25.0` |
| `META_SYSTEM_USER_TOKEN` | from local (optional but useful) |
| `SERVICE_ROLE` | `web` or `worker` |
| `CRON_BASE_URL` | worker only → web public URL |

Login page is office-only (no magic-link email). `RESEND_API_KEY` is unused unless you re-enable email login.

## 4) Database data

### Option A — fresh DB (simplest)

1. Deploy with empty Postgres (migrations run on web start)  
2. Log in with office code  
3. Re-connect Facebook / Instagram pages (paste tokens again)

### Option B — keep local pages & campaigns

Dump local DB and restore into Railway Postgres (keep the same `ENCRYPTION_KEY`):

```bash
# local
docker exec openreply-postgres-1 pg_dump -U postgres -Fc openreply_v2 > openreply_v2.dump

# Railway: use the public Postgres URL from the plugin, then:
pg_restore --clean --if-exists --no-owner -d "$RAILWAY_DATABASE_URL" openreply_v2.dump
```

## 5) Meta webhooks after deploy

In Meta App → Webhooks, set callback URL to:

```
https://YOUR-WEB.up.railway.app/api/webhook
```

Verify token = `WEBHOOK_VERIFY_TOKEN`.  
Subscribe Page / Instagram fields (`comments`, `messages`, …) as before.

Also update any OAuth redirect URLs if you use Meta Login later.

## 6) Smoke test

1. Open `https://YOUR-WEB.up.railway.app/login` → **Rahbin Group** + password only  
2. Password: `rahbin@2026` → dashboard  
3. Settings → pages/IG still listed (if DB restored)  
4. Worker logs show `[DM Worker] Started`  
5. Post a test comment on a live campaign

## Cost tip (trial $5)

- Keep **1 web + 1 worker + Postgres + Redis** only  
- Sleep unused preview environments  
- After trial, Hobby is needed for production uptime
