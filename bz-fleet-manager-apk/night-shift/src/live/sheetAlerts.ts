// Sync-failure email (Slice 4, Task 4): a sheet binding stuck in "error"
// tells the org's dispatcher once per DISTINCT failure — never once per
// tick — and goes quiet the moment the binding reads clean again. This is
// the worker's own notification concern, not sheet-sync logic, so it lives
// here rather than under fleet-backend/src/lib/sheet/: it never reads a row
// or a cell, only `SheetBinding`'s own status columns, the same shared
// Prisma client every other night-shift live module already imports.
import { prisma } from "../../../fleet-backend/src/db.js";
import type { MailerPort } from "../ports/index.js";

export interface AlertSheetFailuresArgs {
  mailer: MailerPort;
  portalUrl: string;
}

/** `lastError`'s raw text translated into words a dispatcher can act on
 *  without knowing what a Google API error means. Falls back to the raw
 *  text itself when nothing matches — silence would hide a real signal. */
export function translateSheetError(lastError: string): string {
  if (lastError.includes("invalid_grant") || lastError.includes("revoked")) {
    return "Google access was removed — open Night Shift → Connect and sign in again";
  }
  if (lastError.includes("429") || lastError.includes("RESOURCE_EXHAUSTED")) {
    return "Google is rate-limiting us; we retry every 5 minutes";
  }
  if (lastError.includes("Night Shift columns not found")) {
    return "the two Night Shift columns are missing — click Install on the Connect page";
  }
  return lastError;
}

const SUBJECT = "Night Shift: your sheet stopped syncing";

/** One binding's worth of what this pass needs — never a row, never a
 *  cell, never the refresh token. */
interface AlertableBinding {
  id: string;
  orgId: string;
  status: string;
  lastError: string | null;
  alertedError: string | null;
  spreadsheetTitle: string | null;
  tabTitle: string;
}

function sheetName(binding: AlertableBinding): string {
  return binding.spreadsheetTitle ? `${binding.spreadsheetTitle} — ${binding.tabTitle}` : binding.tabTitle;
}

function bodyFor(binding: AlertableBinding, portalUrl: string): string {
  return [
    `Sheet: ${sheetName(binding)}`,
    "",
    translateSheetError(binding.lastError ?? ""),
    "",
    `${portalUrl.replace(/\/+$/, "")}/night-shift?tab=connect`,
  ].join("\n");
}

/** Called once per platform poll, after `syncAllSheets()` — its `status`/
 *  `lastError` columns are exactly what that call just wrote. Fetches only
 *  bindings that could possibly need a write this tick: currently in error
 *  (a new or repeated failure), or carrying a stale `alertedError` from a
 *  binding that has since recovered. */
export async function alertSheetFailures(args: AlertSheetFailuresArgs): Promise<void> {
  const { mailer, portalUrl } = args;
  const bindings = await prisma.sheetBinding.findMany({
    where: { OR: [{ status: "error" }, { alertedError: { not: null } }] },
    select: { id: true, orgId: true, status: true, lastError: true, alertedError: true, spreadsheetTitle: true, tabTitle: true },
  });
  if (bindings.length === 0) return;

  // Fix round 1, item 3: every binding this pass could possibly email needs
  // its org's Standard policy's dispatcherEmail — one batched lookup for
  // the whole tick rather than one query per binding. A org that somehow
  // has no Standard policy yet is simply absent from the map (see below).
  const toEmail = bindings.filter((b) => b.status === "error" && b.lastError !== null && b.lastError !== b.alertedError);
  const policies = toEmail.length > 0
    ? await prisma.agentPolicy.findMany({
      where: { orgId: { in: [...new Set(toEmail.map((b) => b.orgId))] }, name: "Standard" },
      select: { orgId: true, dispatcherEmail: true },
    })
    : [];
  const dispatcherEmailByOrg = new Map(policies.map((p) => [p.orgId, p.dispatcherEmail]));

  for (const binding of bindings) {
    if (binding.status === "error" && binding.lastError !== null && binding.lastError !== binding.alertedError) {
      const dispatcherEmail = dispatcherEmailByOrg.get(binding.orgId);
      // An org that somehow has no Standard policy yet is left un-alerted
      // (retried next tick) rather than emailing nobody and marking it done.
      if (!dispatcherEmail) continue;
      await mailer.send(dispatcherEmail, SUBJECT, bodyFor(binding, portalUrl));
      await prisma.sheetBinding.update({ where: { id: binding.id }, data: { alertedError: binding.lastError } });
    } else if (binding.status !== "error" && binding.alertedError !== null) {
      await prisma.sheetBinding.update({ where: { id: binding.id }, data: { alertedError: null } });
    }
  }
}
