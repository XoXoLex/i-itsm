import { AuditEntry } from "../domain/AuditEntry";
import { Incident } from "../domain/Incident";
import { IncidentStatus, Permission, Priority, SLAStatus } from "../domain/enums";
import { Technician, User } from "../domain/users";
import { UnauthorizedOperationException } from "../exceptions/errors";
import { Repository } from "../repositories/Repository";
import { EmailLog, EmailRecord } from "../notifications/channels";
import { SLAService } from "./SLAService";

/** Search criteria. Every field is optional; all given fields must match (AND). */
export interface IncidentQuery {
  id?: string;
  text?: string;
  status?: IncidentStatus[];
  priority?: Priority[];
  category?: string;
  serviceId?: string;
  technicianId?: string;
  reporterId?: string;
  from?: Date;
  to?: Date;
  slaStatus?: SLAStatus;
  openOnly?: boolean;
}

export class ReportService {
  constructor(
    private readonly incidents: Repository<Incident>,
    private readonly users: Repository<User>,
    private readonly audit: Repository<AuditEntry>,
    private readonly sla: SLAService,
    private readonly emails: EmailLog = new EmailLog(),
  ) {}

  search(pool: Incident[], q: IncidentQuery): Incident[] {
    const text = q.text?.toLowerCase();
    return pool
      .filter((i) =>
        (!q.id || i.id.toLowerCase() === q.id.toLowerCase()) &&
        (!text || `${i.title} ${i.description}`.toLowerCase().includes(text)) &&
        (!q.status?.length || q.status.includes(i.status)) &&
        (!q.priority?.length || (i.priority !== undefined && q.priority.includes(i.priority))) &&
        (!q.category || i.category === q.category.toUpperCase()) &&
        (!q.serviceId || i.service.id === q.serviceId) &&
        (!q.technicianId || i.assignee?.id === q.technicianId) &&
        (!q.reporterId || i.reporter.id === q.reporterId) &&
        (!q.from || i.createdAt >= q.from) &&
        (!q.to || i.createdAt <= q.to) &&
        (!q.slaStatus || this.sla.statusOf(i) === q.slaStatus) &&
        (!q.openOnly || i.isOpen),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  overview(actor: User) {
    this.guard(actor);
    const all = this.incidents.findAll();
    return {
      total: all.length,
      open: all.filter((i) => i.isOpen).length,
      critical: all.filter((i) => i.isOpen && i.priority === Priority.P1).length,
      resolved: all.filter((i) => !i.isOpen).length,
      slaViolations: this.sla.violations.length,
      atRisk: all.filter((i) => this.sla.statusOf(i) === SLAStatus.AT_RISK).length,
      unassigned: all.filter((i) => i.isOpen && !i.assignee).length,
      awaitingClosure: all.filter((i) => i.status === IncidentStatus.VERIFIED).length,
      escalated: all.filter((i) => i.isOpen && i.escalationLevel > 0).length,
      avgRating: avg(all.map((i) => i.feedback?.rating).filter((r): r is number => r !== undefined)),
    };
  }

  technicianWorkload(actor: User) {
    this.guard(actor);
    return this.users
      .findAll()
      .filter((u): u is Technician => u instanceof Technician)
      .map((t) => ({ id: t.id, name: t.name, active: t.workload, max: t.maxActiveIncidents, available: t.available }));
  }

  byService(actor: User): Record<string, number> {
    this.guard(actor);
    return countBy(this.incidents.findAll(), (i) => i.service.name);
  }

  byCategory(actor: User): Record<string, number> {
    this.guard(actor);
    return countBy(this.incidents.findAll(), (i) => i.category ?? "UNCLASSIFIED");
  }

  byPriority(actor: User): Record<string, number> {
    this.guard(actor);
    return countBy(this.incidents.findAll(), (i) => i.priority ?? "NONE");
  }

  /**
   * Incidents created vs resolved per day, for the trend chart.
   * Days are the viewer's calendar days: utcOffsetMinutes is how far their clock is ahead of UTC (+330 for India).
   */
  dailyTrend(actor: User, days: number, utcOffsetMinutes = 0, now = new Date()) {
    this.guard(actor);
    const all = this.incidents.findAll();
    const day = (d: Date) => new Date(d.getTime() + utcOffsetMinutes * 60_000).toISOString().substring(0, 10);
    const out: { date: string; created: number; resolved: number }[] = [];
    for (let k = days - 1; k >= 0; k--) {
      const d = day(new Date(now.getTime() - k * 86_400_000));
      out.push({
        date: d,
        created: all.filter((i) => day(i.createdAt) === d).length,
        resolved: all.filter((i) => i.resolvedAt && day(i.resolvedAt) === d).length,
      });
    }
    return out;
  }

  /** Every email the system sent or simulated, newest first. */
  emailLog(actor: User, limit = 200): EmailRecord[] {
    if (!actor.can(Permission.VIEW_AUDIT)) throw new UnauthorizedOperationException(actor.name, "view the email log");
    return this.emails.recent(limit);
  }

  auditTrail(actor: User, incidentId?: string): AuditEntry[] {
    if (!actor.can(Permission.VIEW_AUDIT)) throw new UnauthorizedOperationException(actor.name, "view audit logs");
    return this.audit
      .findAll()
      .filter((a) => !incidentId || a.incidentId === incidentId)
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  private guard(actor: User): void {
    if (!actor.can(Permission.VIEW_REPORTS)) throw new UnauthorizedOperationException(actor.name, "view reports");
  }
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  return xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
}

function avg(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}
