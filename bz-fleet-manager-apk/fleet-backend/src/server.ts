import http from "node:http";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime.js";
import { installProcessGuards } from "./lib/processGuards.js";

// createApp() itself stays HTTP-only and unchanged — the WebSocketServer
// attaches to the http.Server created here, not to the Express app, so the
// existing Supertest-based HTTP test suite never touches this file.

// Before anything binds, so a rejection raised while the very first request is
// in flight cannot take the process down with it.
installProcessGuards();

const port = Number(process.env.PORT ?? 3001);
const server = http.createServer(createApp());
attachRealtime(server);
server.listen(port, () => {
  // PORT=0 asks the OS for a free port, so log the port actually bound rather
  // than the requested one — tests/process-crash.test.ts boots this file for
  // real and reads the port back from this line.
  const bound = server.address();
  console.log(`api on :${bound !== null && typeof bound === "object" ? bound.port : port}`);
});
