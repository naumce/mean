// Single-service hosting (Render free tier, one container): the backend also
// serves the built portal and forwards the night-shift worker's public paths
// to the worker process running beside it. Both are opt-in by env, so tests
// and docker-compose (nginx does this job there) are unaffected.
//
//   PORTAL_DIST=/app/fleet-portal/dist   → static files + SPA fallback
//   WORKER_URL=http://127.0.0.1:3002     → /d, /act, /twilio piped to the worker
import http from "node:http";
import path from "node:path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";

/** Paths the worker owns (spec: driver link page, email action links, Twilio
 *  webhooks). Nothing under /api collides with them. */
export const WORKER_PATHS: readonly string[] = ["/d/", "/act/", "/twilio/"];

const isWorkerPath = (url: string): boolean => WORKER_PATHS.some((p) => url.startsWith(p));

/** Pipe one request to the worker and its response back, headers included.
 *  No body buffering, no rewriting — the worker sees the same path and the
 *  same X-Forwarded-* it would behind nginx. */
export function workerProxy(workerUrl: string) {
  const target = new URL(workerUrl);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isWorkerPath(req.url)) return next();
    const upstream = http.request(
      { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.status(502).type("text/plain").send("night shift worker is not reachable");
      else res.end();
    });
    req.pipe(upstream);
  };
}

/** Static portal + history-API fallback. Only GET/HEAD requests that are not
 *  API, upload, websocket or worker paths get index.html; everything else
 *  falls through to Express's own 404 as before. */
export function portalStatic(distDir: string) {
  const serve = express.static(distDir, { index: "index.html", fallthrough: true });
  const index = path.join(distDir, "index.html");
  const skip = ["/api/", "/uploads/", "/ws", ...WORKER_PATHS];
  const fallback = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (skip.some((p) => req.url === p.replace(/\/$/, "") || req.url.startsWith(p))) return next();
    res.sendFile(index, (err) => (err ? next() : undefined));
  };
  return [serve, fallback] as const;
}

/** Mount whichever of the two are configured. Call BEFORE the error handler. */
export function mountHosting(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if (env.WORKER_URL) app.use(workerProxy(env.WORKER_URL));
  if (env.PORTAL_DIST) {
    const [serve, fallback] = portalStatic(env.PORTAL_DIST);
    app.use(serve);
    app.use(fallback);
  }
}
