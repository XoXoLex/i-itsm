import { IncidentStatus } from "../domain/enums";
import { InvalidStateTransitionException } from "../exceptions/errors";

/**
 * STATE PATTERN. Each lifecycle stage is its own class. Every action is
 * rejected by default; a state only overrides the transitions it allows.
 * So NEW -> CLOSED is impossible unless some state explicitly permits it.
 */
export abstract class IncidentState {
  abstract readonly status: IncidentStatus;

  classify(): IncidentState { return this.reject("classify"); }
  assign(): IncidentState { return this.reject("assign"); }
  acknowledge(): IncidentState { return this.reject("acknowledge"); }
  startWork(): IncidentState { return this.reject("start work on"); }
  requestInfo(): IncidentState { return this.reject("request info for"); }
  provideInfo(): IncidentState { return this.reject("provide info for"); }
  resolve(): IncidentState { return this.reject("resolve"); }
  verify(): IncidentState { return this.reject("verify"); }
  reopen(): IncidentState { return this.reject("reopen"); }
  close(): IncidentState { return this.reject("close"); }

  /** Adding a note or changing the details never moves the state, but a state may still refuse it. */
  annotate(): IncidentState { return this; }
  amend(): IncidentState { return this; }

  /** Whether the incident still counts as open work. */
  isOpen(): boolean { return true; }
  /** True only while the technician is waiting for the reporter's answer. */
  isAwaitingReporter(): boolean { return false; }

  protected reject(action: string): never {
    throw new InvalidStateTransitionException(this.status, action);
  }

  static of(status: IncidentStatus): IncidentState {
    const factory: Record<IncidentStatus, () => IncidentState> = {
      [IncidentStatus.NEW]: () => new NewState(),
      [IncidentStatus.CLASSIFIED]: () => new ClassifiedState(),
      [IncidentStatus.ASSIGNED]: () => new AssignedState(),
      [IncidentStatus.ACKNOWLEDGED]: () => new AcknowledgedState(),
      [IncidentStatus.IN_PROGRESS]: () => new InProgressState(),
      [IncidentStatus.PENDING_INFO]: () => new PendingInfoState(),
      [IncidentStatus.RESOLVED]: () => new ResolvedState(),
      [IncidentStatus.VERIFIED]: () => new VerifiedState(),
      [IncidentStatus.CLOSED]: () => new ClosedState(),
    };
    return factory[status]();
  }
}

export class NewState extends IncidentState {
  readonly status = IncidentStatus.NEW;
  classify() { return new ClassifiedState(); }
}

export class ClassifiedState extends IncidentState {
  readonly status = IncidentStatus.CLASSIFIED;
  classify() { return this; } // re-classification allowed
  assign() { return new AssignedState(); }
}

export class AssignedState extends IncidentState {
  readonly status = IncidentStatus.ASSIGNED;
  assign() { return this; } // reassignment / escalation
  acknowledge() { return new AcknowledgedState(); }
}

export class AcknowledgedState extends IncidentState {
  readonly status = IncidentStatus.ACKNOWLEDGED;
  assign() { return new AssignedState(); }
  startWork() { return new InProgressState(); }
}

export class InProgressState extends IncidentState {
  readonly status = IncidentStatus.IN_PROGRESS;
  assign() { return new AssignedState(); } // handed to someone else: they must acknowledge again
  requestInfo() { return new PendingInfoState(); }
  resolve() { return new ResolvedState(); }
}

export class PendingInfoState extends IncidentState {
  readonly status = IncidentStatus.PENDING_INFO;
  assign() { return new AssignedState(); }
  provideInfo() { return new InProgressState(); }
  isAwaitingReporter() { return true; }
}

export class ResolvedState extends IncidentState {
  readonly status = IncidentStatus.RESOLVED;
  verify() { return new VerifiedState(); }
  reopen() { return new InProgressState(); }
  amend(): IncidentState { return this.reject("edit"); }
  isOpen() { return false; }
}

export class VerifiedState extends IncidentState {
  readonly status = IncidentStatus.VERIFIED;
  close() { return new ClosedState(); }
  reopen() { return new InProgressState(); }
  amend(): IncidentState { return this.reject("edit"); }
  isOpen() { return false; }
}

/** Terminal: nothing can be added or changed once an incident is closed. */
export class ClosedState extends IncidentState {
  readonly status = IncidentStatus.CLOSED;
  annotate(): IncidentState { return this.reject("add to"); }
  amend(): IncidentState { return this.reject("edit"); }
  isOpen() { return false; }
}
