// Every value the live worker needs, validated once at startup. A worker
// that discovers a missing secret when it first tries to text a driver has
// discovered it at the worst possible moment; this file makes that moment
// the moment the process starts, and names the variable.
import { z } from "zod";

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +38970123456");
// Macedonian carriers do not deliver from international long codes; Twilio's
// guidance there is an alphanumeric sender (1–11 letters, digits, spaces).
// Letters cannot place a call, so an alpha sender needs a verified caller ID.
const alphaSender = z.string().regex(/^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/, "an alphanumeric sender is 1–11 letters, digits or spaces with at least one letter");
const isNumber = (s: string): boolean => s.startsWith("+");

// MODE=platform (the default) watches every load a dispatcher has switched
// on, via the shared Prisma client. MODE=file runs exactly the original,
// single-load path: one JSON file on the command line, one driver, one
// dispatcher — all three still named by env, so file mode requires them
// (see the superRefine below); platform mode gets them per load, from the
// board and the load's policy, and does not.
const modeSchema = z.union([z.literal("platform"), z.literal("file")]);

// Platform mode's sheet-sync half (final fix wave, I13). The worker imports
// fleet-backend's sync code (worker.ts -> syncAllSheets), which reads these
// at call time — a Google refresh token is unsealed with SECRET_BOX_KEY, the
// OAuth client is built from GOOGLE_*, and every status cell's note carries
// a PORTAL_URL deep link. Validated here, at startup, and each named in the
// error, instead of on the first sync at 3 a.m. Same values as
// fleet-backend's own .env.
const hex64 = z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex characters — the same SECRET_BOX_KEY fleet-backend uses");
const httpUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an http(s) url");
const PLATFORM_SHEET_VARS = ["SECRET_BOX_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "PORTAL_URL"] as const;

const schema = z.object({
  MODE: modeSchema.optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_FROM_NUMBER: z.union([e164, alphaSender]),
  TWILIO_CALLER_ID: e164.optional(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  DISPATCHER_EMAIL: z.string().email().optional(),
  DISPATCHER_PHONE: e164.optional(),
  DRIVER_PHONE: e164.optional(),
  DRIVER_NAME: z.string().min(1).optional(),
  MAPBOX_TOKEN: z.string().min(1),
  /** Slice 3: optional. Present, driver calls become conversations and
   *  typed replies are read by the model; absent, the keyword matcher and
   *  the one-question call carry on exactly as before. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.string().url().refine((u) => u.startsWith("https://"), "must be https — Twilio and browsers refuse http"),
  PORT: z.coerce.number().int().positive(),
  TZ: z.string().min(1),
  LINK_SECRET: z.string().min(16, "at least 16 characters"),
  SECRET_BOX_KEY: hex64.optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: httpUrl.optional(),
  PORTAL_URL: httpUrl.optional(),
}).superRefine((v, ctx) => {
  if (!isNumber(v.TWILIO_FROM_NUMBER) && !v.TWILIO_CALLER_ID) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TWILIO_CALLER_ID"], message: "required when TWILIO_FROM_NUMBER is an alphanumeric sender — verify your own phone under Phone Numbers → Verified Caller IDs and put it here" });
  }
  if ((v.MODE ?? "platform") === "file") {
    if (!v.DRIVER_PHONE) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DRIVER_PHONE"], message: "required when MODE=file" });
    if (!v.DRIVER_NAME) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DRIVER_NAME"], message: "required when MODE=file" });
    if (!v.DISPATCHER_EMAIL) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DISPATCHER_EMAIL"], message: "required when MODE=file" });
  } else {
    for (const name of PLATFORM_SHEET_VARS) {
      if (!v[name]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "required in platform mode — same value as fleet-backend's .env" });
    }
  }
});

export interface Config {
  /** platform (default): watch every switched-on load from the database.
   *  file: today's original one-load, one-driver command-line path. */
  mode: "platform" | "file";
  /** `fromNumber` is the SMS sender (a number or an alphanumeric ID);
   *  `callerId` is what the voice call comes from — the same number, or a
   *  verified caller ID when the sender is letters. */
  twilio: { accountSid: string; authToken: string; fromNumber: string; callerId: string };
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  /** File mode's one dispatcher. Null in platform mode, where every trip's
   *  dispatcher contact comes from its own `AgentPolicy` row instead. */
  dispatcherEmail: string | null;
  /** The phone that rings with a spoken briefing at escalation; null = email only. */
  dispatcherPhone: string | null;
  /** File mode's one driver. Null in platform mode, where every trip's
   *  driver comes from the load's Assignment or carrier contact instead. */
  driver: { phone: string; name: string } | null;
  mapboxToken: string;
  anthropicApiKey: string | null;
  databaseUrl: string;
  publicUrl: string;
  port: number;
  tz: string;
  linkSecret: string;
  /** Platform mode: the portal's origin, for the deep links the sheet's
   *  status notes carry. Null in file mode, where no sheet is synced. */
  portalUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error("night-shift config is incomplete — " + names);
  }
  const v = parsed.data;
  return {
    mode: v.MODE ?? "platform",
    twilio: { accountSid: v.TWILIO_ACCOUNT_SID, authToken: v.TWILIO_AUTH_TOKEN, fromNumber: v.TWILIO_FROM_NUMBER, callerId: v.TWILIO_CALLER_ID ?? v.TWILIO_FROM_NUMBER },
    smtp: { host: v.SMTP_HOST, port: v.SMTP_PORT, user: v.SMTP_USER, pass: v.SMTP_PASS, from: v.MAIL_FROM },
    dispatcherEmail: v.DISPATCHER_EMAIL ?? null,
    dispatcherPhone: v.DISPATCHER_PHONE ?? null,
    driver: v.DRIVER_PHONE && v.DRIVER_NAME ? { phone: v.DRIVER_PHONE, name: v.DRIVER_NAME } : null,
    mapboxToken: v.MAPBOX_TOKEN,
    anthropicApiKey: v.ANTHROPIC_API_KEY ?? null,
    databaseUrl: v.DATABASE_URL,
    publicUrl: v.PUBLIC_URL.replace(/\/+$/, ""),
    port: v.PORT,
    tz: v.TZ,
    linkSecret: v.LINK_SECRET,
    portalUrl: v.PORTAL_URL ? v.PORTAL_URL.replace(/\/+$/, "") : null,
  };
}
