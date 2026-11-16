import { User } from "../domain/users";
import { IdGenerator, InMemoryRepository, Repository } from "../repositories/Repository";

export interface Notification {
  recipient: User;
  subject: string;
  body: string;
  incidentId: string;
  at: Date;
}

/** Contract every delivery mechanism implements. Adding SMS = one new class. */
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

/** In-app inbox shown on each user's dashboard (persisted). */
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

/** Simulated email: records to an outbox. Swap for ResendEmailAdapter in production. */
export class SimulatedEmailChannel implements NotificationChannel {
  readonly name = "EMAIL";
  readonly outbox: Notification[] = [];

  send(n: Notification): void {
    this.outbox.push(n);
  }
}

/**
 * ADAPTER PATTERN: wraps a third-party email API (Resend) behind our own
 * NotificationChannel interface, so the rest of the system never knows about it.
 */
export class ResendEmailAdapter implements NotificationChannel {
  readonly name = "EMAIL";

  constructor(private readonly apiKey: string, private readonly from: string) {}

  send(n: Notification): void {
    void fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: n.recipient.email, subject: n.subject, text: n.body }),
    }).catch((e) => console.error("[ResendEmailAdapter] delivery failed:", e.message));
  }
}

/** FACTORY: builds channels from configuration strings. */
export class NotificationChannelFactory {
  static create(kind: string, config: Record<string, string> = {}): NotificationChannel {
    switch (kind.toUpperCase()) {
      case "IN_APP":
        return new InAppChannel();
      case "EMAIL_SIMULATED":
        return new SimulatedEmailChannel();
      case "EMAIL_RESEND":
        return new ResendEmailAdapter(config.apiKey, config.from);
      default:
        throw new Error(`Unknown notification channel ${kind}`);
    }
  }
}
