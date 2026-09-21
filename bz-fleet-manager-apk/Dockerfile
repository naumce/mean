# One container for the free-tier demo (Render): backend + night-shift worker
# + the built portal, served on a single port. Postgres is external
# (Supabase). docker-compose.yml keeps using the per-package Dockerfiles.
#
#   docker build -t fleet . && docker run --env-file .env -p 3001:3001 fleet
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl

# Dependencies first, so source edits do not reinstall.
COPY fleet-backend/package*.json fleet-backend/
COPY night-shift/package*.json night-shift/
COPY fleet-portal/package*.json fleet-portal/
RUN cd fleet-backend && npm ci \
 && cd ../night-shift && npm ci \
 && cd ../fleet-portal && npm ci

COPY fleet-backend fleet-backend
COPY night-shift night-shift
COPY fleet-portal fleet-portal
RUN cd fleet-backend && npx prisma generate
# Same-origin: the portal calls /api on the page's own origin.
RUN cd fleet-portal && VITE_API_URL=/api npm run build

COPY start.sh ./
EXPOSE 3001
ENV NODE_OPTIONS=--max-http-header-size=65536 \
    PORTAL_DIST=/app/fleet-portal/dist \
    WORKER_URL=http://127.0.0.1:3010 \
    WORKER_PORT=3010 \
    TRUST_PROXY=1
CMD ["sh", "start.sh"]
