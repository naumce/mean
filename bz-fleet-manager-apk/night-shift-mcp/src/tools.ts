import { z } from "zod";
import type { NightShiftClient } from "./client.js";

// The exact tool list from the spec (2026-09-19-night-shift-as-a-product-design.md
// §10) and the plan's Task 5 — no more, no fewer, and none of them can ever
// take the agent live or touch a policy's `shadow` (spec §13: "no tool ...
// can [flip shadow to live]"). Each tool is a thin wrapper over one or two
// existing/added dispatcher routes (client.ts is the only place an HTTP call
// is actually made), kept here — separate from src/index.ts's SDK wiring —
// so a test can call `handler` directly against a mocked `fetch` without
// standing up a real MCP transport.

// Deliberately not generic over each tool's own arg shape: the SDK parses
// `args` against `inputSchema` before `handler` ever runs, so by the time a
// handler sees them they are already validated — the individual `as string`
// casts below are for TypeScript's benefit only, not a trust boundary.
export interface ToolDefinition {
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// A loose but not-anything-goes shape for a policy patch: every field
// agentPolicySchema (fleet-backend/src/lib/agentPolicies.ts) accepts, all
// optional (a patch touches only what it names). `shadow` is deliberately
// listed so zod can validate a caller who tries to send a non-boolean one,
// but the handler below refuses ANY patch that names it at all, valid value
// or not (spec §13) — that check happens in code, not in this schema, so the
// error message can explain why rather than just "invalid".
const policyPatchShape = {
  name: z.string().min(1).max(40).optional(),
  stopMin: z.number().int().min(1).max(240).optional(),
  delayMin: z.number().int().min(1).max(600).optional(),
  darkMin: z.number().int().min(1).max(600).optional(),
  darkAtStopMin: z.number().int().min(1).max(600).optional(),
  offRouteMi: z.number().min(0.1).max(50).optional(),
  offRouteMin: z.number().int().min(1).max(120).optional(),
  rungGapMin: z.number().int().min(1).max(60).optional(),
  maxCalls: z.number().int().min(0).max(5).optional(),
  dispatcherEmail: z.string().email().optional(),
  dispatcherPhone: z.string().regex(/^\+\d{8,15}$/).nullable().optional(),
  customerEmailOn: z.boolean().optional(),
  shadow: z.boolean().optional(),
  bossCallOn: z.boolean().optional(),
  quietFrom: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietTo: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
};
const policyPatchSchema = z.object(policyPatchShape);

async function queueCommand(client: NightShiftClient, loadRef: string, kind: string, payload?: unknown): Promise<unknown> {
  const id = await client.lookupLoadId(loadRef);
  return client.post(`/dispatcher/loads/${id}/agent/commands`, { kind, ...(payload !== undefined ? { payload } : {}) });
}

export function createTools(client: NightShiftClient): Record<string, ToolDefinition> {
  return {
    list_watched_loads: {
      description: "List the loads Night Shift's agent is currently watching for this org, with each one's pill and latest line.",
      inputSchema: {},
      handler: async () => client.get("/dispatcher/night-shift/loads"),
    },

    load_status: {
      description: "The full status and timeline for one load — its pill, current line, and every event/update so far.",
      inputSchema: { loadRef: z.string().min(1).describe("The board's LOAD# or the TMS order reference — not a uuid.") },
      handler: async ({ loadRef }) => {
        const id = await client.lookupLoadId(loadRef as string);
        return client.get(`/dispatcher/loads/${id}/agent`);
      },
    },

    watch_load: {
      description:
        "Turn the agent on for a load. Starts shadow unless the chosen policy is already live — this tool can never flip a policy to live itself. Defaults to the Standard policy when none is named.",
      inputSchema: {
        loadRef: z.string().min(1).describe("The board's LOAD# or the TMS order reference."),
        policy: z.string().min(1).optional().describe('A policy name (e.g. "Standard", "Aggressive"). Omit to use whatever the load already has, or Standard.'),
      },
      handler: async ({ loadRef, policy }) => {
        const id = await client.lookupLoadId(loadRef as string);
        const policyId = policy ? (await client.policyByName(policy as string)).id : undefined;
        return client.post(`/dispatcher/loads/${id}/agent`, { enabled: true, ...(policyId ? { policyId } : {}) });
      },
    },

    stop: {
      description: "Turn the agent off for a load.",
      inputSchema: { loadRef: z.string().min(1) },
      handler: async ({ loadRef }) => queueCommand(client, loadRef as string, "stop"),
    },

    call_now: {
      description: "Have the agent call the driver right now instead of waiting for its next scheduled check-in.",
      inputSchema: { loadRef: z.string().min(1) },
      handler: async ({ loadRef }) => queueCommand(client, loadRef as string, "call"),
    },

    takeover: {
      description: "Take supervision of this load's agent away from automatic escalation — a human (you) has it now.",
      inputSchema: { loadRef: z.string().min(1) },
      handler: async ({ loadRef }) => queueCommand(client, loadRef as string, "takeover"),
    },

    handback: {
      description: "Hand a load you took over back to the agent.",
      inputSchema: { loadRef: z.string().min(1) },
      handler: async ({ loadRef }) => queueCommand(client, loadRef as string, "handback"),
    },

    reply: {
      description: "Send a free-text reply into the load's timeline — e.g. answering a driver's question while you have takeover.",
      inputSchema: { loadRef: z.string().min(1), text: z.string().min(1) },
      handler: async ({ loadRef, text }) => queueCommand(client, loadRef as string, "reply", { text }),
    },

    correct: {
      description: "Correct the agent's classification of the driver's last reply (e.g. it misread a delay as an arrival).",
      inputSchema: { loadRef: z.string().min(1), key: z.string().min(1) },
      handler: async ({ loadRef, key }) => queueCommand(client, loadRef as string, "correct", { key }),
    },

    list_policies: {
      description: "List this org's Night Shift policies (thresholds, shadow/live, contacts) and how many loads run under each.",
      inputSchema: {},
      handler: async () => client.get("/dispatcher/night-shift/policies"),
    },

    set_policy: {
      description:
        'Edit a policy by name (thresholds, contacts, quiet hours, etc) — only the fields named in the patch change, everything else on the policy is kept as-is. Refuses if the patch touches "shadow" — going live is a click on the Night Shift page, never a tool call.',
      inputSchema: {
        name: z.string().min(1).describe("The policy's name, as list_policies shows it."),
        patch: policyPatchSchema.describe("Only the fields to change — everything else on the policy is kept as-is."),
      },
      // Fix round 1: this used to GET the policy, merge the patch onto it
      // HERE, and PUT the whole merged object back — a field changed by
      // anything else (a dispatcher on the Settings page, a second tool
      // call) between that read and that write got silently reverted by
      // the stale copy this tool was still holding. It now sends the
      // patch fields alone to PATCH /night-shift/policies/:id, which does
      // the merge server-side against a fresh read (dispatcherNightShift.ts)
      // — nothing can land in the gap any more because there is no gap.
      // The policy NAME still has to be resolved to an id via
      // list_policies first (PATCH, like PUT, takes an id in the path).
      handler: async ({ name, patch }) => {
        const patchObj = patch as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(patchObj, "shadow")) {
          throw new Error("live mode is changed on the Night Shift page, not from a tool");
        }
        const policy = await client.policyByName(name as string);
        return client.patch(`/dispatcher/night-shift/policies/${policy.id}`, patchObj);
      },
    },

    usage: {
      description: "Night Shift's usage/billing summary for this org.",
      inputSchema: { range: z.string().optional().describe('Optional range hint, e.g. "last-7-days" — the wallet ledger is not built yet, so this is currently always empty.') },
      handler: async ({ range }) => client.get(`/dispatcher/night-shift/usage${range ? `?range=${encodeURIComponent(range as string)}` : ""}`),
    },
  };
}
