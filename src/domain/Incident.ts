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
  escalationLevel: number; responseBreached: boolean; resolutionBreached: boolean;
  responseWarned: boolean; resolutionWarned: boolean; related: string[];
}

export interface Feedback {
  rating: number; // 1–5
  comment: string;
}

/** The facts a reporter supplies, and the only ones that can be corrected later. */
export interface IncidentDetails {
  title: string;
  description: string;
  service: ITService;
  impact: Level;
  urgency: Level;
  affectedUsers: number;
}

const isLevel = (v: unknown): v is Level => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4;

/**
 * The core aggregate. All fields are private. Lifecycle moves, notes and edits
 * all ask the current State object first, and every method validates before it
 * changes anything, so a rejected call leaves the incident exactly as it was.
 */
export class Incident {
  private state: IncidentState = new NewState();
  private details: IncidentDetails;
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
  private _responseWarned = false;
  private _resolutionWarned = false;
  private readonly notes: IncidentNote[] = [];
  private readonly relatedIds = new Set<string>();

  constructor(
    readonly id: string,
    readonly reporter: User,
    title: string,
    description: string,
    service: ITService,
    impact: Level,
    urgency: Level,
    affectedUsers: number,
    readonly createdAt: Date,
  ) {
    this.details = Incident.checked({ title, description, service, impact, urgency, affectedUsers });
  }

  private static checked(d: IncidentDetails): IncidentDetails {
    if (typeof d.title !== "string" || d.title.trim().length < 5) throw new InvalidInputException("Title must be at least 5 characters");
    if (d.title.trim().length > 200) throw new InvalidInputException("Title must be at most 200 characters");
    if (typeof d.description !== "string" || d.description.trim().length < 10) throw new InvalidInputException("Description must be at least 10 characters");
    if (d.description.trim().length > 5000) throw new InvalidInputException("Description must be at most 5000 characters");
    if (!isLevel(d.impact) || !isLevel(d.urgency)) throw new InvalidInputException("Impact and urgency must be 1–4");
    if (!Number.isInteger(d.affectedUsers) || d.affectedUsers < 1) throw new InvalidInputException("Affected users must be a whole number of at least 1");
    return { ...d, title: d.title.trim(), description: d.description.trim() };
  }

  // ---------- read-only views ----------
  get title(): string { return this.details.title; }
  get description(): string { return this.details.description; }
  get service(): ITService { return this.details.service; }
  get impact(): Level { return this.details.impact; }
  get urgency(): Level { return this.details.urgency; }
  get affectedUsers(): number { return this.details.affectedUsers; }
  get status(): IncidentStatus { return this.state.status; }
  get isOpen(): boolean { return this.state.isOpen(); }
  get isAwaitingReporter(): boolean { return this.state.isAwaitingReporter(); }
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
  get responseWarned(): boolean { return this._responseWarned; }
  get resolutionWarned(): boolean { return this._resolutionWarned; }
  get timeline(): readonly IncidentNote[] { return this.notes; }
  get related(): string[] { return [...this.relatedIds]; }

  // ---------- lifecycle (each delegates legality to the State) ----------
  classify(category: string): void {
    const next = this.state.classify();
    this._category = category.toUpperCase();
    this.state = next;
  }

  /** Corrects the category after triage; allowed in any state that still accepts edits. */
  reclassify(category: string): void {
    this.state.amend();
    this._category = category.toUpperCase();
  }

  /** Corrects the reported facts. Returns the names of the fields that actually changed. */
  amend(changes: Partial<IncidentDetails>): string[] {
    this.state.amend();
    const next = Incident.checked({ ...this.details, ...changes });
    const changed = (Object.keys(next) as (keyof IncidentDetails)[]).filter((k) => next[k] !== this.details[k]);
    this.details = next;
    return changed;
  }

  /** Priority and deadlines only make sense while the incident is open work. */
  setPriority(priority: Priority, score: number): void {
    this.state.amend();
    this._priority = priority;
    this._priorityScore = score;
  }

  setSla(deadlines: SLADeadlines): void {
    this.state.amend();
    if (deadlines.resolveBy < deadlines.responseBy) throw new InvalidInputException("Resolution deadline cannot be before the response deadline");
    this._sla = deadlines;
    // New deadlines mean earlier warnings no longer describe them.
    this._responseWarned = false;
    this._resolutionWarned = false;
  }

  /** Returns the previously assigned technician, if it changed hands. */
  assign(tech: Technician): Technician | undefined {
    const next = this.state.assign();
    const previous = this._assignee;
    if (previous?.id === tech.id) throw new InvalidInputException(`${this.id} is already assigned to ${tech.name}`);
    tech.takeIncident(this.id); // throws if overloaded, before anything changes
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
    this.state.annotate();
    if (typeof text !== "string" || !text.trim()) throw new InvalidInputException("Note text is required");
    if (text.length > 5000) throw new InvalidInputException("Note must be at most 5000 characters");
    this.notes.push(new IncidentNote(author, kind, text.trim(), at));
  }

  /** Pauses the incident with a question for the reporter. The note is validated before the state moves. */
  requestInfo(author: User, question: string, at: Date): void {
    const next = this.state.requestInfo();
    this.addNote(author, "INFO_REQUEST", question, at);
    this.state = next;
  }

  provideInfo(author: User, answer: string, at: Date): void {
    const next = this.state.provideInfo();
    this.addNote(author, "INFO_RESPONSE", answer, at);
    this.state = next;
  }

  resolve(resolution: string, at: Date): void {
    const next = this.state.resolve();
    if (typeof resolution !== "string" || resolution.trim().length < 10) throw new InvalidInputException("Resolution must describe the fix (10+ chars)");
    this.state = next;
    this._resolution = resolution.trim();
    this._resolvedAt = at;
    this._assignee?.releaseIncident(this.id, this.service.id);
  }

  verify(): void { this.state = this.state.verify(); }

  close(at: Date): void {
    this.state = this.state.close();
    this._closedAt = at;
  }

  /**
   * Back to work. Normally the same technician carries on; if they have no room,
   * the caller passes someone to take over, who then has to acknowledge it.
   */
  reopen(takeover?: Technician): void {
    const reopened = this.state.reopen();
    const next = takeover ? reopened.assign() : reopened;
    (takeover ?? this._assignee)?.takeIncident(this.id); // throws if overloaded, before anything changes
    if (takeover) this._assignee = takeover;
    this.state = next;
    this._resolvedAt = undefined;
  }

  giveFeedback(feedback: Feedback): void {
    if (this.isOpen) throw new InvalidInputException("Feedback can only be given after resolution");
    if (this._feedback) throw new InvalidInputException("Feedback has already been given for this incident");
    if (!Number.isInteger(feedback.rating) || feedback.rating < 1 || feedback.rating > 5) throw new InvalidInputException("Rating must be a whole number from 1 to 5");
    this._feedback = { rating: feedback.rating, comment: String(feedback.comment ?? "").trim().slice(0, 1000) };
  }

  // ---------- persistence: a plain-data snapshot of the private state ----------
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
      resolutionBreached: this._resolutionBreached, responseWarned: this._responseWarned,
      resolutionWarned: this._resolutionWarned, related: this.related,
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
    inc._responseWarned = s.responseWarned;
    inc._resolutionWarned = s.resolutionWarned;
    inc.notes.push(...refs.notes);
    s.related.forEach((r) => inc.relatedIds.add(r));
    return inc;
  }

  // ---------- SLA / escalation bookkeeping (monotonic: these only ever move forward) ----------
  markResponseWarned(): void { this._responseWarned = true; }
  markResolutionWarned(): void { this._resolutionWarned = true; }
  markResponseBreached(): void { this._responseBreached = true; }
  markResolutionBreached(): void { this._resolutionBreached = true; }

  /** Moves up one rung of the escalation ladder; never past the top. */
  escalate(maxLevel: number): number {
    if (this._escalationLevel < maxLevel) this._escalationLevel++;
    return this._escalationLevel;
  }

  linkRelated(otherId: string): void { if (otherId !== this.id) this.relatedIds.add(otherId); }
}
