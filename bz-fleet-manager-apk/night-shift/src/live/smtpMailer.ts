// Email out. The dispatcher's copies get a signed one-click link that does
// what the reply vocabulary does — one tap from a phone's mail app, no
// reply-parsing, nothing to misread. A transport error is thrown: the core
// records that the escalation did NOT go out.
import { signAction } from "./tokens.js";
import type { Attachment, MailerPort } from "../ports/index.js";

/** How long a one-click link works. A day: long enough for a morning
 *  briefing to be acted on after lunch, short enough that a forwarded email
 *  is not a permanent button. */
export const ACTION_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface MailTransport {
  sendMail(opts: { from: string; to: string; subject: string; text: string; attachments?: { filename: string; content: string }[] }): Promise<{ messageId?: string }>;
}

export class SmtpMailer implements MailerPort {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly opts: { dispatcherEmail: string; publicUrl: string; linkSecret: string; tripId: string; clock: () => number },
  ) {}

  async send(to: string, subject: string, body: string, attachments: Attachment[] = []): Promise<{ messageId: string | null }> {
    let text = body;
    if (to === this.opts.dispatcherEmail) {
      const signed = signAction(this.opts.linkSecret, this.opts.tripId, "send_customer_email", this.opts.clock() + ACTION_LINK_TTL_MS);
      text += "\n\nOne click to send the customer email: " + this.opts.publicUrl + "/act/" + signed;
    }
    const info = await this.transport.sendMail({
      from: this.from, to, subject, text,
      attachments: attachments.map((a) => ({ filename: a.name, content: a.body })),
    });
    return { messageId: info.messageId ?? null };
  }
}
