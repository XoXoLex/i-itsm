import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystem, seed } from "../src/system";
import { FakeClock } from "../src/services/Clock";
import { IncidentStatus, Level, Priority, SLAStatus } from "../src/domain/enums";
import { Category } from "../src/domain/catalog";
import {
  InvalidInputException,
  InvalidLoginException,
  InvalidStateTransitionException,
  MissingSLAConfigurationException,
  PersistenceException,
  ServiceNotFoundException,
  TechnicianWorkloadExceededException,
  UnauthorizedOperationException,
  DuplicateUserException,
} from "../src/exceptions/errors";
import { Technician } from "../src/domain/users";
import { MatrixPriorityStrategy } from "../src/strategies/priority/PriorityStrategy";

function setup() {
  const clock = new FakeClock(new Date("2026-11-20T10:00:00Z"));
  const sys = buildSystem(clock);
  const data = seed(sys);
  const pay = async (over: Partial<Parameters<typeof sys.incidentService.report>[1]> = {}) =>
    (await sys.incidentService.report(data.employees.e1, {
      title: "Payment application unavailable",
      description: "Users unable to complete transactions at checkout",
      serviceId: data.svc.payment.id, impact: Level.CRITICAL, urgency: Level.CRITICAL, affectedUsers: 300, ...over,
    })).incident;
  return { clock, sys, ...data, S: sys.incidentService, pay };
}

// ---------- normal operations ----------
test("TC01 report → auto-classified, P1, skill-based assignment", async () => {
  const { pay, techs } = setup();
  const inc = await pay();
  assert.equal(inc.category, "APPLICATION");
  assert.equal(inc.priority, Priority.P1);
  assert.equal(inc.status, IncidentStatus.ASSIGNED);
  assert.equal(inc.assignee?.id, techs.t1.id); // most experienced APPLICATION tech
});

test("TC02 full lifecycle NEW → CLOSED through every legal state", async () => {
  const { pay, S, employees, admin } = setup();
  const inc = await pay();
  const t = inc.assignee!;
  S.acknowledge(t, inc.id); S.startWork(t, inc.id);
  S.resolve(t, inc.id, "Rolled back the faulty release");
  S.verify(employees.e1, inc.id); S.close(admin, inc.id);
  assert.equal(inc.status, IncidentStatus.CLOSED);
  assert.equal(t.workload, 0);
});

test("TC03 audit trail records every transition with old and new state", async () => {
  const { pay, S, sys, admin } = setup();
  const inc = await pay();
  S.acknowledge(inc.assignee!, inc.id);
  const trail = sys.reports.auditTrail(admin, inc.id);
  assert.deepEqual(trail.map((a) => a.action), ["CREATED", "CLASSIFIED", "PRIORITY_SET", "ASSIGNED", "ACKNOWLEDGED"]);
  const ack = trail.at(-1)!;
  assert.equal(ack.previousState, "ASSIGNED");
  assert.equal(ack.newState, "ACKNOWLEDGED");
});

test("TC04 notifications go out on both channels (in-app + email)", async () => {
  const { pay, sys, employees } = setup();
  await pay();
  assert.ok(sys.inApp.inboxOf(employees.e1.id).length >= 2);
  const mail = sys.emailLog.recent().find((e) => e.userId === employees.e1.id && e.subject.includes("created"));
  assert.equal(mail?.to, "ankit@corp.local");
  assert.equal(mail?.status, "SIMULATED"); // logged, not sent: no mail provider configured in tests
});

test("TC05 search with five combined criteria", async () => {
  const { pay, sys, S, admin, svc, techs } = setup();
  await pay();
  await S.report(admin, { title: "Printer jammed on floor 2", description: "Printer shows paper jam error constantly", serviceId: svc.printer.id, impact: 1, urgency: 1, affectedUsers: 3 });
  const hits = sys.reports.search(S.visibleTo(admin), {
    status: [IncidentStatus.ASSIGNED], priority: [Priority.P1], category: "APPLICATION", serviceId: svc.payment.id, technicianId: techs.t1.id,
  });
  assert.equal(hits.length, 1);
});

// ---------- business rules / strategies ----------
test("TC06 load-based strategy picks least-loaded technician", async () => {
  const { pay, S, admin, techs } = setup();
  await pay(); // goes to t1
  S.setAssignmentStrategy(admin, "LOAD_BASED");
  const second = await pay({ title: "Payment checkout timing out" });
  assert.notEqual(second.assignee?.id, techs.t1.id);
});

test("TC07 swapping priority strategy changes the result (ITIL matrix caps low-criticality services)", async () => {
  const { S, admin, svc } = setup();
  S.setPriorityStrategy(admin, new MatrixPriorityStrategy());
  const inc = (await S.report(admin, { title: "Printing completely down", description: "No printer in the office works at all", serviceId: svc.printer.id, impact: 4, urgency: 4, affectedUsers: 150 })).incident;
  assert.equal(inc.priority, Priority.P2);
});

test("TC08 duplicate detection links related incidents", async () => {
  const { S, employees, svc } = setup();
  await S.report(employees.e1, { title: "Payment application unavailable", description: "Unable to complete payment transactions", serviceId: svc.payment.id, impact: 4, urgency: 4, affectedUsers: 50 });
  const r = await S.report(employees.e2, { title: "Payment transaction failing", description: "Payment transactions fail at checkout", serviceId: svc.payment.id, impact: 3, urgency: 4, affectedUsers: 20 });
  assert.equal(r.duplicates.length, 1);
  assert.deepEqual(r.incident.related, ["INC1001"]);
});

test("TC09 new category added at runtime is used by auto-classification", async () => {
  const { S, sys, employees, svc } = setup();
  sys.categories.save(new Category("IOT", ["sensor", "thermostat", "iot"]));
  const inc = (await S.report(employees.e1, { title: "Thermostat sensor offline", description: "The iot sensor on floor 3 stopped reporting", serviceId: svc.printer.id, impact: 1, urgency: 2, affectedUsers: 5 })).incident;
  assert.equal(inc.category, "IOT");
});

// ---------- SLA / boundaries ----------
test("TC10 SLA warning at 80% of window, not before (boundary)", async () => {
  const { pay, sys, clock, S } = setup();
  const inc = await pay();
  S.acknowledge(inc.assignee!, inc.id);
  clock.advanceMinutes(23);           // 76.7% of 30 min
  assert.equal(sys.sla.statusOf(inc), SLAStatus.ON_TRACK);
  clock.advanceMinutes(1);            // exactly 80%
  assert.equal(sys.sla.statusOf(inc), SLAStatus.AT_RISK);
});

test("TC11 unacknowledged P1 → response breach + automatic escalation", async () => {
  const { pay, sys, clock } = setup();
  const inc = await pay();
  clock.advanceMinutes(6); // response target is 5 min
  const r = sys.sla.checkAll();
  assert.equal(r.breaches, 1);
  assert.equal(inc.escalationLevel, 1);
  assert.equal(sys.sla.violations[0].kind, "RESPONSE");
});

test("TC12 technician at max workload is skipped; overload throws", async () => {
  const { techs, pay } = setup();
  const rahul = techs.t1 as Technician; // max 5, normally first choice for APPLICATION
  for (let k = 0; k < rahul.maxActiveIncidents; k++) rahul.takeIncident(`X${k}`);
  assert.equal(rahul.canTakeMore(), false);
  const inc = await pay();
  assert.equal(inc.assignee!.id, techs.t3.id); // skipped: goes to Arjun, the other APPLICATION technician
  assert.throws(() => rahul.takeIncident("X99"), TechnicianWorkloadExceededException);
  assert.equal(rahul.workload, 5);
});

// ---------- invalid input / exceptions ----------
test("TC13 illegal state transitions are rejected", async () => {
  const { pay, S, admin, employees } = setup();
  const inc = await pay();
  assert.throws(() => S.close(admin, inc.id), InvalidStateTransitionException);
  assert.throws(() => S.verify(employees.e1, inc.id), InvalidStateTransitionException);
  assert.equal(inc.status, IncidentStatus.ASSIGNED); // unchanged after failures
});

test("TC14 invalid input: short title, unknown service, bad rating", async () => {
  const { pay, S, employees, admin } = setup();
  await assert.rejects(() => pay({ title: "bad" }), InvalidInputException);
  await assert.rejects(() => pay({ serviceId: "SVC-NOPE" }), ServiceNotFoundException);
  const inc = await pay();
  const t = inc.assignee!;
  S.acknowledge(t, inc.id); S.startWork(t, inc.id); S.resolve(t, inc.id, "Restarted the payment gateway");
  assert.throws(() => S.feedback(employees.e1, inc.id, 7, "great"), InvalidInputException);
  void admin;
});

test("TC15 missing SLA configuration is reported clearly", async () => {
  const { sys, pay } = setup();
  sys.policies.delete(Priority.P1);
  await assert.rejects(() => pay(), MissingSLAConfigurationException);
  assert.equal(sys.incidents.count(), 0); // nothing half-saved
});

test("TC16 database failure surfaces as PersistenceException and nothing is half-saved", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itsm-")), "fail.db");
  const store = new SqliteStore(path);
  const sys = buildSystem(new FakeClock(new Date("2026-11-20T10:00:00Z")), { store });
  const d = seed(sys);
  store.db.close(); // the database goes away underneath the running system
  await assert.rejects(
    () => sys.incidentService.report(d.employees.e1, { title: "Payment application unavailable", description: "Users unable to complete transactions", serviceId: d.svc.payment.id, impact: 4, urgency: 4, affectedUsers: 10 }),
    PersistenceException,
  );
  assert.equal(sys.incidents.count(), 0); // the failed write did not reach the in-memory identity map either
});

// ---------- authentication / authorization ----------
test("TC17 login: wrong password rejected, duplicate email rejected", async () => {
  const { sys } = setup();
  assert.equal(sys.auth.login("ankit@corp.local", "employee1").name, "Ankit Sharma");
  assert.throws(() => sys.auth.login("ankit@corp.local", "nope"), InvalidLoginException);
  assert.throws(() => sys.auth.registerEmployee("X", "ankit@corp.local", "password1", "HR"), DuplicateUserException);
});

test("TC18 role-based authorization", async () => {
  const { pay, S, sys, employees, techs } = setup();
  const inc = await pay();
  assert.throws(() => S.assign(employees.e1, inc.id, techs.t2.id), UnauthorizedOperationException);  // employee can't assign
  assert.throws(() => S.acknowledge(techs.t2, inc.id), UnauthorizedOperationException);              // not their incident
  assert.throws(() => S.get(employees.e2, inc.id), UnauthorizedOperationException);                  // can't see others' incidents
  assert.throws(() => sys.reports.auditTrail(techs.t1), UnauthorizedOperationException);             // audit is admin-only
});

// ---------- persistence ----------
import { SqliteStore } from "../src/persistence/SqliteStore";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("TC19 data survives a restart (SQLite): state, notes, links, workload, escalation, audit, IDs", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itsm-")), "test.db");
  const clock = new FakeClock(new Date("2026-11-20T10:00:00Z"));

  // --- first run
  const s1 = buildSystem(clock, { store: new SqliteStore(path) });
  const d = seed(s1);
  const a = (await s1.incidentService.report(d.employees.e1, { title: "Payment application unavailable", description: "Unable to complete payment transactions", serviceId: d.svc.payment.id, impact: 4, urgency: 4, affectedUsers: 50 })).incident;
  const b = (await s1.incidentService.report(d.employees.e2, { title: "Payment transaction failing", description: "Payment transactions fail at checkout", serviceId: d.svc.payment.id, impact: 3, urgency: 4, affectedUsers: 20 })).incident;
  const tech = a.assignee!;
  s1.incidentService.acknowledge(tech, a.id);
  s1.incidentService.startWork(tech, a.id);
  s1.incidentService.addInvestigationNote(tech, a.id, "Gateway pods crash-looping");
  clock.advanceMinutes(10);
  s1.sla.checkAll();
  const auditCount = s1.audit.count();
  s1.store!.db.close();

  // --- second run
  const s2 = buildSystem(clock, { store: new SqliteStore(path) });
  const a2 = s2.incidents.findById(a.id)!;
  assert.equal(a2.status, IncidentStatus.IN_PROGRESS);
  assert.equal(a2.timeline[0].text, "Gateway pods crash-looping");
  assert.deepEqual(a2.related, [b.id]);
  assert.deepEqual(s2.incidents.findById(b.id)!.related, [a.id]);
  // b sat unacknowledged for 10 minutes: escalated two rungs and handed to another technician. All of that was stored.
  const b2 = s2.incidents.findById(b.id)!;
  assert.equal(b2.escalationLevel, 2);
  assert.notEqual(b2.assignee!.id, tech.id);
  assert.equal((s2.users.findById(tech.id) as Technician).workload, 1);
  assert.equal(b2.assignee!.workload, 1);
  assert.equal(s2.audit.count(), auditCount);
  assert.ok(s2.sla.violations.length >= 1);
  assert.ok(s2.inApp.inboxOf(d.employees.e1.id).length > 0);
  assert.ok(s2.auth.login("ankit@corp.local", "employee1"));
  const admin2 = s2.users.findById(d.admin.id)!;
  const c = (await s2.incidentService.report(admin2, { title: "Printer jammed again", description: "Printer on floor 2 jams on every job", serviceId: d.svc.printer.id, impact: 1, urgency: 1, affectedUsers: 2 })).incident;
  assert.equal(c.id, "INC1003"); // numbering continues
  s2.store!.db.close();
});

// ---------- AI categorizer adapter (network mocked) ----------
import { GeminiDecisionCategorizer } from "../src/api/integrations";
import { KeywordCategorizer } from "../src/intelligence/intelligence";

test("TC20 Gemini Decisions adapter: uses the model's choice, falls back to keywords on failure", async () => {
  const { sys } = setup();
  const cats = sys.categories.findAll();
  let sentBody: any;
  const ok = (async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ answers: { category: { type: "choice", choice: "SECURITY", confidence: 0.93 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const ai = new GeminiDecisionCategorizer("test-key", new KeywordCategorizer(), "gemini-decision-1", 1000, ok);
  const r = await ai.suggest("Strange email asking for my password", "Got an email with a link asking me to log in", cats);
  assert.equal(r.category, "SECURITY");
  assert.equal(r.confidence, 0.93);
  assert.equal(sentBody.model, "gemini-decision-1");
  assert.equal(sentBody.questions.category.type, "choice");
  assert.ok("NETWORK" in sentBody.questions.category.criteria);

  const down = (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
  const fb = await new GeminiDecisionCategorizer("k", new KeywordCategorizer(), "gemini-decision-1", 1000, down)
    .suggest("VPN keeps dropping", "VPN connection drops on wifi", cats);
  assert.equal(fb.category, "NETWORK");
  assert.match(fb.source!, /Gemini unavailable/);
});
