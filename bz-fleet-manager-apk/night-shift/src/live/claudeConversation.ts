// The model behind a driver call (slice 3, 2026-09-19). Claude is asked,
// after every driver utterance, for exactly one of two things: the next
// question, or a verdict — one of the situation library's keys, a
// confidence, and a one-line summary. It is handed the run's facts (the
// brief and its context) and the exchange so far, and nothing else: no
// tools, no way to send, promise, or change anything. Every action still
// belongs to the ladder.
//
// The same class is the classifier for typed replies (chat/SMS): a single
// driver turn, no follow-up allowed. Below `MIN_CONFIDENCE` the verdict is
// dropped to null, the same floor the keyword matcher lives under.
import Anthropic from "@anthropic-ai/sdk";
import { memoryLines } from "../core/memory.js";
import { SITUATIONS } from "../core/situations.data.js";
import type { Brief } from "../core/types.js";
import type { ClassifierPort, ConversationContext, ConversationPort, ConversationStep } from "../ports/index.js";
import { log } from "./log.js";

export const CLAUDE_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 400;
const MIN_CONFIDENCE = 0.5;

const STEP_TOOL = {
  name: "next_step",
  description: "Your one and only way to answer: either ask the driver one more short question, or close with a verdict.",
  input_schema: {
    type: "object" as const,
    properties: {
      say: { type: "string", description: "What to say to the driver next, in plain spoken English, one or two short sentences. When done, this is the sign-off." },
      done: { type: "boolean", description: "true when you have enough to classify the situation (or the driver is not going to say more); false to ask one more question." },
      situationKey: { type: ["string", "null"], enum: [...SITUATIONS.map((s) => s.key), null], description: "The situation, from the library, once done. null when it could not be settled." },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are of situationKey." },
      summary: { type: ["string", "null"], description: "One line for the dispatcher: what the driver said, in substance. null until done." },
    },
    required: ["say", "done", "situationKey", "confidence", "summary"],
  },
};

function clockIn(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

/** Everything the model may know about the run. Facts only, from the
 *  brief; nothing the dispatcher did not put on the load. */
export function runFacts(brief: Brief, tz: string): string {
  const c = brief.context;
  const lines = [
    `Load ${brief.loadRef}: ${brief.origin.name} to ${brief.destination.name}, ${brief.equipment}.`,
    `Pickup appointment ${clockIn(brief.departAtMs, tz)}; deliver by ${clockIn(brief.deadlineAtMs, tz)} (${tz}).`,
    `Driver: ${brief.driverName}.`,
  ];
  if (c) {
    if (c.stops.length > 2) lines.push(`Stops in order: ${c.stops.map((s) => `${s.type} ${s.name}`).join("; ")}.`);
    if (c.commodity) lines.push(`Commodity: ${c.commodity}.`);
    if (c.hazmatClass) lines.push(`Hazmat class ${c.hazmatClass}.`);
    if (c.customerName) lines.push(`Customer: ${c.customerName}.`);
    if (c.hos) lines.push(`Driver's clock: ${Math.round(c.hos.driveRemainingMin / 60 * 10) / 10} h driving left, ${Math.round(c.hos.windowRemainingMin / 60 * 10) / 10} h in the 14-hour window.`);
    if (c.notes) lines.push(`Dispatcher notes: ${c.notes}`);
    if (c.apptText) lines.push(`Appointment notes: ${c.apptText}`);
    if (c.memory) {
      const remembered = memoryLines(c.memory);
      if (remembered.length) lines.push("From past runs:\n" + remembered.map((l) => "- " + l).join("\n"));
    }
  }
  return lines.join("\n");
}

export function systemPrompt(brief: Brief, reason: string, tz: string): string {
  const library = SITUATIONS.map((s) => `- ${s.key}: ${s.dispatcherNote}`).join("\n");
  return [
    "You are the night-shift dispatch assistant on a phone call with a truck driver. You called because: " + reason + ".",
    "Your only job on this call is to understand what is going on and classify it. Ask at most a few short, plain questions — one at a time — the way a calm dispatcher would. Do not promise anything, do not give instructions about the route, hours, or the appointment, do not mention rates or paperwork, and never say you will do something other than tell dispatch.",
    "When the driver has told you enough, or clearly will not say more, close politely and return a verdict.",
    "Situations you may classify into:\n" + library,
    "The run:\n" + runFacts(brief, tz),
    "Answer ONLY by calling next_step.",
  ].join("\n\n");
}

interface StepInput { say: string; done: boolean; situationKey: string | null; confidence: number; summary: string | null }

export class ClaudeConversation implements ConversationPort, ClassifierPort {
  constructor(
    private readonly client: Anthropic,
    private readonly tz: string,
    private readonly model: string = CLAUDE_MODEL,
  ) {}

  async converse(ctx: ConversationContext): Promise<ConversationStep> {
    const messages = ctx.turns.map((t) => ({ role: t.role === "driver" ? ("user" as const) : ("assistant" as const), content: t.text }));
    // Anthropic requires the conversation to start with a user turn; the
    // agent's opening script becomes part of the system prompt instead.
    const opening = messages[0]?.role === "assistant" ? messages.shift()!.content : null;
    const system = systemPrompt(ctx.brief, ctx.reason, this.tz) + (opening ? "\n\nYou opened the call with: \"" + opening + "\"" : "");
    const res = await this.client.messages.create({
      model: this.model, max_tokens: MAX_TOKENS, system, messages,
      tools: [STEP_TOOL], tool_choice: { type: "tool", name: "next_step" },
    });
    const tool = res.content.find((b) => b.type === "tool_use");
    if (!tool || tool.type !== "tool_use") throw new Error("model returned no next_step");
    const step = tool.input as StepInput;
    const key = step.done && step.situationKey && step.confidence >= MIN_CONFIDENCE ? step.situationKey : null;
    return { say: step.say, done: step.done, situationKey: key, confidence: step.confidence, summary: step.done ? step.summary : null };
  }

  /** A typed reply: one turn, no follow-up. The model is told so. */
  async classify(text: string): Promise<{ key: string | null; confidence: number }> {
    try {
      const res = await this.client.messages.create({
        model: this.model, max_tokens: MAX_TOKENS,
        system: "You are a dispatch assistant reading one text message from a truck driver who was asked what is going on. Classify it into exactly one situation, or null if it does not say. You cannot ask a follow-up: set done=true, and put a short acknowledgement in say.\n\nSituations:\n" + SITUATIONS.map((s) => `- ${s.key}: ${s.dispatcherNote}`).join("\n"),
        messages: [{ role: "user", content: text }],
        tools: [STEP_TOOL], tool_choice: { type: "tool", name: "next_step" },
      });
      const tool = res.content.find((b) => b.type === "tool_use");
      if (!tool || tool.type !== "tool_use") return { key: null, confidence: 0 };
      const step = tool.input as StepInput;
      return { key: step.situationKey && step.confidence >= MIN_CONFIDENCE ? step.situationKey : null, confidence: step.confidence };
    } catch (e) {
      // A model outage must not turn a driver's text into a crash. Unknown
      // is what the agent does with a reply it cannot read: it escalates.
      log("error", "claude classify failed — treating the reply as not understood", { error: e instanceof Error ? e.message : String(e) });
      return { key: null, confidence: 0 };
    }
  }
}
