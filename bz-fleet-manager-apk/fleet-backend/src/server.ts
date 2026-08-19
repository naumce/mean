import http from "node:http";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime.js";

// createApp() itself stays HTTP-only and unchanged — the WebSocketServer
// attaches to the http.Server created here, not to the Express app, so the
// existing Supertest-based HTTP test suite never touches this file.
const port = Number(process.env.PORT ?? 3001);
const server = http.createServer(createApp());
attachRealtime(server);
server.listen(port, () => console.log(`api on :${port}`));
