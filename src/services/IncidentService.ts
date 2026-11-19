import { Category, ITService } from "../domain/catalog";
import { Incident, IncidentDetails } from "../domain/Incident";
import { IncidentStatus, Level, Permission } from "../domain/enums";
import { Technician, User } from "../domain/users";
import { EventBus, IncidentEventType } from "../events/EventBus";
import {
  IncidentNotFoundException,
  InvalidInputException,
  ItsmError,
  ServiceNotFoundException,
  TechnicianUnavailableException,
  UnauthorizedOperationException,
} from "../exceptions/errors";
import { Categorizer, DuplicateDetector, DuplicateMatch, ResolutionSuggester } from "../intelligence/intelligence";
import { IdGenerator, Repository } from "../repositories/Repository";
import { AssignmentStrategy, AssignmentStrategyFactory } from "../strategies/assignment/AssignmentStrategy";
import { PriorityStrategy, PriorityStrategyFactory } from "../strategies/priority/PriorityStrategy";
import { Clock } from "./Clock";
import { hhmm, SLAService } from "./SLAService";

export interface ReportIncidentInput {
  title: string;
  description: string;
  serviceId: string;
  impact: Level;
  urgency: Level;
  affectedUsers: number;
  category?: string; // optional: auto-suggested if omitted
}

/** Fields an administrator or the assigned technician may correct after triage. */
export interface IncidentChanges {
  title?: string;
  description?: string;
  serviceId?: string;
  impact?: Level;
  urgency?: Level;
  affectedUsers?: number;
  category?: string;
}

export interface IncidentServiceDeps {
  incidents: Repository<Incident>;
  users: Repository<User>;
  services: Repository<ITService>;
  categories: Repository<Category>;
  bus: EventBus;
  clock: Clock;
  sla: SLAService;
  priorityStrategy: PriorityStrategy;
  assignmentStrategy: AssignmentStrategy;
  categorizer: Categorizer;
  duplicateDetector: DuplicateDetector;
  resolutionSuggester: ResolutionSuggester;
}

const LEVEL_NAME = (l: Level) => Level[l].toLowerCase();

/**
 * Application service that orchestrates the incident lifecycle: one entry point per use case.
 * It holds the strategies by composition and can swap them at runtime.
 */
export class IncidentService {
  private readonly ids = new IdGenerator("INC", 1001);
  private priorityStrategy: PriorityStrategy;
  private assignmentStrategy: AssignmentStrategy;

  constructor(private readonly d: IncidentServiceDeps) {
    this.priorityStrategy = d.priorityStrategy;
    this.assignmentStrategy = d.assignmentStrategy;
    this.ids.resumeAfter(d.incidents.findAll().map((i) => i.id));
  }

  // ======================= configuration (admin) =======================
  setAssignmentStrategy(actor: User, name: string): void {
    this.require(actor, Permission.CONFIGURE_SYSTEM, "change the assignment strategy");
    this.assignmentStrategy = AssignmentStrategyFactory.create(name);
  }

  setPriorityStrategy(actor: User, strategy: PriorityStrategy | string): void {
    this.require(actor, Permission.CONFIGURE_SYSTEM, "change the priority strategy");
    this.priorityStrategy = typeof strategy === "string" ? PriorityStrategyFactory.create(strategy) : strategy;
  }

  get categorizerName(): string {
    return this.d.categorizer.name;
  }

  get currentStrategies() {
    return { priority: this.priorityStrategy.name, assignment: this.assignmentStrategy.name };
  }

  // ======================= reporting pipeline =======================
  /** Create → classify → prioritize → SLA → duplicate check → auto-assign. */
  async report(actor: User, input: ReportIncidentInput): Promise<{ incident: Incident; duplicates: DuplicateMatch[] }> {
    this.require(actor, Permission.REPORT_INCIDENT, "report incidents");
    const service = this.activeService(input.serviceId);
    this.checkAffected(service, input.affectedUsers);

    const now = this.d.clock.now();
    const inc = new Incident(
      this.ids.peek(), actor, input.title, input.description, service,
      input.impact, input.urgency, input.affectedUsers, now,
    );
    // Compute everything that can fail BEFORE persisting, so a bad request never leaves a half-built incident.
    const p = this.priorityStrategy.calculate(inc);
    const deadlines = this.d.sla.deadlinesFor(p.priority, now);
    let category: string;
    let how: string;
    if (input.category) {
      category = this.knownCategory(input.category);
      how = "by reporter";
    } else {
      const s = await this.d.categorizer.suggest(inc.title, inc.description, this.d.categories.findAll());
      category = this.d.categories.findById(s.category) ? s.category : this.fallbackCategory();
      how = `automatically by ${s.source ?? this.d.categorizer.name} (confidence ${(s.confidence * 100).toFixed(0)}%)`;
    }

    this.d.incidents.save(inc);
    this.ids.generate(); // the ID is only used up once the incident really exists
    this.emit(inc, IncidentEventType.CREATED, actor.id, null, `created by ${actor.role} ${actor.id}: "${inc.title}"`);

    // 1. classify (manual or automatic)
    this.transition(inc, "SYSTEM", IncidentEventType.CLASSIFIED, `classified as ${category} ${how}`, () => inc.classify(category));

    // 2. priority + SLA
    this.transition(inc, "SYSTEM", IncidentEventType.PRIORITY_SET,
      `priority ${p.priority} via ${this.priorityStrategy.name} (${p.rationale}); resolve by ${hhmm(deadlines.resolveBy)}`,
      () => { inc.setPriority(p.priority, p.score); inc.setSla(deadlines); });

    // 3. duplicates / related incidents
    const duplicates = this.d.duplicateDetector.findDuplicates(inc, this.d.incidents.findAll());
    if (duplicates.length) {
      for (const m of duplicates) {
        inc.linkRelated(m.incident.id);
        m.incident.linkRelated(inc.id);
        this.d.incidents.save(m.incident);
      }
      this.d.incidents.save(inc);
      this.emit(inc, IncidentEventType.DUPLICATE_SUSPECTED, "SYSTEM", inc.status,
        `possibly related to ${duplicates.map((m) => `${m.incident.id} (${(m.similarity * 100).toFixed(0)}%)`).join(", ")}`);
    }

    // 4. auto-assign (failure is not fatal: the incident waits, administrators are told, and the monitor retries)
    try {
      this.autoAssign(inc);
    } catch (e) {
      if (!(e instanceof TechnicianUnavailableException)) throw e;
      this.emit(inc, IncidentEventType.ASSIGNMENT_FAILED, "SYSTEM", inc.status, `waiting for a technician: ${e.message}`);
    }
    return { incident: inc, duplicates };
  }

  // ======================= editing (admin or the assigned technician) =======================
  /** Corrects the reported facts; priority and SLA deadlines are recalculated when they depend on what changed. */
  updateDetails(actor: User, id: string, changes: IncidentChanges): Incident {
    const inc = this.asAssignee(actor, id, "edit");
    const patch: Partial<IncidentDetails> = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.impact !== undefined) patch.impact = changes.impact;
    if (changes.urgency !== undefined) patch.urgency = changes.urgency;
    if (changes.affectedUsers !== undefined) patch.affectedUsers = changes.affectedUsers;
    if (changes.serviceId !== undefined && changes.serviceId !== inc.service.id) patch.service = this.activeService(changes.serviceId);
    this.checkAffected(patch.service ?? inc.service, patch.affectedUsers ?? inc.affectedUsers);
    const category = changes.category !== undefined ? this.knownCategory(changes.category) : inc.category;

    const before = this.describe(inc);
    const original: IncidentDetails = { title: inc.title, description: inc.description, service: inc.service, impact: inc.impact, urgency: inc.urgency, affectedUsers: inc.affectedUsers };
    const changed = inc.amend(patch); // rejected by the State once the incident is resolved or closed
    if (changed.length === 0 && category === inc.category) throw new InvalidInputException("Nothing was changed");

    // Work out the new priority before saving, so a failure here puts the incident back exactly as it was.
    let priority;
    let deadlines;
    try {
      priority = this.priorityStrategy.calculate(inc);
      deadlines = this.d.sla.deadlinesFor(priority.priority, inc.createdAt);
    } catch (e) {
      inc.amend(original);
      throw e;
    }

    const after = this.describe(inc);
    const diffs = (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]).map((k) => `${k} ${before[k]} → ${after[k]}`);
    if (category && category !== inc.category) {
      this.transition(inc, actor.id, IncidentEventType.CLASSIFIED, `re-classified from ${inc.category} to ${category}`, () => inc.reclassify(category));
    }
    if (changed.length) {
      this.d.incidents.save(inc);
      this.emit(inc, IncidentEventType.UPDATED, actor.id, inc.status, `details corrected: ${diffs.join("; ") || changed.join(", ")}`);
    }
    this.applyPriority(inc, actor.id, priority, deadlines);
    return inc;
  }

  /** Called when something the priority depends on changes outside the incident, e.g. a service's criticality. */
  reprioritiseOpenIncidents(actor: User, serviceId: string): number {
    this.require(actor, Permission.CONFIGURE_SYSTEM, "re-prioritise incidents");
    let moved = 0;
    for (const inc of this.d.incidents.findAll()) {
      if (!inc.isOpen || inc.service.id !== serviceId || !inc.priority) continue;
      const p = this.priorityStrategy.calculate(inc);
      if (this.applyPriority(inc, actor.id, p, this.d.sla.deadlinesFor(p.priority, inc.createdAt))) moved++;
    }
    return moved;
  }

  private applyPriority(inc: Incident, actorId: string, p: ReturnType<PriorityStrategy["calculate"]>, deadlines: ReturnType<SLAService["deadlinesFor"]>): boolean {
    if (p.priority === inc.priority) {
      if (p.score !== inc.priorityScore) { inc.setPriority(p.priority, p.score); this.d.incidents.save(inc); }
      return false;
    }
    const old = inc.priority;
    this.transition(inc, actorId, IncidentEventType.PRIORITY_CHANGED,
      `priority changed from ${old} to ${p.priority} (${p.rationale}); now resolve by ${hhmm(deadlines.resolveBy)}`,
      () => { inc.setPriority(p.priority, p.score); inc.setSla(deadlines); });
    return true;
  }

  private describe(inc: Incident) {
    return {
      title: `"${inc.title}"`, description: `${inc.description.length} characters`, service: inc.service.name,
      impact: LEVEL_NAME(inc.impact), urgency: LEVEL_NAME(inc.urgency), "affected users": String(inc.affectedUsers),
    };
  }

  // ======================= assignment =======================
  /** Assign or reassign. With no technician named, the current strategy picks someone other than the present owner. */
  assign(actor: User, incidentId: string, technicianId?: string): Incident {
    this.require(actor, Permission.ASSIGN_INCIDENT, "assign incidents");
    const inc = this.find(incidentId);
    if (!technicianId) return this.autoAssign(inc, actor.id);
    const tech = this.d.users.findById(technicianId);
    if (!(tech instanceof Technician)) throw new InvalidInputException(`${technicianId} is not a technician`);
    if (!tech.active) throw new TechnicianUnavailableException(`${tech.name}'s account is deactivated`);
    if (!tech.available) throw new TechnicianUnavailableException(`${tech.name} is marked unavailable`);
    return this.transition(inc, actor.id, IncidentEventType.ASSIGNED, `manually assigned to ${tech.id} (${tech.name})`, () => inc.assign(tech));
  }

  private autoAssign(inc: Incident, actorId = "SYSTEM", why = ""): Incident {
    const techs = this.d.users.findAll().filter((u): u is Technician => u instanceof Technician && u.id !== inc.assignee?.id);
    const chosen = this.assignmentStrategy.select(inc, techs);
    return this.transition(inc, actorId, IncidentEventType.ASSIGNED,
      `assigned to ${chosen.id} (${chosen.name}) via ${this.assignmentStrategy.name}${why}, workload now ${chosen.workload + 1}`,
      () => inc.assign(chosen));
  }

  /** System-initiated hand-over (escalation, technician away). Returns false when nobody else can take it. */
  handOver(inc: Incident, reason: string): boolean {
    if (!inc.isOpen || !inc.assignee) return false;
    try {
      this.autoAssign(inc, "SYSTEM", ` (${reason})`);
      return true;
    } catch (e) {
      if (!(e instanceof TechnicianUnavailableException)) throw e;
      return false;
    }
  }

  /** Moves a technician's open work to colleagues, e.g. when they are marked away or deactivated. */
  releaseWorkOf(actor: User, tech: Technician, reason: string): { moved: number; kept: number } {
    this.require(actor, Permission.ASSIGN_INCIDENT, "reassign incidents");
    let moved = 0;
    let kept = 0;
    for (const inc of this.d.incidents.findAll()) {
      if (!inc.isOpen || inc.assignee?.id !== tech.id) continue;
      if (this.handOver(inc, reason)) moved++; else kept++;
    }
    return { moved, kept };
  }

  /** The background monitor calls this so incidents that found nobody free get picked up as soon as someone is. */
  retryUnassigned(): number {
    let assigned = 0;
    for (const inc of this.d.incidents.findAll()) {
      if (!inc.isOpen || inc.assignee) continue;
      try {
        this.autoAssign(inc, "SYSTEM", " (retried)");
        assigned++;
      } catch (e) {
        if (!(e instanceof ItsmError)) throw e; // still nobody free, or not in an assignable state: try again next round
      }
    }
    return assigned;
  }

  // ======================= technician actions =======================
  acknowledge(actor: User, id: string): Incident {
    const inc = this.asAssignee(actor, id);
    return this.transition(inc, actor.id, IncidentEventType.ACKNOWLEDGED, "technician acknowledged incident", () => inc.acknowledge(this.d.clock.now()));
  }

  startWork(actor: User, id: string): Incident {
    const inc = this.asAssignee(actor, id);
    return this.transition(inc, actor.id, IncidentEventType.WORK_STARTED, "investigation started", () => inc.startWork());
  }

  addInvestigationNote(actor: User, id: string, text: string): Incident {
    const inc = this.asAssignee(actor, id);
    return this.transition(inc, actor.id, IncidentEventType.NOTE_ADDED, `note: ${text}`,
      () => inc.addNote(actor, "INVESTIGATION", text, this.d.clock.now()));
  }

  requestInfo(actor: User, id: string, question: string): Incident {
    const inc = this.asAssignee(actor, id);
    return this.transition(inc, actor.id, IncidentEventType.INFO_REQUESTED, `info requested: ${question}`,
      () => inc.requestInfo(actor, question, this.d.clock.now()));
  }

  resolve(actor: User, id: string, resolution: string): Incident {
    const inc = this.asAssignee(actor, id);
    return this.transition(inc, actor.id, IncidentEventType.RESOLVED, `resolution provided: ${resolution}`,
      () => inc.resolve(resolution, this.d.clock.now()));
  }

  suggestResolutions(actor: User, id: string) {
    const inc = this.get(actor, id);
    return this.d.resolutionSuggester.suggest(inc, this.d.incidents.findAll())
      .map((s) => ({ ...s, canOpen: this.canSee(actor, this.find(s.from)) }));
  }

  // ======================= reporter actions =======================
  provideInfo(actor: User, id: string, text: string): Incident {
    const inc = this.asReporter(actor, id, Permission.ADD_INFO, "add information to");
    if (inc.isAwaitingReporter) {
      return this.transition(inc, actor.id, IncidentEventType.INFO_PROVIDED, `reporter responded: ${text}`,
        () => inc.provideInfo(actor, text, this.d.clock.now()));
    }
    // Extra information when nobody asked for it is just a comment: no state change.
    return this.transition(inc, actor.id, IncidentEventType.NOTE_ADDED, `reporter added info: ${text}`,
      () => inc.addNote(actor, "COMMENT", text, this.d.clock.now()));
  }

  verify(actor: User, id: string): Incident {
    const inc = this.asReporter(actor, id, Permission.VERIFY_RESOLUTION, "verify");
    // Separation of duties: whoever fixed it cannot also be the one who confirms the fix.
    if (inc.assignee?.id === actor.id) throw new UnauthorizedOperationException(actor.name, `verify ${id}: you resolved it, so an administrator has to confirm the fix`);
    return this.transition(inc, actor.id, IncidentEventType.VERIFIED, "reporter confirmed the fix", () => inc.verify());
  }

  reopen(actor: User, id: string, reason: string): Incident {
    const inc = this.asReporter(actor, id, Permission.VERIFY_RESOLUTION, "reopen");
    if (typeof reason !== "string" || !reason.trim()) throw new InvalidInputException("Say what is still wrong");
    const owner = inc.assignee;
    if (!owner || owner.canTakeMore()) {
      return this.transition(inc, actor.id, IncidentEventType.REOPENED, `reopened: ${reason}`, () => inc.reopen());
    }
    // The technician who fixed it has no room (or is away): hand the reopened incident to someone who does.
    const others = this.d.users.findAll().filter((u): u is Technician => u instanceof Technician && u.id !== owner.id);
    const takeover = this.assignmentStrategy.select(inc, others); // throws TechnicianUnavailableException: nothing has changed yet
    return this.transition(inc, actor.id, IncidentEventType.REOPENED,
      `reopened: ${reason}; handed to ${takeover.id} (${takeover.name}) because ${owner.name} is ${owner.available ? "at full workload" : "away"}`,
      () => inc.reopen(takeover));
  }

  feedback(actor: User, id: string, rating: number, comment: string): Incident {
    const inc = this.asReporter(actor, id, Permission.GIVE_FEEDBACK, "rate");
    return this.transition(inc, actor.id, IncidentEventType.FEEDBACK, `feedback ${rating}/5${comment ? `: ${comment}` : ""}`,
      () => inc.giveFeedback({ rating, comment }));
  }

  // ======================= admin =======================
  close(actor: User, id: string): Incident {
    this.require(actor, Permission.CLOSE_INCIDENT, "close incidents");
    const inc = this.find(id);
    return this.transition(inc, actor.id, IncidentEventType.CLOSED, "incident closed", () => inc.close(this.d.clock.now()));
  }

  // ======================= queries with visibility rules =======================
  get(actor: User, id: string): Incident {
    const inc = this.find(id);
    if (!this.canSee(actor, inc)) throw new UnauthorizedOperationException(actor.name, `view ${id}`);
    return inc;
  }

  visibleTo(actor: User): Incident[] {
    return this.d.incidents.findAll().filter((i) => this.canSee(actor, i));
  }

  /** What this user may do to this incident right now; the screens show exactly these actions. */
  canEdit(actor: User, inc: Incident): boolean {
    return inc.isOpen && (actor.can(Permission.ASSIGN_INCIDENT) || (actor.can(Permission.WORK_ON_INCIDENT) && inc.assignee?.id === actor.id));
  }

  private canSee(actor: User, inc: Incident): boolean {
    if (actor.can(Permission.VIEW_ALL_INCIDENTS)) return true;
    return actor.can(Permission.VIEW_OWN_INCIDENTS) && (inc.reporter.id === actor.id || inc.assignee?.id === actor.id);
  }

  // ======================= helpers =======================
  private find(id: string): Incident {
    const inc = this.d.incidents.findById(String(id).toUpperCase());
    if (!inc) throw new IncidentNotFoundException(id);
    return inc;
  }

  private activeService(serviceId: string): ITService {
    const service = this.d.services.findById(serviceId);
    if (!service) throw new ServiceNotFoundException(serviceId);
    if (!service.active) throw new InvalidInputException(`${service.name} has been retired; pick another service`);
    return service;
  }

  private knownCategory(name: string): string {
    const category = String(name).toUpperCase();
    if (!this.d.categories.findById(category)) throw new InvalidInputException(`Unknown category ${category}`);
    return category;
  }

  /** Used when the classifier returns nothing usable. */
  private fallbackCategory(): string {
    const all = this.d.categories.findAll();
    if (all.length === 0) throw new InvalidInputException("No incident categories are configured");
    return (all.find((c) => c.name === "SOFTWARE") ?? all[0]).name;
  }

  /** Business rule: an incident cannot affect more people than use the service. */
  private checkAffected(service: ITService, affected: number): void {
    if (Number.isInteger(affected) && affected > service.userBase) {
      throw new InvalidInputException(`${service.name} has ${service.userBase} users, so at most ${service.userBase} can be affected`);
    }
  }

  private require(actor: User, p: Permission, action: string): void {
    if (!actor.can(p)) throw new UnauthorizedOperationException(actor.name, action);
  }

  /** Administrators may act on any incident; a technician only on the ones assigned to them. */
  private asAssignee(actor: User, id: string, verb = "work on"): Incident {
    const inc = this.find(id);
    if (actor.can(Permission.ASSIGN_INCIDENT)) return inc;
    this.require(actor, Permission.WORK_ON_INCIDENT, `${verb} incidents`);
    if (inc.assignee?.id !== actor.id) throw new UnauthorizedOperationException(actor.name, `${verb} ${id} (not assigned to you)`);
    return inc;
  }

  /** Administrators may act for the reporter; anyone else needs the permission and must be the reporter. */
  private asReporter(actor: User, id: string, p: Permission, verb: string): Incident {
    const inc = this.find(id);
    if (actor.can(Permission.CLOSE_INCIDENT)) return inc;
    this.require(actor, p, `${verb} incidents`);
    if (inc.reporter.id !== actor.id) throw new UnauthorizedOperationException(actor.name, `${verb} ${id} (you did not report it)`);
    return inc;
  }

  /** Runs a mutation, persists, then publishes an event carrying the old and new status. */
  private transition(inc: Incident, actorId: string, type: IncidentEventType, message: string, mutate: () => unknown): Incident {
    const before = inc.status;
    try {
      mutate();
    } catch (e) {
      if (e instanceof ItsmError) throw e;
      throw new InvalidInputException((e as Error).message);
    }
    this.d.incidents.save(inc);
    this.emit(inc, type, actorId, before, message);
    return inc;
  }

  private emit(inc: Incident, type: IncidentEventType, actorId: string, previous: IncidentStatus | null, message: string): void {
    this.d.bus.publish({ type, incident: inc, actorId, at: this.d.clock.now(), previousStatus: previous, message });
  }
}
