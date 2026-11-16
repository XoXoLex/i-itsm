import { AuditEntry } from "../domain/AuditEntry";
import { Incident } from "../domain/Incident";
import { Level } from "../domain/enums";
import { Employee, Technician, User } from "../domain/users";
import { ESCALATION_CHAIN, SLAService } from "../services/SLAService";

/** Plain JSON shapes sent to the browser. Password hashes never leave the server. */
export function userDTO(u: User) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    department: u instanceof Employee ? u.department : undefined,
    ...(u instanceof Technician
      ? { skills: u.skillList, experienceYears: u.experienceYears, workload: u.workload, maxActive: u.maxActiveIncidents, available: u.available }
      : {}),
  };
}

export function incidentDTO(i: Incident, sla: SLAService) {
  return {
    id: i.id, title: i.title, description: i.description, status: i.status, isOpen: i.isOpen,
    category: i.category ?? null, priority: i.priority ?? null, priorityScore: i.priorityScore,
    impact: i.impact, impactLabel: Level[i.impact], urgency: i.urgency, urgencyLabel: Level[i.urgency], affectedUsers: i.affectedUsers,
    createdAt: i.createdAt,
    service: { id: i.service.id, name: i.service.name, criticality: Level[i.service.criticality] },
    reporter: { id: i.reporter.id, name: i.reporter.name },
    assignee: i.assignee ? { id: i.assignee.id, name: i.assignee.name } : null,
    sla: {
      responseBy: i.sla?.responseBy ?? null, resolveBy: i.sla?.resolveBy ?? null,
      status: sla.statusOf(i), responseBreached: i.responseBreached, resolutionBreached: i.resolutionBreached,
    },
    acknowledgedAt: i.acknowledgedAt ?? null, resolvedAt: i.resolvedAt ?? null, closedAt: i.closedAt ?? null,
    resolution: i.resolution ?? null, feedback: i.feedback ?? null,
    escalationLevel: i.escalationLevel, escalatedTo: i.escalationLevel ? ESCALATION_CHAIN[i.escalationLevel] : null,
    related: i.related,
  };
}

export function incidentDetailDTO(i: Incident, sla: SLAService) {
  return {
    ...incidentDTO(i, sla),
    timeline: i.timeline.map((n) => ({ author: { id: n.author.id, name: n.author.name, role: n.author.role }, kind: n.kind, text: n.text, at: n.at })),
  };
}

export function auditDTO(a: AuditEntry) {
  return { id: a.id, at: a.at, actor: a.actor, action: a.action, incidentId: a.incidentId, previousState: a.previousState, newState: a.newState, description: a.description };
}
