// Google's API errors arrive as GaxiosErrors carrying an HTTP status and a
// human sentence ("Google Sheets API has not been used in project … before
// or it is disabled", "This operation is not supported for this document").
// Left alone they fall into errorHandler as a bare 4xx "Invalid request",
// which tells the dispatcher nothing. This turns them into a 502 that
// carries Google's own words, so the Connect page can show them.
import type { Response } from "express";

interface GoogleishError { code?: number | string; status?: number; message?: string; response?: { status?: number; data?: { error?: { message?: string } } } }

export function isGoogleError(e: unknown): e is GoogleishError {
  if (!e || typeof e !== "object") return false;
  const g = e as GoogleishError;
  const status = g.response?.status ?? (typeof g.code === "number" ? g.code : g.status);
  return typeof status === "number" && status >= 400 && status < 600 && typeof g.message === "string" && (Boolean(g.response) || /google|sheets|oauth|invalid_grant|forbidden/i.test(g.message));
}

export function googleMessage(e: GoogleishError): string {
  const raw = e.response?.data?.error?.message ?? e.message ?? "Google refused the request";
  // The one every first-time user hits: an .xlsx uploaded to Drive is not a
  // Google Sheet. Say what to do instead of quoting the API.
  if (/must not be an Office file/i.test(raw)) return "That file is an Excel upload, not a Google Sheet. In Drive open it, then File → Save as Google Sheets, and paste the link of the new file.";
  return raw;
}

/** Answer a Google failure; returns true when it handled the error. */
export function replyGoogleError(res: Response, e: unknown): boolean {
  if (!isGoogleError(e)) return false;
  res.status(502).json({ error: "GOOGLE", message: "Google said: " + googleMessage(e) });
  return true;
}
