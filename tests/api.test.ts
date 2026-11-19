// HTTP-level tests: a real server on a random port, exercised with fetch exactly as the browser does.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/api/app";
import { LiveChannel } from "../src/api/integrations";
import { SystemClock } from "../src/services/Clock";
import { buildSystem, seed } from "../src/system";

let server: Server;
let base: string;
const live = new LiveChannel();
const tokens: Record<string, string> = {};

async function call(method: string, path: string, who?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const PAYMENT = { title: "Payment application unavailable", description: "Users unable to complete transactions at checkout", serviceId: "SVC-PAY", impact: 4, urgency: 4, affectedUsers: 300 };

before(async () => {
  const sys = buildSystem(new SystemClock(), { extraChannels: [live] });
  sys.bus.subscribe(live);
  seed(sys);
  server = createApp(sys, live, "test-secret").listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  for (const [who, email, password] of [["employee", "ankit@corp.local", "employee1"], ["other", "divya@corp.local", "employee2"], ["tech", "rahul@itsm.local", "tech12345"], ["admin", "admin@itsm.local", "admin1234"]]) {
    tokens[who] = (await call("POST", "/auth/login", undefined, { email, password })).json.token;
  }
});
after(() => { server.closeAllConnections(); server.close(); });

test("TC41 API authentication: no token, forged token, wrong password, unknown route", async () => {
  assert.equal((await call("GET", "/incidents")).status, 401);
  tokens.forged = "not.a.token";
  assert.equal((await call("GET", "/incidents", "forged")).status, 401);
  const wrong = await call("POST", "/auth/login", undefined, { email: "ankit@corp.local", password: "nope" });
  assert.deepEqual([wrong.status, wrong.json.error], [401, "InvalidLoginException"]);
  assert.equal((await call("GET", "/no-such-thing", "admin")).status, 404);
  assert.equal((await call("GET", "/health")).status, 200);
});

test("TC42 API workflow: report → acknowledge → investigate → resolve → verify → close, with the audit trail", async () => {
  const created = await call("POST", "/incidents", "employee", PAYMENT);
  assert.equal(created.status, 201);
  const inc = created.json.incident;
  assert.deepEqual([inc.category, inc.priority, inc.status, inc.assignee.name], ["APPLICATION", "P1", "ASSIGNED", "Rahul (App/DB)"]);
  const id = inc.id;
  assert.equal((await call("POST", `/incidents/${id}/acknowledge`, "tech")).json.status, "ACKNOWLEDGED");
  assert.equal((await call("POST", `/incidents/${id}/start`, "tech")).json.status, "IN_PROGRESS");
  assert.equal((await call("POST", `/incidents/${id}/resolve`, "tech", { text: "Rolled back the faulty release" })).json.status, "RESOLVED");
  assert.equal((await call("POST", `/incidents/${id}/verify`, "employee")).json.status, "VERIFIED");
  assert.equal((await call("POST", `/incidents/${id}/close`, "admin")).json.status, "CLOSED");
  assert.equal((await call("POST", `/incidents/${id}/feedback`, "employee", { rating: 5, comment: "Fast" })).json.feedback.rating, 5);
  const detail = await call("GET", `/incidents/${id}`, "admin");
  assert.deepEqual(detail.json.audit.map((a: any) => a.action), ["CREATED", "CLASSIFIED", "PRIORITY_SET", "ASSIGNED", "ACKNOWLEDGED", "WORK_STARTED", "RESOLVED", "VERIFIED", "CLOSED", "FEEDBACK"]);
  assert.equal((await call("GET", `/incidents/${id}`, "employee")).json.audit, undefined); // the audit trail is for administrators
  assert.ok((await call("GET", "/notifications", "employee")).json.length >= 5);
  assert.ok((await call("GET", "/reports/emails", "admin")).json.some((e: any) => e.to === "ankit@corp.local" && e.status === "SIMULATED"));
});

test("TC43 API authorization: each role is refused what belongs to another", async () => {
  const id = (await call("POST", "/incidents", "employee", { ...PAYMENT, title: "Payment page shows blank screen" })).json.incident.id;
  assert.equal((await call("GET", `/incidents/${id}`, "other")).status, 403);                       // someone else's incident
  assert.equal((await call("POST", `/incidents/${id}/acknowledge`, "employee")).status, 403);      // employees do not work incidents
  assert.equal((await call("POST", `/incidents/${id}/close`, "tech")).status, 403);                // only administrators close
  assert.equal((await call("PATCH", `/incidents/${id}`, "employee", { impact: 1 })).status, 403);  // reporters do not edit
  for (const path of ["/reports/overview", "/reports/audit", "/reports/emails", "/reports/sla-violations", "/admin/users"]) {
    assert.equal((await call("GET", path, "tech")).status, 403, path);
  }
  assert.equal((await call("POST", "/admin/sla-check", "employee")).status, 403);
  assert.equal((await call("PUT", "/admin/strategies", "tech", { assignment: "LOAD_BASED" })).status, 403);
  assert.equal((await call("GET", "/incidents", "other")).json.length, 0);                          // lists are filtered too
});

test("TC44 API input validation: every bad value is a 400 with a message, never a 500", async () => {
  const bad: [string, string, string, unknown][] = [
    ["POST", "/incidents", "employee", { ...PAYMENT, affectedUsers: "lots" }],
    ["POST", "/incidents", "employee", { ...PAYMENT, affectedUsers: 0 }],
    ["POST", "/incidents", "employee", { ...PAYMENT, affectedUsers: 5000 }],   // the service has 500 users
    ["POST", "/incidents", "employee", { ...PAYMENT, impact: 7 }],
    ["POST", "/incidents", "employee", { ...PAYMENT, title: "x" }],
    ["POST", "/incidents", "employee", { ...PAYMENT, category: "NONSENSE" }],
    ["POST", "/incidents", "employee", "{not json"],
    ["POST", "/incidents", "employee", [1, 2, 3]],
    ["GET", "/incidents?status=BOGUS", "admin", undefined],
    ["GET", "/incidents?from=yesterday-ish", "admin", undefined],
    ["PUT", "/admin/strategies", "admin", { assignment: "RANDOM" }],
    ["PUT", "/admin/sla/P1", "admin", { responseMinutes: "soon", resolutionMinutes: 30 }],
    ["PUT", "/admin/sla/P1", "admin", { responseMinutes: 60, resolutionMinutes: 30 }], // resolve before respond
    ["PUT", "/admin/sla/P9", "admin", { responseMinutes: 5, resolutionMinutes: 30 }],
    ["POST", "/admin/users", "admin", { name: "Zero Max", email: "zero@itsm.local", password: "password1", maxActive: 0 }],
    ["POST", "/admin/users", "admin", { name: "Old Hand", email: "old@itsm.local", password: "password1", experienceYears: -3 }],
    ["POST", "/admin/users", "admin", { name: "Juggler", email: "jug@itsm.local", password: "password1", skills: "juggling" }],
    ["POST", "/admin/services", "admin", { id: "SVC-X", name: "X", criticality: 2, userBase: "many" }],
    ["PATCH", "/admin/technicians/T201", "admin", { available: "yes" }],
    ["POST", "/auth/register", "employee", { name: "A", email: "not-an-email", password: "password1" }],
  ];
  for (const [method, path, who, body] of bad) {
    const r = await call(method, path, who, body);
    assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(r.json.message.length > 5);
  }
  const id = (await call("GET", "/incidents?status=CLOSED", "admin")).json[0].id;
  assert.equal((await call("POST", `/incidents/${id}/feedback`, "admin", {})).status, 400);           // missing rating
  assert.equal((await call("POST", `/incidents/${id}/notes`, "admin", { text: "late" })).status, 409); // closed: wrong state, not bad input
  assert.equal((await call("GET", "/incidents/INC9999", "admin")).status, 404);
  assert.equal((await call("GET", "/admin/users", "admin")).json.some((u: any) => ["Zero Max", "Old Hand", "Juggler"].includes(u.name)), false);
});

test("TC45 API: editing an incident re-prioritises it; a technician can follow up on their own report", async () => {
  const id = (await call("POST", "/incidents", "tech", { title: "Printer jammed on floor 2", description: "Printer shows a paper jam error on every job", serviceId: "SVC-PRINT", impact: 1, urgency: 1, affectedUsers: 3 })).json.incident.id;
  const edited = await call("PATCH", `/incidents/${id}`, "admin", { impact: 4, urgency: 4, affectedUsers: 150 });
  assert.deepEqual([edited.status, edited.json.priority], [200, "P2"]);
  const meera = (await call("POST", "/auth/login", undefined, { email: "meera@itsm.local", password: "tech12345" })).json.token;
  tokens.meera = meera;
  await call("POST", `/incidents/${id}/acknowledge`, "meera");
  await call("POST", `/incidents/${id}/start`, "meera");
  assert.equal((await call("POST", `/incidents/${id}/request-info`, "meera", { text: "Which printer exactly?" })).json.status, "PENDING_INFO");
  assert.equal((await call("POST", `/incidents/${id}/provide-info`, "tech", { text: "The one by the lift" })).json.status, "IN_PROGRESS");
  await call("POST", `/incidents/${id}/resolve`, "meera", { text: "Cleared the jam and replaced the roller" });
  assert.equal((await call("POST", `/incidents/${id}/verify`, "tech")).json.status, "VERIFIED");
});

test("TC46 API administration: edit and deactivate a user, reset a password, change own password", async () => {
  const users = (await call("GET", "/admin/users", "admin")).json;
  const karan = users.find((u: any) => u.email === "karan@corp.local");
  assert.equal((await call("PATCH", `/admin/users/${karan.id}`, "admin", { name: "Karan M.", department: "Operations" })).json.department, "Operations");
  await call("POST", `/admin/users/${karan.id}/password`, "admin", { password: "fresh-pass-1" });
  const login = await call("POST", "/auth/login", undefined, { email: "karan@corp.local", password: "fresh-pass-1" });
  assert.equal(login.status, 200);
  tokens.karan = login.json.token;
  assert.equal((await call("POST", "/me/password", "karan", { current: "wrong", next: "another-pass-2" })).status, 400);
  assert.equal((await call("POST", "/me/password", "karan", { current: "fresh-pass-1", next: "another-pass-2" })).status, 200);
  assert.equal((await call("PATCH", `/admin/users/${karan.id}/active`, "admin", { active: false })).json.user.active, false);
  assert.equal((await call("GET", "/me", "karan")).status, 401);                                    // the open session ends at once
  assert.equal((await call("POST", "/auth/login", undefined, { email: "karan@corp.local", password: "another-pass-2" })).status, 403);
});

test("TC47 live updates: an incident's events reach its reporter and administrators, not other employees", async () => {
  const open = async (who: string) => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${tokens[who]}` }, signal: ctrl.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const seen: string[] = [];
    const reader = res.body!.getReader();
    (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; seen.push(new TextDecoder().decode(value)); } } catch { /* aborted */ } })();
    return { seen: () => seen.join(""), close: () => ctrl.abort() };
  };
  assert.equal((await fetch(`${base}/events`)).status, 401);                                         // no token in the URL, none accepted there
  assert.equal((await fetch(`${base}/events?token=${tokens.employee}`)).status, 401);
  const [mine, others, admins] = [await open("employee"), await open("other"), await open("admin")];
  const id = (await call("POST", "/incidents", "employee", { ...PAYMENT, title: "Payment receipts not emailed" })).json.incident.id;
  await new Promise((r) => setTimeout(r, 50));
  assert.match(mine.seen(), new RegExp(`event: incident\\ndata: \\{"id":"${id}"`));
  assert.match(mine.seen(), /event: notification/);
  assert.match(admins.seen(), new RegExp(`"id":"${id}"`));
  assert.doesNotMatch(others.seen(), new RegExp(id));
  for (const s of [mine, others, admins]) s.close();
});
