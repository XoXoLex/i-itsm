// Regression tests for business rules: each one pins down a bug that was found and fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystem, seed } from "../src/system";
import { FakeClock } from "../src/services/Clock";
import { IncidentStatus, Level, Priority } from "../src/domain/enums";
import { Technician } from "../src/domain/users";
import {
  AccountDisabledException,
  InvalidInputException,
  InvalidStateTransitionException,
  TechnicianUnavailableException,
  TooManyAttemptsException,
  UnauthorizedOperationException,
} from "../src/exceptions/errors";
import { NotificationChannelFactory, ResendEmailAdapter, EmailLog, SimulatedEmailChannel } from "../src/notifications/channels";

function setup() {
  const clock = new FakeClock(new Date("2026-11-20T10:00:00Z"));
  const sys = buildSystem(clock);
  const data = seed(sys);
  const S = sys.incidentService;
  const pay = async (reporter = data.employees.e1 as Parameters<typeof S.report>[0], over: Partial<Parameters<typeof S.report>[1]> = {}) =>
    (await S.report(reporter, {
      title: "Payment application unavailable", description: "Users unable to complete transactions at checkout",
      serviceId: data.svc.payment.id, impact: Level.CRITICAL, urgency: Level.CRITICAL, affectedUsers: 300, ...over,
    })).incident;
  const printer = async (reporter: Parameters<typeof S.report>[0] = data.employees.e2) =>
    (await S.report(reporter, { title: "Printer jammed on floor 2", description: "Printer shows a paper jam error on every job", serviceId: data.svc.printer.id, impact: 1, urgency: 1, affectedUsers: 3 })).incident;
  const work = (inc: Awaited<ReturnType<typeof pay>>) => { const t = inc.assignee!; S.acknowledge(t, inc.id); S.startWork(t, inc.id); return t; };
  const t = data.techs as Record<"t1" | "t2" | "t3" | "t4", Technician>;
  return { clock, sys, ...data, t, S, pay, printer, work };
}

// ---------- reporter rules ----------
test("TC21 a technician who reports an incident can answer questions, reopen and rate it", async () => {
  const { S, t, printer, work } = setup();
  const inc = await printer(t.t1);              // Rahul reports a printer problem; it goes to Meera (hardware)
  assert.equal(inc.assignee!.id, t.t4.id);
  work(inc);
  S.requestInfo(t.t4, inc.id, "Which floor is the printer on?");
  S.provideInfo(t.t1, inc.id, "Second floor, next to the lift");
  assert.equal(inc.status, IncidentStatus.IN_PROGRESS);
  S.resolve(t.t4, inc.id, "Cleared the jam and replaced the roller");
  S.reopen(t.t1, inc.id, "Jammed again on the next job");
  assert.equal(inc.status, IncidentStatus.IN_PROGRESS);
  S.resolve(t.t4, inc.id, "Replaced the whole pickup assembly");
  S.verify(t.t1, inc.id);
  S.feedback(t.t1, inc.id, 4, "Fixed the second time");
  assert.equal(inc.feedback!.rating, 4);
});

test("TC22 separation of duties: whoever resolved an incident cannot verify it", async () => {
  const { S, t, admin, sys } = setup();
  const inc = (await S.report(t.t4, { title: "Monitor flickering at my desk", description: "The hardware monitor flickers every few seconds", serviceId: "SVC-DEVICE", impact: 1, urgency: 1, affectedUsers: 1 })).incident;
  assert.equal(inc.assignee!.id, t.t4.id);      // skill-based assignment gave Meera her own report
  S.acknowledge(t.t4, inc.id); S.startWork(t.t4, inc.id);
  S.resolve(t.t4, inc.id, "Swapped the display cable");
  assert.throws(() => S.verify(t.t4, inc.id), UnauthorizedOperationException);
  assert.equal(inc.status, IncidentStatus.RESOLVED);
  S.verify(admin, inc.id);
  assert.equal(inc.status, IncidentStatus.VERIFIED);
  void sys;
});

// ---------- state integrity ----------
test("TC23 reopening when the technician is full hands the incident to someone else; nothing is half-changed", async () => {
  const { S, t, pay, work, employees, sys } = setup();
  const inc = await pay();
  const rahul = work(inc);
  S.resolve(rahul, inc.id, "Rolled back the faulty release");
  for (let k = 0; k < rahul.maxActiveIncidents; k++) rahul.takeIncident(`OTHER${k}`); // Rahul is now at his limit
  S.reopen(employees.e1, inc.id, "Checkout is failing again");
  assert.equal(inc.status, IncidentStatus.ASSIGNED);       // the new owner has to acknowledge it
  assert.equal(inc.assignee!.id, t.t3.id);                 // Arjun, the other APPLICATION technician
  assert.equal(rahul.holds(inc.id), false);
  assert.ok(sys.reports.auditTrail(sys.users.findById("A1")!, inc.id).at(-1)!.description.includes("handed to"));
});

test("TC24 reopening with nobody free fails cleanly: status, resolution time and workloads are untouched", async () => {
  const { S, t, pay, work, employees } = setup();
  const inc = await pay();
  const rahul = work(inc);
  S.resolve(rahul, inc.id, "Rolled back the faulty release");
  const resolvedAt = inc.resolvedAt;
  for (const tech of Object.values(t)) while (tech.canTakeMore()) tech.takeIncident(`X${tech.workload}`);
  assert.throws(() => S.reopen(employees.e1, inc.id, "Still broken"), TechnicianUnavailableException);
  assert.equal(inc.status, IncidentStatus.RESOLVED);
  assert.equal(inc.resolvedAt, resolvedAt);
  assert.equal(rahul.holds(inc.id), false);
});

test("TC25 reassigning to the same technician is refused and their workload does not change", async () => {
  const { S, pay, admin } = setup();
  const inc = await pay();
  const rahul = inc.assignee!;
  assert.throws(() => S.assign(admin, inc.id, rahul.id), InvalidInputException);
  assert.equal(rahul.workload, 1);
  assert.equal(inc.assignee!.id, rahul.id);
});

test("TC26 a closed incident accepts no notes, edits or second feedback", async () => {
  const { S, pay, work, employees, admin } = setup();
  const inc = await pay();
  const tech = work(inc);
  S.resolve(tech, inc.id, "Rolled back the faulty release");
  S.verify(employees.e1, inc.id); S.close(admin, inc.id);
  assert.throws(() => S.addInvestigationNote(admin, inc.id, "late note"), InvalidStateTransitionException);
  assert.throws(() => S.provideInfo(employees.e1, inc.id, "one more thing"), InvalidStateTransitionException);
  assert.throws(() => S.updateDetails(admin, inc.id, { impact: 1 }), InvalidStateTransitionException);
  S.feedback(employees.e1, inc.id, 5, "Thanks");
  assert.throws(() => S.feedback(employees.e1, inc.id, 1, "changed my mind"), InvalidInputException);
  assert.equal(inc.feedback!.rating, 5);
  assert.equal(inc.timeline.length, 0);
});

test("TC27 invalid numbers are rejected by the domain: NaN rating, fractional users, more users than the service has", async () => {
  const { S, pay, work, employees } = setup();
  await assert.rejects(() => pay(employees.e1, { affectedUsers: Number.NaN }), InvalidInputException);
  await assert.rejects(() => pay(employees.e1, { affectedUsers: 2.5 }), InvalidInputException);
  await assert.rejects(() => pay(employees.e1, { affectedUsers: 501 }), InvalidInputException); // the service has 500 users
  await assert.rejects(() => pay(employees.e1, { impact: 9 as Level }), InvalidInputException);
  const inc = await pay();
  assert.equal(inc.id, "INC1001");              // the four rejected reports did not use up incident numbers
  const tech = work(inc);
  S.resolve(tech, inc.id, "Rolled back the faulty release");
  assert.throws(() => S.feedback(employees.e1, inc.id, Number.NaN, ""), InvalidInputException);
  assert.throws(() => S.feedback(employees.e1, inc.id, 4.5, ""), InvalidInputException);
  assert.equal(inc.feedback, undefined);
});

// ---------- SLA ----------
test("TC28 response and resolution deadlines each get their own warning", async () => {
  const { sys, clock, pay, S } = setup();
  const inc = await pay();                       // P1: acknowledge in 5 min, resolve in 30
  clock.advanceMinutes(4);                       // 80% of the response window
  assert.equal(sys.sla.checkAll().warnings, 1);
  assert.equal(sys.sla.checkAll().warnings, 0);  // not repeated
  S.acknowledge(inc.assignee!, inc.id);
  clock.advanceMinutes(20);                      // minute 24 = 80% of the resolution window
  assert.equal(sys.sla.checkAll().warnings, 1);
  const warnings = sys.reports.auditTrail(sys.users.findById("A1")!, inc.id).filter((a) => a.action === "SLA_WARNING").map((a) => a.description);
  assert.match(warnings[0], /min left to acknowledge/);
  assert.match(warnings[1], /min left to resolve/);
});

test("TC29 escalation climbs to the IT manager, hands the incident over on the way, and tells the right people", async () => {
  const { sys, clock, pay, t, admin } = setup();
  const inc = await pay();
  const rahul = inc.assignee!;
  clock.advanceMinutes(6);                       // 1 min past the 5-minute response deadline
  sys.sla.checkAll();
  assert.equal(inc.escalationLevel, 1);          // team lead
  assert.equal(inc.assignee!.id, rahul.id);
  assert.ok(sys.inApp.inboxOf(t.t3.id).some((n) => n.subject.includes("escalated"))); // Arjun: senior other APPLICATION technician
  clock.advanceMinutes(5);                       // a further response window
  sys.sla.checkAll();
  assert.equal(inc.escalationLevel, 2);          // system administrator: the silent technician loses the incident
  assert.equal(inc.assignee!.id, t.t3.id);
  assert.equal(rahul.workload, 0);
  clock.advanceMinutes(5);
  sys.sla.checkAll();
  assert.equal(inc.escalationLevel, 3);          // IT manager: top of the ladder
  clock.advanceMinutes(600);
  sys.sla.checkAll();
  assert.equal(inc.escalationLevel, 3);          // never past the top
  const trail = sys.reports.auditTrail(admin, inc.id).filter((a) => a.action === "ESCALATED").map((a) => a.description);
  assert.equal(trail.length, 3);
  assert.match(trail[2], /it manager \(level 3 of 3\)/);
  assert.ok(sys.inApp.inboxOf(admin.id).some((n) => n.body.includes("it manager")));
});

test("TC30 an incident left for ten hours catches up the whole ladder in one check, one audit entry per rung", async () => {
  const { sys, clock, pay, admin } = setup();
  const inc = await pay();
  clock.advanceMinutes(600);
  const r = sys.sla.checkAll();
  assert.equal(r.escalations, 3);
  assert.equal(r.breaches, 2);                   // response and resolution
  assert.equal(inc.escalationLevel, 3);
  assert.equal(sys.reports.auditTrail(admin, inc.id).filter((a) => a.action === "ESCALATED").length, 3);
});

// ---------- assignment ----------
test("TC31 nobody free: the incident waits, administrators are told, and the monitor assigns it when someone is free", async () => {
  const { sys, S, t, pay, admin } = setup();
  for (const tech of [t.t1, t.t3]) while (tech.canTakeMore()) tech.takeIncident(`X${tech.workload}`); // both APPLICATION technicians full
  const inc = await pay();
  assert.equal(inc.status, IncidentStatus.CLASSIFIED);
  assert.equal(inc.assignee, undefined);
  assert.equal(inc.priority, Priority.P1);       // priority and deadlines were still saved
  assert.ok(sys.inApp.inboxOf(admin.id).some((n) => n.subject.includes("assignment failed")));
  assert.equal(sys.reports.overview(admin).unassigned, 1);
  assert.equal(S.retryUnassigned(), 0);
  t.t1.releaseIncident("X0");
  assert.equal(S.retryUnassigned(), 1);
  assert.equal(inc.assignee!.id, t.t1.id);
});

test("TC32 marking a technician away hands their open incidents to colleagues", async () => {
  const { sys, t, pay, work, admin } = setup();
  const a = await pay();
  work(a);                                       // Rahul is investigating
  const r = sys.admin.setTechnicianAvailability(admin, t.t1.id, false);
  assert.deepEqual({ moved: r.moved, kept: r.kept }, { moved: 1, kept: 0 });
  assert.equal(a.assignee!.id, t.t3.id);
  assert.equal(a.status, IncidentStatus.ASSIGNED);
  assert.equal(t.t1.workload, 0);
  const b = await pay(undefined, { title: "Payment page shows a blank screen" });
  assert.notEqual(b.assignee?.id, t.t1.id);      // and they get nothing new while away
});

test("TC33 round-robin takes turns and skips technicians who cannot take more", async () => {
  const { S, t, printer, admin } = setup();
  S.setAssignmentStrategy(admin, "ROUND_ROBIN");
  t.t2.setAvailable(false);
  const picked = [];
  for (let k = 0; k < 4; k++) picked.push((await printer()).assignee!.id);
  assert.deepEqual(picked, ["T201", "T203", "T204", "T201"]);
  assert.throws(() => S.setAssignmentStrategy(admin, "RANDOM"), InvalidInputException);
});

// ---------- editing ----------
test("TC34 correcting an incident recalculates priority and deadlines and tells the people involved", async () => {
  const { sys, S, printer, admin, employees } = setup();
  const inc = await printer();
  assert.equal(inc.priority, Priority.P4);
  const oldDeadline = inc.sla!.resolveBy.getTime();
  S.updateDetails(admin, inc.id, { impact: Level.CRITICAL, urgency: Level.CRITICAL, affectedUsers: 150 });
  assert.equal(inc.priority, Priority.P2);       // 4 × 4 × criticality 1 = 16 is P3, raised one level because every user of the service is affected
  assert.ok(inc.sla!.resolveBy.getTime() < oldDeadline);
  const actions = sys.reports.auditTrail(admin, inc.id).map((a) => a.action);
  assert.deepEqual(actions.slice(-2), ["UPDATED", "PRIORITY_CHANGED"]);
  assert.ok(sys.inApp.inboxOf(employees.e2.id).some((n) => n.subject.includes("priority changed")));
  assert.throws(() => S.updateDetails(employees.e2, inc.id, { impact: 1 }), UnauthorizedOperationException); // reporters add information; they do not edit
  assert.throws(() => S.updateDetails(admin, inc.id, {}), InvalidInputException);
});

test("TC35 changing a service's criticality re-prioritises its open incidents", async () => {
  const { sys, printer, admin } = setup();
  const inc = await printer();                   // impact 1 × urgency 1 × criticality 1
  const r = sys.admin.updateService(admin, inc.service.id, { criticality: Level.CRITICAL });
  assert.equal(r.reprioritised, 0);              // score 4 is still P4
  const big = (await sys.incidentService.report(admin, { title: "No printer works anywhere", description: "Every printer in the office is offline", serviceId: inc.service.id, impact: 2, urgency: 2, affectedUsers: 10 })).incident;
  assert.equal(big.priority, Priority.P3);       // 2 × 2 × 4 = 16
  assert.equal(sys.admin.updateService(admin, inc.service.id, { criticality: Level.LOW }).reprioritised, 1);
  assert.equal(big.priority, Priority.P4);
});

// ---------- people ----------
test("TC36 editing, deactivating and restoring accounts", async () => {
  const { sys, t, pay, admin, employees } = setup();
  const a = await pay();
  sys.admin.updateUser(admin, t.t3.id, { name: "Arjun Nair", skills: ["application", "cloud", "database"], maxActive: 4 });
  assert.deepEqual([t.t3.name, t.t3.maxActiveIncidents, t.t3.hasSkill("DATABASE")], ["Arjun Nair", 4, true]);
  assert.throws(() => sys.admin.updateUser(admin, t.t3.id, { skills: ["juggling"] }), InvalidInputException);
  assert.throws(() => sys.admin.updateUser(admin, t.t3.id, { name: "Changed", maxActive: 0 }), InvalidInputException);
  assert.equal(t.t3.name, "Arjun Nair");         // the failed edit changed nothing, not even the name
  assert.throws(() => sys.admin.updateUser(admin, t.t3.id, { email: "rahul@itsm.local" }), /already exists/);

  const r = sys.admin.setUserActive(admin, t.t1.id, false);
  assert.equal(r.moved, 1);                      // Rahul's open incident went to a colleague
  assert.notEqual(a.assignee!.id, t.t1.id);
  assert.throws(() => sys.auth.login("rahul@itsm.local", "tech12345"), AccountDisabledException);
  assert.throws(() => sys.auth.getUser(t.t1.id)); // an existing session stops working too
  sys.admin.setUserActive(admin, t.t1.id, true);
  assert.ok(sys.auth.login("rahul@itsm.local", "tech12345"));

  assert.throws(() => sys.admin.setUserActive(admin, admin.id, false), InvalidInputException); // cannot lock yourself out
  sys.auth.resetPassword(admin, employees.e1.id, "new-password-1");
  assert.ok(sys.auth.login("ankit@corp.local", "new-password-1"));
  assert.throws(() => sys.auth.resetPassword(employees.e1, admin.id, "hacked-12345"), UnauthorizedOperationException);
});

test("TC37 five wrong passwords lock that address out, but not the real owner signing in from elsewhere", async () => {
  const { sys, clock } = setup();
  for (let k = 0; k < 5; k++) assert.throws(() => sys.auth.login("ankit@corp.local", "guess", "10.0.0.66"));
  assert.throws(() => sys.auth.login("ankit@corp.local", "employee1", "10.0.0.66"), TooManyAttemptsException);
  assert.ok(sys.auth.login("ankit@corp.local", "employee1", "192.168.1.20"));
  clock.advanceMinutes(6);
  assert.ok(sys.auth.login("ankit@corp.local", "employee1", "10.0.0.66"));
});

// ---------- catalogue ----------
test("TC38 retired services and removed categories: old incidents keep them, new ones cannot use them", async () => {
  const { sys, S, printer, admin, employees } = setup();
  const old = await printer();
  sys.admin.updateService(admin, old.service.id, { active: false });
  await assert.rejects(() => printer(), /retired/);
  assert.equal(old.service.name, "Office Printing");
  sys.admin.setCategoryKeywords(admin, "NETWORK", ["wifi", "vpn", "bluetooth"]);
  const bt = (await S.report(employees.e1, { title: "Bluetooth headset keeps disconnecting", description: "The bluetooth link drops every few minutes", serviceId: "SVC-DEVICE", impact: 1, urgency: 1, affectedUsers: 1 })).incident;
  assert.equal(bt.category, "NETWORK");
  sys.admin.removeCategory(admin, "HARDWARE");
  assert.equal(old.category, "HARDWARE");        // the old incident keeps the label it was filed under
  await assert.rejects(() => S.report(employees.e1, { title: "Keyboard keys stuck", description: "Several keyboard keys do not respond", serviceId: "SVC-DEVICE", impact: 1, urgency: 1, affectedUsers: 1, category: "HARDWARE" }), /Unknown category/);
});

// ---------- notifications ----------
test("TC39 channel factory: simulated email is logged, the Resend adapter records what the provider answered", async () => {
  const { employees } = setup();
  const n = { recipient: employees.e1, subject: "[INC1] created", body: "created", incidentId: "INC1", at: new Date() };

  const log = new EmailLog();
  const simulated = NotificationChannelFactory.create(NotificationChannelFactory.emailKind({}), { emailLog: log });
  assert.ok(simulated instanceof SimulatedEmailChannel);
  simulated.send(n);
  assert.equal(log.recent()[0].status, "SIMULATED");

  let sent: { url: string; auth: string; body: { from: string; to: string[]; subject: string } } | undefined;
  const ok = (async (url: string, init: RequestInit) => {
    sent = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { emailLog: log, resendApiKey: "re_test", emailFrom: "desk@example.com", http: ok };
  const real = NotificationChannelFactory.create(NotificationChannelFactory.emailKind(deps), deps);
  assert.ok(real instanceof ResendEmailAdapter);
  real.send(n);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([sent!.url, sent!.auth, sent!.body.to[0]], ["https://api.resend.com/emails", "Bearer re_test", "ankit@corp.local"]);
  assert.equal(log.recent()[0].status, "SENT");

  const refused = (async () => new Response("domain not verified", { status: 403 })) as unknown as typeof fetch;
  NotificationChannelFactory.create("EMAIL_RESEND", { ...deps, http: refused }).send(n);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.recent()[0].status, "FAILED");
  assert.match(log.recent()[0].detail, /HTTP 403/);
  assert.throws(() => NotificationChannelFactory.create("PIGEON"), InvalidInputException);
});

test("TC40 one failing channel does not stop the others, and nobody is notified about their own action", async () => {
  const clock = new FakeClock(new Date("2026-11-20T10:00:00Z"));
  const broken = { name: "BROKEN", send() { throw new Error("gateway down"); } };
  const sys = buildSystem(clock, { extraChannels: [broken] });
  const d = seed(sys);
  const inc = (await sys.incidentService.report(d.employees.e1, { title: "Payment application unavailable", description: "Users unable to complete transactions", serviceId: d.svc.payment.id, impact: 4, urgency: 4, affectedUsers: 10 })).incident;
  assert.ok(sys.inApp.inboxOf(d.employees.e1.id).length >= 2);          // still delivered in-app
  assert.ok(sys.emailLog.recent().length >= 2);                          // and by email
  const tech = inc.assignee!;
  const before = sys.inApp.inboxOf(tech.id).length;
  sys.incidentService.acknowledge(tech, inc.id);
  assert.equal(sys.inApp.inboxOf(tech.id).length, before);              // the technician is not told about their own click
  assert.ok(sys.inApp.inboxOf(d.employees.e1.id).some((n) => n.subject.includes("acknowledged")));
});
