# fleet-portal: two-stage — Vite build, then nginx serving the static bundle
# and reverse-proxying /api, /uploads, and the /ws WebSocket to the backend.
FROM node:20-alpine AS build
WORKDIR /app
# Relative API base: same-origin through the nginx proxy, no CORS involved.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
