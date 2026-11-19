import { AuditEntry } from "../domain/AuditEntry";
import { Priority, Role } from "../domain/enums";
import { Technician, User } from "../domain/users";
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
    const notification = {
      subject: `[${e.incident.id}] ${e.type.replace(/_/g, " ").toLowerCase()}`,
      body: e.message,
      incidentId: e.incident.id,
      at: e.at,
    };
    for (const recipient of this.recipientsFor(e)) {
      for (const channel of this.channels) {
        try {
          channel.send({ recipient, ...notification });
        } catch (err) {
          // One channel being down (say, email) must not stop the others from delivering.
          console.error(`[NotificationDispatcher] ${channel.name} failed:`, (err as Error).message);
        }
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
      case IncidentEventType.ACKNOWLEDGED:
      case IncidentEventType.WORK_STARTED:
      case IncidentEventType.RESOLVED:
      case IncidentEventType.INFO_REQUESTED:
        add(inc.reporter);
        break;
      case IncidentEventType.ASSIGNED:
      case IncidentEventType.UPDATED:
      case IncidentEventType.CLOSED:
        add(inc.assignee, inc.reporter);
        break;
      case IncidentEventType.PRIORITY_CHANGED:
        add(inc.assignee, inc.reporter);
        if (inc.priority === Priority.P1) add(...admins());
        break;
      case IncidentEventType.INFO_PROVIDED:
      case IncidentEventType.NOTE_ADDED:
      case IncidentEventType.FEEDBACK:
      case IncidentEventType.SLA_WARNING:
        add(inc.assignee);
        break;
      case IncidentEventType.PRIORITY_SET:
        if (inc.priority === Priority.P1) add(...admins());
        break;
      case IncidentEventType.ASSIGNMENT_FAILED:
        add(...admins());
        break;
      case IncidentEventType.VERIFIED: // an administrator has to close it
      case IncidentEventType.REOPENED:
      case IncidentEventType.SLA_BREACHED:
      case IncidentEventType.DUPLICATE_SUSPECTED:
        add(inc.assignee, ...admins());
        break;
      case IncidentEventType.ESCALATED:
        add(inc.assignee, ...this.escalationContacts(e));
        break;
    }
    // Nobody needs telling about their own action, except the confirmation that a report was received.
    if (e.type !== IncidentEventType.CREATED) set.delete(e.actorId);
    return [...set.values()].filter((u) => u.active);
  }

  /**
   * Who each rung of the escalation ladder is.
   * Team lead: the most experienced other technician with the incident's skill.
   * System administrator and IT manager: the administrator accounts.
   */
  private escalationContacts(e: IncidentEvent): User[] {
    const inc = e.incident;
    const admins = this.users.findAll().filter((u) => u.role === Role.ADMIN);
    if (inc.escalationLevel >= 2) return admins;
    const leads = this.users
      .findAll()
      .filter((u): u is Technician => u instanceof Technician && u.active && u.id !== inc.assignee?.id && u.hasSkill(inc.category ?? ""))
      .sort((a, b) => b.experienceYears - a.experienceYears);
    return leads.length ? [leads[0]] : admins;
  }
}

/** The one thing the responder needs from the incident service (keeps this file free of a circular import). */
export interface HandOver {
  handOver(incident: IncidentEvent["incident"], reason: string): boolean;
}

/**
 * Observer #3: makes escalation act, not just notify. When an incident reaches the
 * system-administrator rung and still nobody has acknowledged it, it is taken from
 * the silent technician and given to another one.
 */
export class EscalationResponder implements IncidentObserver {
  static readonly TAKEOVER_LEVEL = 2;

  constructor(private readonly incidents: HandOver) {}

  onEvent(e: IncidentEvent): void {
    if (e.type !== IncidentEventType.ESCALATED) return;
    const inc = e.incident;
    if (inc.escalationLevel !== EscalationResponder.TAKEOVER_LEVEL || inc.acknowledgedAt || !inc.assignee) return;
    this.incidents.handOver(inc, `escalation: ${inc.assignee.name} did not acknowledge`);
  }
}
