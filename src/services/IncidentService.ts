import { Category, ITService } from "../domain/catalog";
import { Incident } from "../domain/Incident";
import { IncidentStatus, Level, Permission, Role } from "../domain/enums";
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
import { PriorityStrategy } from "../strategies/priority/PriorityStrategy";
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

/**
 * Application service (facade) that orchestrates the incident lifecycle.
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

  setPriorityStrategy(actor: User, strategy: PriorityStrategy): void {
    this.require(actor, Permission.CONFIGURE_SYSTEM, "change the priority strategy");
    this.priorityStrategy = strategy;
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
    const service = this.d.services.findById(input.serviceId);
    if (!service) throw new ServiceNotFoundException(input.serviceId);
    if (!Object.values(Level).includes(input.impact) || !Object.values(Level).includes(input.urgency)) {
      throw new InvalidInputException("Impact and urgency must be 1–4");
    }

    const now = this.d.clock.now();
    const inc = new Incident(
      this.ids.generate(), actor, input.title, input.description, service,
      input.impact, input.urgency, input.affectedUsers, now,
    );
    // Compute everything that can fail BEFORE persisting, so a bad request never leaves a half-built incident.
    const p = this.priorityStrategy.calculate(inc);
    const deadlines = this.d.sla.deadlinesFor(p.priority, now);
    let category: string;
    let how: string;
    if (input.category) {
      category = input.category.toUpperCase();
      if (!this.d.categories.findById(category)) throw new InvalidInputException(`Unknown category ${category}`);
      how = "by reporter";
    } else {
      const s = await this.d.categorizer.suggest(inc.title, inc.description, this.d.categories.findAll());
      category = this.d.categories.findById(s.category) ? s.category : "SOFTWARE";
      how = `automatically by ${s.source ?? this.d.categorizer.name} (confidence ${(s.confidence * 100).toFixed(0)}%)`;
    }

    this.d.incidents.save(inc);
    this.emit(inc, IncidentEventType.CREATED, actor.id, null, `created by ${actor.role} ${actor.id}: "${inc.title}"`);

    // 1. classify (manual or automatic)
    this.transition(inc, "SYSTEM", IncidentEventType.CLASSIFIED, `classified as ${category} ${how}`, () => inc.classify(category));

    // 2. priority + SLA
    inc.setPriority(p.priority, p.score);
    inc.setSla(deadlines);
    this.emit(inc, IncidentEventType.PRIORITY_SET, "SYSTEM", inc.status,
      `priority ${p.priority} via ${this.priorityStrategy.name} (${p.rationale}); resolve by ${hhmm(inc.sla!.resolveBy)}`);

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

    // 4. auto-assign (failure is not fatal: incident stays CLASSIFIED for an admin)
    try {
      this.autoAssign(inc);
    } catch (e) {
      if (!(e instanceof TechnicianUnavailableException)) throw e;
      this.emit(inc, IncidentEventType.NOTE_ADDED, "SYSTEM", inc.status, `auto-assignment failed: ${e.message}`);
    }
    return { incident: inc, duplicates };
  }

  // ======================= assignment =======================
  assign(actor: User, incidentId: string, technicianId?: string): Incident {
    this.require(actor, Permission.ASSIGN_INCIDENT, "assign incidents");
    const inc = this.find(incidentId);
    if (!technicianId) return this.autoAssign(inc, actor.id);
    const tech = this.d.users.findById(technicianId);
    if (!(tech instanceof Technician)) throw new InvalidInputException(`${technicianId} is not a technician`);
    if (!tech.available) throw new TechnicianUnavailableException(`${tech.name} is marked unavailable`);
    return this.transition(inc, actor.id, IncidentEventType.ASSIGNED, `manually assigned to ${tech.id} (${tech.name})`, () => inc.assign(tech));
  }

  private autoAssign(inc: Incident, actorId = "SYSTEM"): Incident {
    const techs = this.d.users.findAll().filter((u): u is Technician => u instanceof Technician);
    const chosen = this.assignmentStrategy.select(inc, techs);
    return this.transition(inc, actorId, IncidentEventType.ASSIGNED,
      `assigned to ${chosen.id} (${chosen.name}) via ${this.assignmentStrategy.name}, workload now ${chosen.workload + 1}`,
      () => inc.assign(chosen));
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
    return this.transition(inc, actor.id, IncidentEventType.INFO_REQUESTED, `info requested: ${question}`, () => {
      inc.requestInfo();
      inc.addNote(actor, "INFO_REQUEST", question, this.d.clock.now());
    });
  }

  resolve(actor: User, id: string, resolution: string): Incident {
    const inc = this.asAssignee(actor, id);
    return this.transition(inc, actor.id, IncidentEventType.RESOLVED, `resolution provided: ${resolution}`,
      () => inc.resolve(resolution, this.d.clock.now()));
  }

  suggestResolutions(actor: User, id: string) {
    const inc = this.get(actor, id);
    return this.d.resolutionSuggester.suggest(inc, this.d.incidents.findAll());
  }

  // ======================= reporter actions =======================
  provideInfo(actor: User, id: string, text: string): Incident {
    const inc = this.asReporter(actor, id, Permission.ADD_INFO);
    if (inc.status !== IncidentStatus.PENDING_INFO) {
      // Extra info on a non-paused incident is just a comment, no state change.
      return this.transition(inc, actor.id, IncidentEventType.NOTE_ADDED, `reporter added info: ${text}`,
        () => inc.addNote(actor, "COMMENT", text, this.d.clock.now()));
    }
    return this.transition(inc, actor.id, IncidentEventType.INFO_PROVIDED, `reporter responded: ${text}`, () => {
      inc.addNote(actor, "INFO_RESPONSE", text, this.d.clock.now());
      inc.provideInfo();
    });
  }

  verify(actor: User, id: string): Incident {
    const inc = this.asReporter(actor, id, Permission.VERIFY_RESOLUTION);
    return this.transition(inc, actor.id, IncidentEventType.VERIFIED, "reporter confirmed the fix", () => inc.verify());
  }

  reopen(actor: User, id: string, reason: string): Incident {
    const inc = this.asReporter(actor, id, Permission.VERIFY_RESOLUTION);
    return this.transition(inc, actor.id, IncidentEventType.REOPENED, `reopened: ${reason}`, () => inc.reopen());
  }

  feedback(actor: User, id: string, rating: number, comment: string): Incident {
    const inc = this.asReporter(actor, id, Permission.GIVE_FEEDBACK);
    return this.transition(inc, actor.id, IncidentEventType.FEEDBACK, `feedback ${rating}/5: ${comment}`,
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

  private canSee(actor: User, inc: Incident): boolean {
    if (actor.can(Permission.VIEW_ALL_INCIDENTS)) return true;
    return inc.reporter.id === actor.id || inc.assignee?.id === actor.id;
  }

  // ======================= helpers =======================
  private find(id: string): Incident {
    const inc = this.d.incidents.findById(id);
    if (!inc) throw new IncidentNotFoundException(id);
    return inc;
  }

  private require(actor: User, p: Permission, action: string): void {
    if (!actor.can(p)) throw new UnauthorizedOperationException(actor.name, action);
  }

  private asAssignee(actor: User, id: string): Incident {
    const inc = this.find(id);
    if (actor.role === Role.ADMIN) return inc;
    this.require(actor, Permission.WORK_ON_INCIDENT, "work on incidents");
    if (inc.assignee?.id !== actor.id) throw new UnauthorizedOperationException(actor.name, `work on ${id} (not assigned to you)`);
    return inc;
  }

  private asReporter(actor: User, id: string, p: Permission): Incident {
    const inc = this.find(id);
    if (actor.role === Role.ADMIN) return inc;
    this.require(actor, p, "do this");
    if (inc.reporter.id !== actor.id) throw new UnauthorizedOperationException(actor.name, `act on ${id} (not your incident)`);
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
