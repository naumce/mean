// The driver's two channels. Chat is the page (the bus); SMS is Twilio, and
// every SMS carries the driver link because every SMS is an invitation to
// talk there. A Twilio error is thrown, not swallowed: the core records a
// failed delivery and retries on the ladder's cooldown.
import type { ChatBus } from "./chatBus.js";
import type { MessengerPort } from "../ports/index.js";

export interface SmsClient {
  messages: { create(opts: { from: string; to: string; body: string }): Promise<{ sid: string }> };
}

export class TwilioMessenger implements MessengerPort {
  constructor(
    private readonly client: SmsClient,
    private readonly from: string,
    private readonly bus: ChatBus,
    private readonly trip: { tripId: string; driverToken: string },
    private readonly publicUrl: string,
    private readonly clock: () => number,
  ) {}

  async sendChat(_phone: string, text: string): Promise<void> {
    this.bus.push(this.trip.tripId, text, this.clock());
  }

  async sendSms(phone: string, text: string): Promise<void> {
    await this.client.messages.create({ from: this.from, to: phone, body: text + "\n" + this.publicUrl + "/d/" + this.trip.driverToken });
  }
}
