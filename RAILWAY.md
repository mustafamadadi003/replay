# Railway quick start (Rahbin Reply)

Full guide: [docs/deploy-railway.md](docs/deploy-railway.md)

**Trial:** $5 / 30 days — connect GitHub for Full Trial (Meta API needs outbound network).

**Services:** Postgres + Redis + `web` (`SERVICE_ROLE=web`) + `worker` (`SERVICE_ROLE=worker`). Same Dockerfile.

**Login:** `/login` shows **Rahbin Group** + password (`OFFICE_ACCESS_CODE`). No email magic link.

**Build:** `Dockerfile` → `scripts/railway-start.sh`  
- web: `prisma migrate deploy` then `next start`  
- worker: `tsx worker/dm-worker.ts` (+ cron if `CRON_BASE_URL` set)
