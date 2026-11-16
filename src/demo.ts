/**
 * Runs the three demo workflows from the project brief in the terminal.
 *   npm run demo
 */
import { Level } from "./domain/enums";
import { ItsmError } from "./exceptions/errors";
import { FakeClock } from "./services/Clock";
import { buildSystem, seed } from "./system";

const clock = new FakeClock(new Date("2026-11-20T10:05:00Z"));
const sys = buildSystem(clock);
const { admin, techs, employees, svc } = seed(sys);
const S = sys.incidentService;

async function main() {
const h = (t: string) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);
const show = (id: string) => sys.reports.auditTrail(admin, id).forEach((a) => console.log("  " + a.toString()));

// ---------------------------------------------------------------- Workflow 1
h("WORKFLOW 1: employee reports → system classifies, prioritizes, assigns, notifies");
const { incident: pay } = await S.report(employees.e1, {
  title: "Payment application unavailable",
  description: "Users are unable to complete transactions, checkout page shows error 503",
  serviceId: svc.payment.id, impact: Level.CRITICAL, urgency: Level.CRITICAL, affectedUsers: 300,
});
console.log(`${pay.id}: category=${pay.category} priority=${pay.priority} assignee=${pay.assignee?.name} status=${pay.status}`);
show(pay.id);
console.log("\nIn-app inbox of assigned technician:");
sys.inApp.inboxOf(pay.assignee!.id).forEach((n) => console.log(`  [${n.subject}] ${n.body}`));

// ---------------------------------------------------------------- Workflow 2
h("WORKFLOW 2: technician investigates → SLA monitored → resolved → user notified");
const tech = pay.assignee!;
clock.advanceMinutes(2);
S.acknowledge(tech, pay.id);
clock.advanceMinutes(3);
S.startWork(tech, pay.id);
S.addInvestigationNote(tech, pay.id, "Payment gateway pods crash-looping after config push");
S.requestInfo(tech, pay.id, "Which card types fail? All or only international?");
clock.advanceMinutes(2);
S.provideInfo(employees.e1, pay.id, "All card types fail");
clock.advanceMinutes(18); // 25 min in → past 80% of the 30-min window
console.log("SLA check:", sys.sla.checkAll(), "→ status", sys.sla.statusOf(pay));
S.resolve(tech, pay.id, "Rolled back gateway config to v2.3.1 and restarted pods");
S.verify(employees.e1, pay.id);
S.close(admin, pay.id);
S.feedback(employees.e1, pay.id, 5, "Fixed quickly");
show(pay.id);
console.log("\nEmails sent to reporter:");
sys.email.outbox.filter((n) => n.recipient.id === employees.e1.id).forEach((n) => console.log(`  → ${n.recipient.email}: ${n.subject}`));

// ---------------------------------------------------------------- Workflow 3
h("WORKFLOW 3: multiple reports → duplicates detected → SLA breach → auto-escalation");
const a = await S.report(employees.e2, {
  title: "VPN connection keeps dropping", description: "VPN disconnects every few minutes from home network",
  serviceId: svc.vpn.id, impact: Level.HIGH, urgency: Level.HIGH, affectedUsers: 40,
});
clock.advanceMinutes(1);
const b = await S.report(employees.e3, {
  title: "Cannot connect to VPN", description: "VPN connection failing, network timeout when connecting",
  serviceId: svc.vpn.id, impact: Level.HIGH, urgency: Level.HIGH, affectedUsers: 10,
});
console.log(`${b.incident.id} flagged as related to: ${b.duplicates.map((d) => `${d.incident.id} (${(d.similarity * 100).toFixed(0)}%)`).join(", ")}`);
clock.advanceMinutes(20); // nobody acknowledged → P2 response target (15 min) blown
console.log("SLA check:", sys.sla.checkAll());
show(a.incident.id);

// ---------------------------------------------------------------- invalid operations
h("EXCEPTION HANDLING");
const attempts: [string, () => unknown][] = [
  ["NEW → CLOSED style jump (close an open incident)", () => S.close(admin, a.incident.id)],
  ["employee tries to assign", () => S.assign(employees.e2, a.incident.id, techs.t1.id)],
  ["wrong technician resolves", () => S.resolve(techs.t4, a.incident.id, "Restarted the VPN concentrator")],
  ["unknown service", () => S.report(employees.e1, { title: "Something broke", description: "Unknown service test case", serviceId: "SVC-NOPE", impact: 2, urgency: 2, affectedUsers: 1 })],
  ["bad login", () => sys.auth.login("ankit@corp.local", "wrong-password")],
];
for (const [label, fn] of attempts) {
  try { await fn(); console.log(`  ✗ ${label}: no error?!`); }
  catch (e) { console.log(`  ✓ ${label} → ${(e as ItsmError).name}: ${(e as Error).message}`); }
}

// ---------------------------------------------------------------- dashboard
h("ADMIN DASHBOARD");
console.log(sys.reports.overview(admin));
console.table(sys.reports.technicianWorkload(admin));
console.log("By service:", sys.reports.byService(admin));
console.log("Strategies:", S.currentStrategies);
S.setAssignmentStrategy(admin, "LOAD_BASED");
console.log("After switch:", S.currentStrategies);
}

main();
