import { IncidentStatus, Level, Priority } from "./enums";
import { ITService } from "./catalog";
import { Technician, User } from "./users";
import { IncidentState, NewState } from "../state/IncidentState";
import { InvalidInputException } from "../exceptions/errors";

/** A note on the incident timeline. Owned by the Incident (composition). */
export class IncidentNote {
  constructor(
    readonly author: User,
    readonly kind: "INVESTIGATION" | "INFO_REQUEST" | "INFO_RESPONSE" | "COMMENT",
    readonly text: string,
    readonly at: Date,
  ) {}
}

export interface SLADeadlines {
  responseBy: Date;
  resolveBy: Date;
}

export interface IncidentSnapshot {
  id: string; reporterId: string; title: string; description: string; serviceId: string;
  impact: Level; urgency: Level; affectedUsers: number; createdAt: string; status: IncidentStatus;
  category: string | null; priority: Priority | null; priorityScore: number; assigneeId: string | null;
  responseBy: string | null; resolveBy: string | null; acknowledgedAt: string | null; resolvedAt: string | null;
  closedAt: string | null; resolution: string | null; feedbackRating: number | null; feedbackComment: string | null;
  escalationLevel: number; responseBreached: boolean; resolutionBreached: boolean; warned: boolean; related: string[];
}

export interface Feedback {
  rating: number; // 1–5
  comment: string;
}

/**
 * The core aggregate. All fields are private; the only way to change an incident
 * is through methods that ask the current State object whether the move is legal.
 */
export class Incident {
  private state: IncidentState = new NewState();
  private _category?: string;
  private _priority?: Priority;
  private _priorityScore = 0;
  private _assignee?: Technician;
  private _sla?: SLADeadlines;
  private _acknowledgedAt?: Date;
  private _resolvedAt?: Date;
  private _closedAt?: Date;
  private _resolution?: string;
  private _feedback?: Feedback;
  private _escalationLevel = 0;
  private _responseBreached = false;
  private _resolutionBreached = false;
  private _warned = false;
  private readonly notes: IncidentNote[] = [];
  private readonly relatedIds = new Set<string>();

  constructor(
    readonly id: string,
    readonly reporter: User,
    readonly title: string,
    readonly description: string,
    readonly service: ITService,
    readonly impact: Level,
    readonly urgency: Level,
    readonly affectedUsers: number,
    readonly createdAt: Date,
  ) {
    if (title.trim().length < 5) throw new InvalidInputException("Title must be at least 5 characters");
    if (description.trim().length < 10) throw new InvalidInputException("Description must be at least 10 characters");
    if (affectedUsers < 1) throw new InvalidInputException("Affected users must be at least 1");
  }

  // ---------- read-only views ----------
  get status(): IncidentStatus { return this.state.status; }
  get isOpen(): boolean { return this.state.isOpen(); }
  get category(): string | undefined { return this._category; }
  get priority(): Priority | undefined { return this._priority; }
  get priorityScore(): number { return this._priorityScore; }
  get assignee(): Technician | undefined { return this._assignee; }
  get sla(): SLADeadlines | undefined { return this._sla; }
  get acknowledgedAt(): Date | undefined { return this._acknowledgedAt; }
  get resolvedAt(): Date | undefined { return this._resolvedAt; }
  get closedAt(): Date | undefined { return this._closedAt; }
  get resolution(): string | undefined { return this._resolution; }
  get feedback(): Feedback | undefined { return this._feedback; }
  get escalationLevel(): number { return this._escalationLevel; }
  get responseBreached(): boolean { return this._responseBreached; }
  get resolutionBreached(): boolean { return this._resolutionBreached; }
  get warned(): boolean { return this._warned; }
  get timeline(): readonly IncidentNote[] { return this.notes; }
  get related(): string[] { return [...this.relatedIds]; }

  // ---------- lifecycle (each delegates legality to the State) ----------
  classify(category: string): void {
    const next = this.state.classify();
    this._category = category.toUpperCase();
    this.state = next;
  }

  setPriority(priority: Priority, score: number): void {
    this._priority = priority;
    this._priorityScore = score;
  }

  setSla(deadlines: SLADeadlines): void {
    this._sla = deadlines;
  }

  /** Returns the previously assigned technician (if any) so the caller can release them. */
  assign(tech: Technician): Technician | undefined {
    const next = this.state.assign();
    const previous = this._assignee;
    tech.takeIncident(this.id); // throws if overloaded
    previous?.releaseIncident(this.id);
    this._assignee = tech;
    this.state = next;
    return previous;
  }

  acknowledge(at: Date): void {
    this.state = this.state.acknowledge();
    this._acknowledgedAt ??= at;
  }

  startWork(): void {
    this.state = this.state.startWork();
  }

  addNote(author: User, kind: IncidentNote["kind"], text: string, at: Date): void {
    if (!text.trim()) throw new InvalidInputException("Note text is required");
    this.notes.push(new IncidentNote(author, kind, text.trim(), at));
  }

  requestInfo(): void { this.state = this.state.requestInfo(); }
  provideInfo(): void { this.state = this.state.provideInfo(); }

  resolve(resolution: string, at: Date): void {
    if (resolution.trim().length < 10) throw new InvalidInputException("Resolution must describe the fix (10+ chars)");
    this.state = this.state.resolve();
    this._resolution = resolution.trim();
    this._resolvedAt = at;
    this._assignee?.releaseIncident(this.id, this.service.id);
  }

  verify(): void { this.state = this.state.verify(); }

  close(at: Date): void {
    this.state = this.state.close();
    this._closedAt = at;
  }

  reopen(): void {
    this.state = this.state.reopen();
    this._resolvedAt = undefined;
    this._assignee?.takeIncident(this.id);
  }

  giveFeedback(feedback: Feedback): void {
    if (this.isOpen) throw new InvalidInputException("Feedback can only be given after resolution");
    if (feedback.rating < 1 || feedback.rating > 5) throw new InvalidInputException("Rating must be 1–5");
    this._feedback = feedback;
  }

  // ---------- persistence (Memento-style snapshot) ----------
  toSnapshot(): IncidentSnapshot {
    return {
      id: this.id, reporterId: this.reporter.id, title: this.title, description: this.description,
      serviceId: this.service.id, impact: this.impact, urgency: this.urgency, affectedUsers: this.affectedUsers,
      createdAt: this.createdAt.toISOString(), status: this.status, category: this._category ?? null,
      priority: this._priority ?? null, priorityScore: this._priorityScore, assigneeId: this._assignee?.id ?? null,
      responseBy: this._sla?.responseBy.toISOString() ?? null, resolveBy: this._sla?.resolveBy.toISOString() ?? null,
      acknowledgedAt: this._acknowledgedAt?.toISOString() ?? null, resolvedAt: this._resolvedAt?.toISOString() ?? null,
      closedAt: this._closedAt?.toISOString() ?? null, resolution: this._resolution ?? null,
      feedbackRating: this._feedback?.rating ?? null, feedbackComment: this._feedback?.comment ?? null,
      escalationLevel: this._escalationLevel, responseBreached: this._responseBreached,
      resolutionBreached: this._resolutionBreached, warned: this._warned, related: this.related,
    };
  }

  static restore(
    s: IncidentSnapshot,
    refs: { reporter: User; service: ITService; assignee?: Technician; notes: IncidentNote[] },
  ): Incident {
    const inc = new Incident(s.id, refs.reporter, s.title, s.description, refs.service, s.impact, s.urgency, s.affectedUsers, new Date(s.createdAt));
    const d = (x: string | null) => (x ? new Date(x) : undefined);
    inc.state = IncidentState.of(s.status);
    inc._category = s.category ?? undefined;
    inc._priority = s.priority ?? undefined;
    inc._priorityScore = s.priorityScore;
    inc._assignee = refs.assignee;
    inc._sla = s.responseBy && s.resolveBy ? { responseBy: new Date(s.responseBy), resolveBy: new Date(s.resolveBy) } : undefined;
    inc._acknowledgedAt = d(s.acknowledgedAt);
    inc._resolvedAt = d(s.resolvedAt);
    inc._closedAt = d(s.closedAt);
    inc._resolution = s.resolution ?? undefined;
    inc._feedback = s.feedbackRating ? { rating: s.feedbackRating, comment: s.feedbackComment ?? "" } : undefined;
    inc._escalationLevel = s.escalationLevel;
    inc._responseBreached = s.responseBreached;
    inc._resolutionBreached = s.resolutionBreached;
    inc._warned = s.warned;
    inc.notes.push(...refs.notes);
    s.related.forEach((r) => inc.relatedIds.add(r));
    return inc;
  }

  // ---------- SLA / escalation bookkeeping ----------
  markWarned(): void { this._warned = true; }
  markResponseBreached(): void { this._responseBreached = true; }
  markResolutionBreached(): void { this._resolutionBreached = true; }
  escalate(): number { return ++this._escalationLevel; }
  linkRelated(otherId: string): void { if (otherId !== this.id) this.relatedIds.add(otherId); }
}
