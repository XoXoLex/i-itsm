import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Incident } from "../domain/Incident";
import { IncidentStatus, Level, Permission, Priority, Role, SLAStatus } from "../domain/enums";
import { Technician, User } from "../domain/users";
import { AuthenticationRequiredException, InvalidInputException, ItsmError } from "../exceptions/errors";
import { IncidentQuery } from "../services/ReportService";
import { AssignmentStrategyFactory } from "../strategies/assignment/AssignmentStrategy";
import { PriorityStrategyFactory } from "../strategies/priority/PriorityStrategy";
import { ItsmSystem } from "../system";
import { auditDTO, emailDTO, incidentDetailDTO, incidentDTO, serviceDTO, userDTO } from "./dto";
import { LiveChannel } from "./integrations";

type AuthedRequest = Request & { user: User };

export interface AppOptions {
  /** Persists administrator choices (strategies) across restarts. */
  settings?: { set(k: string, v: string): void };
  /** Browser origins allowed to call the API from another site. Empty = same origin only. */
  corsOrigins?: string[];
  /** Set when running behind a reverse proxy, so the client address is read from X-Forwarded-For. */
  trustProxy?: boolean;
}

// ---------------------------------------------------------------------- request parsing
// The API's only jobs are authentication, turning untyped JSON into typed values, and mapping
// errors to status codes. Every rule about who may do what lives in the services.
const bad = (message: string): never => { throw new InvalidInputException(message); };

function str(v: unknown, field: string, max = 5000): string {
  if (typeof v !== "string" || !v.trim()) return bad(`${field} is required`);
  if (v.length > max) return bad(`${field} must be at most ${max} characters`);
  return v.trim();
}
const optStr = (v: unknown, field: string, max = 5000) => (v === undefined || v === null || v === "" ? undefined : str(v, field, max));

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return bad(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}
const optInt = (v: unknown, field: string, min: number, max: number) => (v === undefined || v === null || v === "" ? undefined : int(v, field, min, max));
const level = (v: unknown, field: string) => int(v, field, 1, 4) as Level;
const optLevel = (v: unknown, field: string) => optInt(v, field, 1, 4) as Level | undefined;

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") return bad(`${field} must be true or false`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  const s = String(v ?? "").toUpperCase() as T;
  if (!allowed.includes(s)) return bad(`${field} must be one of: ${allowed.join(", ")}`);
  return s;
}
const manyOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T[] | undefined =>
  typeof v === "string" && v ? v.split(",").map((x) => oneOf(x, allowed, field)) : undefined;

/** A list sent either as a JSON array or as comma-separated text. */
function strings(v: unknown, field: string): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : v === undefined || v === null ? [] : bad(`${field} must be a list`);
  if (items.some((x) => typeof x !== "string")) return bad(`${field} must be a list of text values`);
  return (items as string[]).map((x) => x.trim()).filter(Boolean);
}

/** An ISO instant, or a plain YYYY-MM-DD date read in the server's time zone. */
function when(v: unknown, field: string, endOfDay = false): Date {
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00"}`) : new Date(s);
  if (Number.isNaN(d.getTime())) return bad(`${field} is not a valid date`);
  return d;
}

export function createApp(sys: ItsmSystem, live: LiveChannel, jwtSecret: string, opts: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (opts.trustProxy) app.set("trust proxy", 1);
  // The React app is served from this same server, so cross-origin calls are refused unless explicitly allowed.
  if (opts.corsOrigins?.length) app.use(cors({ origin: opts.corsOrigins }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "200kb" }));

  const S = sys.incidentService;
  const sign = (u: User) => jwt.sign({ sub: u.id, role: u.role }, jwtSecret, { expiresIn: "12h" });

  // ------------------------------------------------------------------ auth middleware
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new AuthenticationRequiredException();
    let userId: string;
    try {
      userId = (jwt.verify(h.slice(7), jwtSecret) as { sub: string }).sub;
    } catch {
      throw new AuthenticationRequiredException("Session expired or invalid, please log in again");
    }
    (req as AuthedRequest).user = sys.auth.getUser(userId);
    next();
  };
  const me = (req: Request) => (req as AuthedRequest).user;
  const body = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const dto = (i: Incident) => incidentDTO(i, sys.sla);
  const detail = (u: User, i: Incident) => ({ ...incidentDetailDTO(i, sys.sla), canEdit: S.canEdit(u, i) });

  // ------------------------------------------------------------------ public
  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

  app.post("/api/auth/register", (req, res) => {
    const b = body(req);
    const u = sys.auth.registerEmployee(str(b.name, "Name", 80), str(b.email, "Email", 200), str(b.password, "Password", 200), optStr(b.department, "Department", 80) ?? "General");
    res.status(201).json({ token: sign(u), user: userDTO(u) });
  });

  app.post("/api/auth/login", (req, res) => {
    const b = body(req);
    const u = sys.auth.login(str(b.email, "Email", 200), str(b.password, "Password", 200), req.ip ?? "unknown");
    res.json({ token: sign(u), user: userDTO(u) });
  });

  // ------------------------------------------------------------------ everything below needs login
  app.use("/api", auth);

  app.get("/api/me", (req, res) => { res.json(userDTO(me(req))); });
  app.post("/api/me/password", (req, res) => {
    const b = body(req);
    sys.auth.changeOwnPassword(me(req), str(b.current, "Current password", 200), str(b.next, "New password", 200));
    res.json({ ok: true });
  });

  /** Server-Sent Events. The browser reads this stream with fetch, so the token travels in the header, never in the URL. */
  app.get("/api/events", (req, res) => { live.connect(me(req), res); });

  app.get("/api/meta", (_req, res) => {
    res.json({
      services: sys.services.findAll().map(serviceDTO),
      categories: sys.categories.findAll().map((c) => ({ name: c.name, keywords: c.keywordList })),
      levels: [1, 2, 3, 4].map((l) => ({ value: l, label: Level[l] })),
      statuses: Object.values(IncidentStatus), priorities: Object.values(Priority), slaStatuses: Object.values(SLAStatus),
      technicians: sys.users.findAll().filter((u): u is Technician => u instanceof Technician && u.active).map((t) => ({ id: t.id, name: t.name, available: t.available })),
      slaPolicies: sys.sla.allPolicies.map((p) => ({ priority: p.priority, responseMinutes: p.responseMinutes, resolutionMinutes: p.resolutionMinutes })),
      strategies: { ...S.currentStrategies, assignmentOptions: AssignmentStrategyFactory.available(), priorityOptions: PriorityStrategyFactory.available() },
      categorizer: sys.incidentService.categorizerName,
      emailChannel: sys.email.name,
    });
  });

  // ------------------------------------------------------------------ incidents
  app.get("/api/incidents", (req, res) => {
    const q = req.query;
    const query: IncidentQuery = {
      id: q.id ? String(q.id) : undefined,
      text: q.text ? String(q.text) : undefined,
      status: manyOf(q.status, Object.values(IncidentStatus), "Status"),
      priority: manyOf(q.priority, Object.values(Priority), "Priority"),
      category: q.category ? String(q.category) : undefined,
      serviceId: q.serviceId ? String(q.serviceId) : undefined,
      technicianId: q.technicianId ? String(q.technicianId) : undefined,
      from: q.from ? when(q.from, "From date") : undefined,
      to: q.to ? when(q.to, "To date", true) : undefined,
      slaStatus: q.slaStatus ? oneOf(q.slaStatus, Object.values(SLAStatus), "SLA status") : undefined,
      openOnly: q.openOnly === "true",
    };
    res.json(sys.reports.search(S.visibleTo(me(req)), query).map(dto));
  });

  app.post("/api/incidents", async (req, res) => {
    const b = body(req);
    const { incident, duplicates } = await S.report(me(req), {
      title: str(b.title, "Title", 200), description: str(b.description, "Description"), serviceId: str(b.serviceId, "Service", 40),
      impact: level(b.impact, "Impact"), urgency: level(b.urgency, "Urgency"),
      affectedUsers: optInt(b.affectedUsers, "People affected", 1, 10_000_000) ?? 1, category: optStr(b.category, "Category", 40),
    });
    res.status(201).json({ incident: detail(me(req), incident), duplicates: duplicates.map((d) => ({ id: d.incident.id, title: d.incident.title, similarity: d.similarity })) });
  });

  app.get("/api/incidents/:id", (req, res) => {
    const u = me(req);
    const inc = S.get(u, String(req.params.id));
    res.json({
      ...detail(u, inc),
      audit: u.can(Permission.VIEW_AUDIT) ? sys.reports.auditTrail(u, inc.id).map(auditDTO) : undefined,
      suggestions: u.can(Permission.WORK_ON_INCIDENT) ? S.suggestResolutions(u, inc.id) : undefined,
    });
  });

  /** Correct the reported facts; priority and deadlines follow automatically. */
  app.patch("/api/incidents/:id", (req, res) => {
    const b = body(req);
    const inc = S.updateDetails(me(req), String(req.params.id), {
      title: optStr(b.title, "Title", 200), description: optStr(b.description, "Description"), serviceId: optStr(b.serviceId, "Service", 40),
      impact: optLevel(b.impact, "Impact"), urgency: optLevel(b.urgency, "Urgency"),
      affectedUsers: optInt(b.affectedUsers, "People affected", 1, 10_000_000), category: optStr(b.category, "Category", 40),
    });
    res.json(detail(me(req), inc));
  });

  const action = (path: string, fn: (u: User, id: string, b: Record<string, unknown>) => Incident) =>
    app.post(`/api/incidents/:id/${path}`, (req, res) => {
      res.json(detail(me(req), fn(me(req), String(req.params.id), body(req))));
    });

  action("acknowledge", (u, id) => S.acknowledge(u, id));
  action("start", (u, id) => S.startWork(u, id));
  action("notes", (u, id, b) => S.addInvestigationNote(u, id, str(b.text, "Note")));
  action("request-info", (u, id, b) => S.requestInfo(u, id, str(b.text, "Question")));
  action("provide-info", (u, id, b) => S.provideInfo(u, id, str(b.text, "Information")));
  action("resolve", (u, id, b) => S.resolve(u, id, str(b.text, "Resolution")));
  action("verify", (u, id) => S.verify(u, id));
  action("reopen", (u, id, b) => S.reopen(u, id, str(b.text, "Reason")));
  action("close", (u, id) => S.close(u, id));
  action("feedback", (u, id, b) => S.feedback(u, id, int(b.rating, "Rating", 1, 5), optStr(b.comment, "Comment", 1000) ?? ""));
  action("assign", (u, id, b) => S.assign(u, id, optStr(b.technicianId, "Technician", 40)));

  // ------------------------------------------------------------------ notifications
  app.get("/api/notifications", (req, res) => { res.json(sys.inApp.inboxOf(me(req).id).slice(0, 50)); });
  app.post("/api/notifications/read", (req, res) => { sys.inApp.markAllRead(me(req).id); res.json({ ok: true }); });

  // ------------------------------------------------------------------ reports (admin; the services check the permission)
  app.get("/api/reports/overview", (req, res) => { res.json(sys.reports.overview(me(req))); });
  app.get("/api/reports/workload", (req, res) => { res.json(sys.reports.technicianWorkload(me(req))); });
  app.get("/api/reports/by-service", (req, res) => { res.json(sys.reports.byService(me(req))); });
  app.get("/api/reports/by-category", (req, res) => { res.json(sys.reports.byCategory(me(req))); });
  app.get("/api/reports/by-priority", (req, res) => { res.json(sys.reports.byPriority(me(req))); });
  app.get("/api/reports/trend", (req, res) => {
    // tz = minutes the viewer's clock is ahead of UTC, so "a day" is the viewer's day.
    res.json(sys.reports.dailyTrend(me(req), 10, optInt(req.query.tz, "Time zone offset", -840, 840) ?? 0));
  });
  app.get("/api/reports/sla-violations", (req, res) => { res.json(sys.sla.violationsFor(me(req))); });
  app.get("/api/reports/audit", (req, res) => {
    const id = req.query.incidentId ? String(req.query.incidentId) : undefined;
    res.json(sys.reports.auditTrail(me(req), id).reverse().slice(0, 300).map(auditDTO));
  });
  app.get("/api/reports/emails", (req, res) => { res.json(sys.reports.emailLog(me(req)).map(emailDTO)); });

  // ------------------------------------------------------------------ admin: people
  app.get("/api/admin/users", (req, res) => { res.json(sys.admin.listUsers(me(req)).map(userDTO)); });
  app.post("/api/admin/users", (req, res) => {
    const b = body(req);
    const u = sys.admin.addStaff(me(req), oneOf(b.role ?? "TECHNICIAN", [Role.TECHNICIAN, Role.ADMIN], "Role") as "TECHNICIAN" | "ADMIN", {
      name: str(b.name, "Name", 80), email: str(b.email, "Email", 200), password: str(b.password, "Password", 200),
      skills: strings(b.skills, "Skills"),
      experienceYears: optInt(b.experienceYears, "Years of experience", 0, 60) ?? 0,
      maxActive: optInt(b.maxActive, "Max active incidents", 1, 50) ?? 5,
    });
    res.status(201).json(userDTO(u));
  });
  app.patch("/api/admin/users/:id", (req, res) => {
    const b = body(req);
    const u = sys.admin.updateUser(me(req), String(req.params.id), {
      name: optStr(b.name, "Name", 80), email: optStr(b.email, "Email", 200), department: b.department === undefined ? undefined : String(b.department).slice(0, 80),
      skills: b.skills === undefined ? undefined : strings(b.skills, "Skills"),
      experienceYears: optInt(b.experienceYears, "Years of experience", 0, 60),
      maxActive: optInt(b.maxActive, "Max active incidents", 1, 50),
    });
    res.json(userDTO(u));
  });
  app.post("/api/admin/users/:id/password", (req, res) => {
    res.json(userDTO(sys.auth.resetPassword(me(req), String(req.params.id), str(body(req).password, "Password", 200))));
  });
  app.patch("/api/admin/users/:id/active", (req, res) => {
    const r = sys.admin.setUserActive(me(req), String(req.params.id), bool(body(req).active, "active"));
    res.json({ user: userDTO(r.user), moved: r.moved, kept: r.kept });
  });
  app.patch("/api/admin/technicians/:id", (req, res) => {
    const r = sys.admin.setTechnicianAvailability(me(req), String(req.params.id), bool(body(req).available, "available"));
    res.json({ user: userDTO(r.user), moved: r.moved, kept: r.kept });
  });

  // ------------------------------------------------------------------ admin: services, categories, SLA, strategies
  app.post("/api/admin/services", (req, res) => {
    const b = body(req);
    const s = sys.admin.addService(me(req), { id: str(b.id, "Service ID", 20), name: str(b.name, "Service name", 80), criticality: level(b.criticality, "Criticality"), userBase: int(b.userBase, "User base", 1, 10_000_000) });
    res.status(201).json(serviceDTO(s));
  });
  app.patch("/api/admin/services/:id", (req, res) => {
    const b = body(req);
    const r = sys.admin.updateService(me(req), String(req.params.id), {
      name: optStr(b.name, "Service name", 80), userBase: optInt(b.userBase, "User base", 1, 10_000_000),
      criticality: optLevel(b.criticality, "Criticality"), active: b.active === undefined ? undefined : bool(b.active, "active"),
    });
    res.json({ ...serviceDTO(r.service), reprioritised: r.reprioritised });
  });
  app.post("/api/admin/categories", (req, res) => {
    const b = body(req);
    const c = sys.admin.addCategory(me(req), str(b.name, "Category name", 30), strings(b.keywords, "Keywords"));
    res.status(201).json({ name: c.name, keywords: c.keywordList });
  });
  app.put("/api/admin/categories/:name", (req, res) => {
    const c = sys.admin.setCategoryKeywords(me(req), String(req.params.name), strings(body(req).keywords, "Keywords"));
    res.json({ name: c.name, keywords: c.keywordList });
  });
  app.delete("/api/admin/categories/:name", (req, res) => {
    sys.admin.removeCategory(me(req), String(req.params.name));
    res.json({ ok: true });
  });
  app.put("/api/admin/sla/:priority", (req, res) => {
    const b = body(req);
    const p = sys.admin.configureSla(me(req), oneOf(req.params.priority, Object.values(Priority), "Priority"),
      int(b.responseMinutes, "Response minutes", 1, 525_600), int(b.resolutionMinutes, "Resolution minutes", 1, 525_600));
    res.json({ priority: p.priority, responseMinutes: p.responseMinutes, resolutionMinutes: p.resolutionMinutes });
  });
  app.put("/api/admin/strategies", (req, res) => {
    const u = me(req);
    const b = body(req);
    if (b.assignment !== undefined) {
      const name = oneOf(b.assignment, AssignmentStrategyFactory.available(), "Assignment strategy");
      S.setAssignmentStrategy(u, name);
      opts.settings?.set("assignment_strategy", name);
    }
    if (b.priority !== undefined) {
      const name = oneOf(b.priority, PriorityStrategyFactory.available(), "Priority strategy");
      S.setPriorityStrategy(u, name);
      opts.settings?.set("priority_strategy", name);
    }
    res.json(S.currentStrategies);
  });
  app.post("/api/admin/sla-check", (req, res) => { res.json(sys.sla.runCheck(me(req))); });

  app.use("/api", (_req, res) => { res.status(404).json({ error: "NotFound", message: "No such API endpoint" }); });

  // ------------------------------------------------------------------ frontend (built React app)
  const web = join(__dirname, "..", "..", "web", "dist");
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(web, "index.html")));
  }

  // ------------------------------------------------------------------ error mapping
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ItsmError) {
      res.status(err.httpStatus).json({ error: err.name, message: err.message });
      return;
    }
    const type = (err as { type?: string }).type;
    if (err instanceof SyntaxError || type === "entity.parse.failed") {
      res.status(400).json({ error: "BadRequest", message: "Malformed JSON body" });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: "PayloadTooLarge", message: "Request body is too large" });
      return;
    }
    // Unexpected: keep the details in the server log, never in the response.
    console.error(err);
    res.status(500).json({ error: "InternalError", message: "Something went wrong on the server. The error has been logged." });
  });

  return app;
}
