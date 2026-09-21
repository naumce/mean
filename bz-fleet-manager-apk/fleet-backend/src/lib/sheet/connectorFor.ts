import type { SheetBinding } from "@prisma/client";
import { open } from "../secretBox.js";
import { clientFor } from "./googleAuth.js";
import { GoogleSheetsConnector } from "./googleConnector.js";
import { GraphExcelConnector } from "./graphConnector.js";
import type { SheetConnector } from "./connector.js";

/** The one place a `SheetBinding` row turns into a live `SheetConnector`.
 *  Tasks 8, 9 and 10 all read a binding out of Postgres and call this rather
 *  than constructing a connector themselves — so a route test can mock this
 *  single module and never touch `googleapis` or the network. */
export function connectorFor(binding: Pick<SheetBinding, "provider" | "refreshToken">): SheetConnector {
  if (binding.provider === "google") {
    return new GoogleSheetsConnector(clientFor(open(binding.refreshToken)));
  }
  return new GraphExcelConnector();
}
