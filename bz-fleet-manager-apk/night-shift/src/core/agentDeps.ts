import type { Place, RestStop } from "./types.js";
import type { Policy } from "./policy.js";
import type { Clock, ClassifierPort, ConversationPort, EventStore, MailerPort, MessengerPort, PhonePort, RouterPort, SheetPort } from "../ports/index.js";

export interface AgentDeps {
  clock: Clock;
  router: RouterPort;
  sheet: SheetPort;
  messenger: MessengerPort;
  phone: PhonePort;
  mailer: MailerPort;
  classifier: ClassifierPort;
  /** Slice 3: when present, driver calls are multi-turn exchanges decided
   *  here. Absent (no model configured), a call is the one-question call. */
  conversation?: ConversationPort | null;
  events: EventStore;
  /** The registry the break planner and the stop rule read. */
  restStops: RestStop[];
  /** Every threshold and behaviour toggle the rules read, in place of the
   *  constants they used to import. Carried on the trip so a dispatcher can
   *  configure how the agent behaves without a code change. */
  policy: Policy;
  /** Named places used only to describe a position to a human. */
  landmarks: Place[];
  dispatcherEmail: string;
  /** When set, the dispatcher's phone rings with a spoken briefing after
   *  every escalation email. Null: email only. */
  dispatcherPhone?: string | null;
  /** IANA zone every clock label is rendered in, e.g. "America/Chicago". */
  tz: string;
}
