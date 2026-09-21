#!/bin/sh
# Boot order for the single container: migrate, start the worker on its
# private port, then the backend on $PORT (Render sets it). If either child
# dies the container exits, so the platform restarts it — no half-alive state.
set -e
cd /app/fleet-backend
# 2026-09-21: the first Supabase deploy recorded this migration as failed
# (pgcrypto lived in "extensions", not "public"; the SQL is fixed now). Prisma
# refuses to deploy past a failed row, so clear it first — a no-op error once
# the migration is applied. Remove after the demo database is rebuilt.
npx prisma migrate resolve --rolled-back 20260920103547_night_shift_sheet 2>/dev/null || true
npx prisma migrate deploy
# One-off demo data (d@fleet.com / pass123): set SEED_DEMO to a seed script
# name for one deploy, then remove it. seed-control-tower.mjs = the org and
# dispatcher; seed-demo.mjs = the rich two-carrier dataset on top of it.
case "$SEED_DEMO" in
  seed-control-tower.mjs|seed-demo.mjs) node "$SEED_DEMO" ;;
  1) node seed-control-tower.mjs ;;
esac

# The worker's own HTTP server (driver page, Twilio webhooks) listens on
# WORKER_PORT; the backend proxies /d, /act, /twilio to it. PUBLIC_URL is the
# backend's public origin, so every link the worker hands out resolves here.
cd /app/night-shift && PORT="${WORKER_PORT:-3010}" MODE=platform npx tsx src/live/worker.ts &
WORKER=$!

cd /app/fleet-backend && npx tsx src/server.ts &
BACKEND=$!

trap 'kill $WORKER $BACKEND 2>/dev/null' TERM INT
# busybox sh has no `wait -n`: poll, and exit when the first child is gone.
while kill -0 $WORKER 2>/dev/null && kill -0 $BACKEND 2>/dev/null; do sleep 2; done
kill $WORKER $BACKEND 2>/dev/null
exit 1
