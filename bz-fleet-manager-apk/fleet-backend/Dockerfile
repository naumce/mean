# fleet-backend: Node 20 + tsx runtime. Migrations deploy on boot so a fresh
# database is schema-complete before the API accepts traffic.
FROM node:20-alpine
WORKDIR /app

# Prisma's engines need OpenSSL, which node:alpine no longer ships.
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY seed-control-tower.mjs seed-demo.mjs smoke-control-tower.mjs ./

EXPOSE 3001
ENV NODE_OPTIONS=--max-http-header-size=65536
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/server.ts"]
