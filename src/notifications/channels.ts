import { User } from "../domain/users";
import { InvalidInputException } from "../exceptions/errors";
import { IdGenerator, InMemoryRepository, Repository } from "../repositories/Repository";

export interface Notification {
  recipient: User;
  subject: string;
  body: string;
  incidentId: string;
  at: Date;
}

/** Contract every delivery mechanism implements. Adding SMS = one new class and one line in the factory. */
export interface NotificationChannel {
  readonly name: string;
  send(n: Notification): void;
}

/** Stored form of an in-app notification. */
export interface InboxItem {
  id: string;
  userId: string;
  subject: string;
  body: string;
  incidentId: string;
  at: Date;
  read: boolean;
}

/** In-app inbox shown in each user's sidebar (persisted). */
export class InAppChannel implements NotificationChannel {
  readonly name = "IN_APP";
  private readonly ids = new IdGenerator("N", 1);

  constructor(private readonly store: Repository<InboxItem> = new InMemoryRepository<InboxItem>()) {
    this.ids.resumeAfter(store.findAll().map((n) => n.id));
  }

  send(n: Notification): void {
    this.store.save({
      id: this.ids.generate(), userId: n.recipient.id, subject: n.subject, body: n.body,
      incidentId: n.incidentId, at: n.at, read: false,
    });
  }

  inboxOf(userId: string): InboxItem[] {
    return this.store
      .findAll()
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id, undefined, { numeric: true }));
  }

  markAllRead(userId: string): void {
    for (const n of this.inboxOf(userId)) if (!n.read) this.store.save({ ...n, read: true });
  }
}

export type EmailStatus = "SIMULATED" | "QUEUED" | "SENT" | "FAILED";

/** One row of the email log: what was sent to whom, and what became of it. */
export interface EmailRecord {
  id: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
  incidentId: string;
  at: Date;
  status: EmailStatus;
  detail: string;
}

/** Persisted record of every email, simulated or real, so an administrator can see what went out. */
export class EmailLog {
  private readonly ids = new IdGenerator("EM", 1);

  constructor(private readonly store: Repository<EmailRecord> = new InMemoryRepository<EmailRecord>()) {
    this.ids.resumeAfter(store.findAll().map((e) => e.id));
  }

  record(n: Notification, status: EmailStatus, detail: string): EmailRecord {
    return this.store.save({
      id: this.ids.generate(), userId: n.recipient.id, to: n.recipient.email, subject: n.subject,
      body: n.body, incidentId: n.incidentId, at: n.at, status, detail,
    });
  }

  settle(record: EmailRecord, status: EmailStatus, detail: string): void {
    this.store.save({ ...record, status, detail });
  }

  /** Newest first. */
  recent(limit = 200): EmailRecord[] {
    return this.store
      .findAll()
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id, undefined, { numeric: true }))
      .slice(0, limit);
  }
}

/** Simulated email: writes the message to the email log instead of sending it. */
export class SimulatedEmailChannel implements NotificationChannel {
  readonly name = "EMAIL_SIMULATED";

  constructor(private readonly log: EmailLog = new EmailLog()) {}

  send(n: Notification): void {
    this.log.record(n, "SIMULATED", "Not sent: no mail provider is configured");
  }
}

/**
 * ADAPTER PATTERN: wraps a third-party email API (Resend) behind our own
 * NotificationChannel interface, so the rest of the system never knows about it.
 * Delivery is asynchronous; the outcome is written back to the email log.
 */
export class ResendEmailAdapter implements NotificationChannel {
  readonly name = "EMAIL_RESEND";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly log: EmailLog = new EmailLog(),
    private readonly http: typeof fetch = fetch,
  ) {}

  send(n: Notification): void {
    const record = this.log.record(n, "QUEUED", "Handed to Resend");
    this.http("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [n.recipient.email], subject: n.subject, text: n.body }),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (res.ok) this.log.settle(record, "SENT", "Accepted by Resend");
        else this.log.settle(record, "FAILED", `Resend answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      })
      .catch((e: Error) => this.log.settle(record, "FAILED", `Could not reach Resend: ${e.message}`));
  }
}

/** What a channel may need; the factory hands each one only what it uses. */
export interface ChannelDeps {
  inbox?: Repository<InboxItem>;
  emailLog?: EmailLog;
  resendApiKey?: string;
  emailFrom?: string;
  http?: typeof fetch;
}

/** FACTORY: builds notification channels from configuration names. The composition root is its only caller. */
export class NotificationChannelFactory {
  static create(kind: string, deps: ChannelDeps = {}): NotificationChannel {
    switch (kind.toUpperCase()) {
      case "IN_APP":
        return new InAppChannel(deps.inbox);
      case "EMAIL_SIMULATED":
        return new SimulatedEmailChannel(deps.emailLog);
      case "EMAIL_RESEND":
        if (!deps.resendApiKey || !deps.emailFrom) throw new InvalidInputException("EMAIL_RESEND needs RESEND_API_KEY and EMAIL_FROM");
        return new ResendEmailAdapter(deps.resendApiKey, deps.emailFrom, deps.emailLog, deps.http);
      default:
        throw new InvalidInputException(`Unknown notification channel ${kind}`);
    }
  }

  /** EMAIL resolves to the real adapter when a key is configured, otherwise to the simulated channel. */
  static emailKind(deps: ChannelDeps): string {
    return deps.resendApiKey && deps.emailFrom ? "EMAIL_RESEND" : "EMAIL_SIMULATED";
  }
}
