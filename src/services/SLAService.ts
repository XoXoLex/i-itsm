import { SLAPolicy } from "../domain/catalog";
import { Incident, SLADeadlines } from "../domain/Incident";
import { Permission, Priority, SLAStatus } from "../domain/enums";
import { User } from "../domain/users";
import { EventBus, IncidentEventType } from "../events/EventBus";
import { MissingSLAConfigurationException, UnauthorizedOperationException } from "../exceptions/errors";
import { IdGenerator, InMemoryRepository, Repository } from "../repositories/Repository";
import { Clock } from "./Clock";

export interface SLAViolation {
  id: string;
  incidentId: string;
  kind: "RESPONSE" | "RESOLUTION";
  deadline: Date;
  detectedAt: Date;
  priority: Priority;
}

/**
 * Automatic escalation ladder (intelligent feature). Level 0 is the assigned technician.
 * Who each rung maps to is decided in one place: NotificationDispatcher.escalationContacts().
 */
export const ESCALATION_CHAIN = ["TECHNICIAN", "TEAM_LEAD", "SYSTEM_ADMIN", "IT_MANAGER"] as const;
const TOP_LEVEL = ESCALATION_CHAIN.length - 1;
const label = (level: number) => ESCALATION_CHAIN[level].replace("_", " ").toLowerCase();
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

export class SLAService {
  private readonly ids = new IdGenerator("SLAV", 1);

  constructor(
    private readonly policies: Repository<SLAPolicy>,
    private readonly incidents: Repository<Incident>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly violationRepo: Repository<SLAViolation> = new InMemoryRepository<SLAViolation>(),
  ) {
    this.ids.resumeAfter(violationRepo.findAll().map((v) => v.id));
  }

  get violations(): SLAViolation[] {
    return this.violationRepo.findAll().sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
  }

  /** Newest first, for the administrator's violations report. */
  violationsFor(actor: User): SLAViolation[] {
    if (!actor.can(Permission.VIEW_REPORTS)) throw new UnauthorizedOperationException(actor.name, "view SLA violations");
    return this.violations.reverse();
  }

  get allPolicies(): SLAPolicy[] {
    return this.policies.findAll();
  }

  configure(actor: User, policy: SLAPolicy): void {
    if (!actor.can(Permission.CONFIGURE_SYSTEM)) throw new UnauthorizedOperationException(actor.name, "configure SLA policies");
    this.policies.save(policy);
  }

  policyFor(priority: Priority): SLAPolicy {
    const p = this.policies.findById(priority);
    if (!p) throw new MissingSLAConfigurationException(priority);
    return p;
  }

  deadlinesFor(priority: Priority, from: Date): SLADeadlines {
    const p = this.policyFor(priority);
    return {
      responseBy: new Date(from.getTime() + p.responseMinutes * 60_000),
      resolveBy: new Date(from.getTime() + p.resolutionMinutes * 60_000),
    };
  }

  statusOf(incident: Incident, now = this.clock.now()): SLAStatus {
    if (!incident.sla || !incident.priority) return SLAStatus.ON_TRACK;
    if (incident.responseBreached || incident.resolutionBreached) return SLAStatus.BREACHED;
    if (!incident.isOpen) return SLAStatus.MET;
    return this.responseAtRisk(incident, now) || this.resolutionAtRisk(incident, now) ? SLAStatus.AT_RISK : SLAStatus.ON_TRACK;
  }

  /** SLA risk detection: the warning threshold (80% by default) of a window has gone by. */
  private responseAtRisk(inc: Incident, now: Date): boolean {
    if (inc.acknowledgedAt || !inc.sla || !inc.priority) return false;
    const window = inc.sla.responseBy.getTime() - inc.createdAt.getTime();
    return now.getTime() - inc.createdAt.getTime() >= this.policyFor(inc.priority).warningThreshold * window;
  }

  private resolutionAtRisk(inc: Incident, now: Date): boolean {
    if (!inc.sla || !inc.priority) return false;
    const window = inc.sla.resolveBy.getTime() - inc.createdAt.getTime();
    return now.getTime() - inc.createdAt.getTime() >= this.policyFor(inc.priority).warningThreshold * window;
  }

  /** The background monitor, exposed to administrators as "Run SLA check now". */
  runCheck(actor: User): { warnings: number; breaches: number; escalations: number } {
    if (!actor.can(Permission.CONFIGURE_SYSTEM)) throw new UnauthorizedOperationException(actor.name, "run the SLA monitor");
    return this.checkAll();
  }

  /**
   * Run periodically (a timer in the server). For every open incident it warns before each
   * deadline, records each violation once, and moves the incident up the escalation ladder
   * the longer it stays overdue.
   */
  checkAll(): { warnings: number; breaches: number; escalations: number } {
    const now = this.clock.now();
    let warnings = 0;
    let breaches = 0;
    let escalations = 0;

    for (const inc of this.incidents.findAll()) {
      if (!inc.isOpen || !inc.sla || !inc.priority) continue;
      let changed = false;

      // ---- response target: only matters until a technician acknowledges
      if (!inc.acknowledgedAt) {
        if (now > inc.sla.responseBy) {
          if (!inc.responseBreached) {
            inc.markResponseBreached();
            this.record(inc, "RESPONSE", inc.sla.responseBy, now);
            breaches++; changed = true;
          }
        } else if (!inc.responseWarned && this.responseAtRisk(inc, now)) {
          inc.markResponseWarned();
          this.warn(inc, now, `SLA at risk: ${minutes(inc.sla.responseBy.getTime() - now.getTime())} min left to acknowledge (${inc.priority})`);
          warnings++; changed = true;
        }
      }

      // ---- resolution target
      if (now > inc.sla.resolveBy) {
        if (!inc.resolutionBreached) {
          inc.markResolutionBreached();
          this.record(inc, "RESOLUTION", inc.sla.resolveBy, now);
          breaches++; changed = true;
        }
      } else if (!inc.resolutionWarned && this.resolutionAtRisk(inc, now)) {
        inc.markResolutionWarned();
        this.warn(inc, now, `SLA at risk: ${minutes(inc.sla.resolveBy.getTime() - now.getTime())} min left to resolve (${inc.priority})`);
        warnings++; changed = true;
      }

      // ---- escalation ladder: one event per rung, so the audit trail shows every step
      const target = this.escalationTarget(inc, now);
      while (inc.escalationLevel < target.level) {
        const level = inc.escalate(TOP_LEVEL);
        if (!changed) changed = true;
        this.incidents.save(inc);
        this.bus.publish({
          type: IncidentEventType.ESCALATED, incident: inc, actorId: "SYSTEM", at: now, previousStatus: inc.status,
          message: `Escalated to ${label(level)} (level ${level} of ${TOP_LEVEL}): ${target.reason}`,
        });
        escalations++;
      }

      if (changed) this.incidents.save(inc);
    }
    return { warnings, breaches, escalations };
  }

  /**
   * How far up the ladder an incident should be right now.
   * Unacknowledged: one rung at the response deadline, then one more for every further response window.
   * Unresolved: one rung at the resolution deadline, then one more for every further half resolution window.
   */
  private escalationTarget(inc: Incident, now: Date): { level: number; reason: string } {
    const sla = inc.sla!;
    let level = 0;
    let reason = "";
    if (!inc.acknowledgedAt && now > sla.responseBy) {
      const window = sla.responseBy.getTime() - inc.createdAt.getTime();
      const overdue = now.getTime() - sla.responseBy.getTime();
      level = 1 + Math.floor(overdue / window);
      reason = `not acknowledged, ${minutes(overdue)} min past the response deadline`;
    }
    if (now > sla.resolveBy) {
      const step = (sla.resolveBy.getTime() - inc.createdAt.getTime()) / 2;
      const overdue = now.getTime() - sla.resolveBy.getTime();
      const byResolution = 1 + Math.floor(overdue / step);
      if (byResolution >= level) {
        level = byResolution;
        reason = `not resolved, ${minutes(overdue)} min past the resolution deadline`;
      }
    }
    return { level: Math.min(level, TOP_LEVEL), reason };
  }

  private warn(inc: Incident, at: Date, message: string): void {
    this.bus.publish({ type: IncidentEventType.SLA_WARNING, incident: inc, actorId: "SYSTEM", at, previousStatus: inc.status, message });
  }

  private record(inc: Incident, kind: SLAViolation["kind"], deadline: Date, at: Date): void {
    this.violationRepo.save({ id: this.ids.generate(), incidentId: inc.id, kind, deadline, detectedAt: at, priority: inc.priority! });
    this.bus.publish({
      type: IncidentEventType.SLA_BREACHED, incident: inc, actorId: "SYSTEM", at,
      previousStatus: inc.status, message: `${kind} SLA violated (deadline ${hhmm(deadline)})`,
    });
  }
}

/** Server-local HH:MM for human-readable log lines. */
export const hhmm = (d: Date) => d.toTimeString().substring(0, 5);
