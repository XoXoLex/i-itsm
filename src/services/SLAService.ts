import { SLAPolicy } from "../domain/catalog";
import { Incident, SLADeadlines } from "../domain/Incident";
import { Permission, Priority, SLAStatus } from "../domain/enums";
import { User } from "../domain/users";
import { EventBus, IncidentEventType } from "../events/EventBus";
import { MissingSLAConfigurationException, UnauthorizedOperationException } from "../exceptions/errors";
import { InMemoryRepository, Repository } from "../repositories/Repository";
import { Clock } from "./Clock";

export interface SLAViolation {
  id: string;
  incidentId: string;
  kind: "RESPONSE" | "RESOLUTION";
  deadline: Date;
  detectedAt: Date;
  priority: Priority;
}

/** Automatic escalation chain (intelligent feature). */
export const ESCALATION_CHAIN = ["TECHNICIAN", "TEAM_LEAD", "SYSTEM_ADMIN", "IT_MANAGER"] as const;

export class SLAService {
  constructor(
    private readonly policies: Repository<SLAPolicy>,
    private readonly incidents: Repository<Incident>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly violationRepo: Repository<SLAViolation> = new InMemoryRepository<SLAViolation>(),
  ) {}

  get violations(): SLAViolation[] {
    return this.violationRepo.findAll().sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
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
    const p = this.policyFor(incident.priority);
    const elapsed = now.getTime() - incident.createdAt.getTime();
    const window = incident.sla.resolveBy.getTime() - incident.createdAt.getTime();
    const responseWindow = incident.sla.responseBy.getTime() - incident.createdAt.getTime();
    const responseRisk = !incident.acknowledgedAt && elapsed >= p.warningThreshold * responseWindow;
    return responseRisk || elapsed >= p.warningThreshold * window ? SLAStatus.AT_RISK : SLAStatus.ON_TRACK;
  }

  /** Run periodically (setInterval in the server). Detects risk, breaches, and escalates. */
  checkAll(): { warnings: number; breaches: number } {
    const now = this.clock.now();
    let warnings = 0;
    let breaches = 0;

    for (const inc of this.incidents.findAll()) {
      if (!inc.isOpen || !inc.sla || !inc.priority) continue;

      if (!inc.acknowledgedAt && now > inc.sla.responseBy && !inc.responseBreached) {
        inc.markResponseBreached();
        this.record(inc, "RESPONSE", inc.sla.responseBy, now);
        this.escalate(inc, now, "not acknowledged within response target");
        breaches++;
      }

      if (now > inc.sla.resolveBy && !inc.resolutionBreached) {
        inc.markResolutionBreached();
        this.record(inc, "RESOLUTION", inc.sla.resolveBy, now);
        this.escalate(inc, now, "not resolved within resolution target");
        breaches++;
      }

      if (!inc.warned && this.statusOf(inc, now) === SLAStatus.AT_RISK) {
        inc.markWarned();
        const mins = Math.round((inc.sla.resolveBy.getTime() - now.getTime()) / 60_000);
        this.bus.publish({
          type: IncidentEventType.SLA_WARNING, incident: inc, actorId: "SYSTEM", at: now,
          previousStatus: inc.status, message: `SLA at risk: ${mins} min left to resolve (${inc.priority})`,
        });
        warnings++;
      }
      this.incidents.save(inc);
    }
    return { warnings, breaches };
  }

  private record(inc: Incident, kind: SLAViolation["kind"], deadline: Date, at: Date): void {
    this.violationRepo.save({ id: `SLAV${this.violationRepo.count() + 1}`, incidentId: inc.id, kind, deadline, detectedAt: at, priority: inc.priority! });
    this.bus.publish({
      type: IncidentEventType.SLA_BREACHED, incident: inc, actorId: "SYSTEM", at,
      previousStatus: inc.status, message: `${kind} SLA violated (deadline ${hhmm(deadline)})`,
    });
  }

  private escalate(inc: Incident, at: Date, reason: string): void {
    if (inc.escalationLevel >= ESCALATION_CHAIN.length - 1) return;
    const level = inc.escalate();
    this.bus.publish({
      type: IncidentEventType.ESCALATED, incident: inc, actorId: "SYSTEM", at,
      previousStatus: inc.status, message: `Escalated to ${ESCALATION_CHAIN[level]}: ${reason}`,
    });
  }
}

/** Server-local HH:MM for human-readable log lines. */
export const hhmm = (d: Date) => d.toTimeString().substring(0, 5);
