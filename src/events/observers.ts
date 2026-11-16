import { AuditEntry } from "../domain/AuditEntry";
import { Priority, Role } from "../domain/enums";
import { User } from "../domain/users";
import { NotificationChannel } from "../notifications/channels";
import { IdGenerator, Repository } from "../repositories/Repository";
import { IncidentEvent, IncidentEventType, IncidentObserver } from "./EventBus";

/** Observer #1: writes every event to the audit trail. */
export class AuditLogger implements IncidentObserver {
  private readonly ids = new IdGenerator("AUD", 1);

  constructor(private readonly audit: Repository<AuditEntry>) {
    this.ids.resumeAfter(audit.findAll().map((a) => a.id));
  }

  onEvent(e: IncidentEvent): void {
    this.audit.save(
      new AuditEntry(
        this.ids.generate(),
        e.at,
        e.actorId,
        e.type,
        e.incident.id,
        e.previousStatus,
        e.incident.status,
        e.message,
      ),
    );
  }
}

/** Observer #2: decides who needs to hear about an event and fans out to every channel. */
export class NotificationDispatcher implements IncidentObserver {
  constructor(
    private readonly channels: NotificationChannel[],
    private readonly users: Repository<User>,
  ) {}

  onEvent(e: IncidentEvent): void {
    const recipients = this.recipientsFor(e);
    for (const recipient of recipients) {
      for (const channel of this.channels) {
        channel.send({
          recipient,
          subject: `[${e.incident.id}] ${e.type.replace(/_/g, " ").toLowerCase()}`,
          body: e.message,
          incidentId: e.incident.id,
          at: e.at,
        });
      }
    }
  }

  private recipientsFor(e: IncidentEvent): User[] {
    const inc = e.incident;
    const admins = () => this.users.findAll().filter((u) => u.role === Role.ADMIN);
    const set = new Map<string, User>();
    const add = (...us: (User | undefined)[]) => us.forEach((u) => u && set.set(u.id, u));

    switch (e.type) {
      case IncidentEventType.CREATED:
      case IncidentEventType.RESOLVED:
      case IncidentEventType.CLOSED:
      case IncidentEventType.INFO_REQUESTED:
        add(inc.reporter);
        break;
      case IncidentEventType.ASSIGNED:
        add(inc.assignee, inc.reporter);
        break;
      case IncidentEventType.INFO_PROVIDED:
      case IncidentEventType.REOPENED:
      case IncidentEventType.SLA_WARNING:
        add(inc.assignee);
        break;
      case IncidentEventType.PRIORITY_SET:
        if (inc.priority === Priority.P1) add(...admins());
        break;
      case IncidentEventType.SLA_BREACHED:
      case IncidentEventType.ESCALATED:
      case IncidentEventType.DUPLICATE_SUSPECTED:
        add(inc.assignee, ...admins());
        break;
    }
    return [...set.values()];
  }
}
