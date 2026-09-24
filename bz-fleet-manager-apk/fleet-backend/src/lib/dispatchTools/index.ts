// The read-only tool boundary (AI Dispatch Foundation, Task 5): every
// function re-exported here is a thin wrapper over an EXISTING service
// (driverAvailability, driverMetrics, customers, suggestForLoad, ...) — see
// each sibling file's own header for which. No Prisma mutation of any kind
// runs anywhere under this directory — no row creation, modification, or
// removal, and no raw/transactional writes — which
// tests/dispatch-tools.test.ts's static scan enforces by reading every file
// here and checking for those call forms verbatim (deliberately not spelled
// out literally in THIS comment, or the scan would flag its own description
// of itself). No LLM/model code of any kind either — this module only
// describes what CAN be read, never how an agent might act on it.
// `GET /api/dispatcher/tools` (routes/dispatcherTools.ts) publishes
// `manifest.ts`'s TOOL_MANIFEST; nothing here invokes a tool by name yet.
export * from "./loads.js";
export * from "./drivers.js";
export * from "./customers.js";
export * from "./eta.js";
export * from "./events.js";
export * from "./dispatch.js";
export * from "./manifest.js";
