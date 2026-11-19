import { Incident } from "../domain/Incident";
import { IncidentStatus } from "../domain/enums";

export enum IncidentEventType {
  CREATED = "CREATED",
  CLASSIFIED = "CLASSIFIED",
  PRIORITY_SET = "PRIORITY_SET",
  PRIORITY_CHANGED = "PRIORITY_CHANGED",
  UPDATED = "UPDATED",
  ASSIGNED = "ASSIGNED",
  ASSIGNMENT_FAILED = "ASSIGNMENT_FAILED",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  WORK_STARTED = "WORK_STARTED",
  NOTE_ADDED = "NOTE_ADDED",
  INFO_REQUESTED = "INFO_REQUESTED",
  INFO_PROVIDED = "INFO_PROVIDED",
  RESOLVED = "RESOLVED",
  VERIFIED = "VERIFIED",
  CLOSED = "CLOSED",
  REOPENED = "REOPENED",
  FEEDBACK = "FEEDBACK",
  SLA_WARNING = "SLA_WARNING",
  SLA_BREACHED = "SLA_BREACHED",
  ESCALATED = "ESCALATED",
  DUPLICATE_SUSPECTED = "DUPLICATE_SUSPECTED",
}

export interface IncidentEvent {
  type: IncidentEventType;
  incident: Incident;
  actorId: string; // "SYSTEM" for automated actions
  at: Date;
  previousStatus: IncidentStatus | null;
  message: string;
}

/** OBSERVER PATTERN: anything that wants to react to incident events. */
export interface IncidentObserver {
  onEvent(event: IncidentEvent): void;
}

/** The subject. Services publish; observers (audit, notifications, metrics...) subscribe. */
export class EventBus {
  private readonly observers: IncidentObserver[] = [];

  subscribe(observer: IncidentObserver): void {
    this.observers.push(observer);
  }

  publish(event: IncidentEvent): void {
    for (const o of this.observers) {
      try {
        o.onEvent(event);
      } catch (err) {
        // One failing observer (e.g. email down) must not break the workflow.
        console.error(`[EventBus] observer ${o.constructor.name} failed:`, (err as Error).message);
      }
    }
  }
}
