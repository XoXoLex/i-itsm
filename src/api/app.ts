import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IncidentStatus, Level, Permission, Priority, Role, SLAStatus } from "../domain/enums";
import { Technician, User } from "../domain/users";
import { AuthenticationRequiredException, InvalidInputException, ItsmError, UnauthorizedOperationException } from "../exceptions/errors";
import { IncidentQuery } from "../services/ReportService";
import { AssignmentStrategyFactory } from "../strategies/assignment/AssignmentStrategy";
import { PriorityStrategyFactory } from "../strategies/priority/PriorityStrategy";
import { ItsmSystem } from "../system";
import { auditDTO, incidentDetailDTO, incidentDTO, userDTO } from "./dto";
import { LiveChannel } from "./integrations";

type AuthedRequest = Request & { user: User };

/** Simple brute-force protection: 5 failed logins per email per 5 minutes. */
class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  check(email: string): void {
    const recent = (this.fails.get(email) ?? []).filter((t) => Date.now() - t < 5 * 60_000);
    this.fails.set(email, recent);
    if (recent.length >= 5) throw new InvalidInputException("Too many failed attempts. Try again in a few minutes.");
  }
  fail(email: string): void { this.fails.set(email, [...(this.fails.get(email) ?? []), Date.now()]); }
  clear(email: string): void { this.fails.delete(email); }
}

export function createApp(sys: ItsmSystem, live: LiveChannel, jwtSecret: string, settings?: { set(k: string, v: string): void }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "200kb" }));

  const S = sys.incidentService;
  const throttle = new LoginThrottle();
  const sign = (u: User) => jwt.sign({ sub: u.id, role: u.role }, jwtSecret, { expiresIn: "12h" });

  // ------------------------------------------------------------------ auth middleware
  const userFromToken = (token?: string): User => {
    if (!token) throw new AuthenticationRequiredException();
    try {
      const payload = jwt.verify(token, jwtSecret) as { sub: string };
      return sys.auth.getUser(payload.sub);
    } catch {
      throw new AuthenticationRequiredException("Session expired or invalid, please log in again");
    }
  };
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    (req as AuthedRequest).user = userFromToken(h?.startsWith("Bearer ") ? h.slice(7) : undefined);
    next();
  };
  const me = (req: Request) => (req as AuthedRequest).user;
  const dto = (i: Parameters<typeof incidentDTO>[0]) => incidentDTO(i, sys.sla);
  const detail = (i: Parameters<typeof incidentDTO>[0]) => incidentDetailDTO(i, sys.sla);
  const str = (v: unknown, field: string) => {
    if (typeof v !== "string" || !v.trim()) throw new InvalidInputException(`${field} is required`);
    return v.trim();
  };
  const level = (v: unknown, field: string): Level => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new InvalidInputException(`${field} must be 1–4`);
    return n as Level;
  };
  const list = <T extends string>(v: unknown): T[] | undefined => (typeof v === "string" && v ? (v.split(",") as T[]) : undefined);

  // ------------------------------------------------------------------ public
  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

  app.post("/api/auth/register", (req, res) => {
    const { name, email, password, department } = req.body ?? {};
    const u = sys.auth.registerEmployee(str(name, "Name"), str(email, "Email"), String(password ?? ""), String(department ?? "General"));
    res.status(201).json({ token: sign(u), user: userDTO(u) });
  });

  app.post("/api/auth/login", (req, res) => {
    const email = String(req.body?.email ?? "").toLowerCase();
    throttle.check(email);
    try {
      const u = sys.auth.login(email, String(req.body?.password ?? ""));
      throttle.clear(email);
      res.json({ token: sign(u), user: userDTO(u) });
    } catch (e) {
      throttle.fail(email);
      throw e;
    }
  });

  // Server-Sent Events; EventSource cannot send headers, so the token comes as a query param.
  app.get("/api/events", (req, res) => {
    const u = userFromToken(String(req.query.token ?? ""));
    live.connect(u.id, res);
  });

  // ------------------------------------------------------------------ everything below needs login
  app.use("/api", auth);

  app.get("/api/me", (req, res) => { res.json(userDTO(me(req))); });

  app.get("/api/meta", (_req, res) => {
    res.json({
      services: sys.services.findAll().map((s) => ({ id: s.id, name: s.name, criticality: s.criticality, userBase: s.userBase })),
      categories: sys.categories.findAll().map((c) => ({ name: c.name, keywords: c.keywordList })),
      levels: [1, 2, 3, 4].map((l) => ({ value: l, label: Level[l] })),
      statuses: Object.values(IncidentStatus), priorities: Object.values(Priority), slaStatuses: Object.values(SLAStatus),
      technicians: sys.users.findAll().filter((u): u is Technician => u instanceof Technician).map((t) => ({ id: t.id, name: t.name })),
      slaPolicies: sys.sla.allPolicies.map((p) => ({ priority: p.priority, responseMinutes: p.responseMinutes, resolutionMinutes: p.resolutionMinutes })),
      strategies: { ...S.currentStrategies, assignmentOptions: AssignmentStrategyFactory.available(), priorityOptions: PriorityStrategyFactory.available() },
      categorizer: sys.incidentService.categorizerName,
    });
  });

  // ------------------------------------------------------------------ incidents
  app.get("/api/incidents", (req, res) => {
    const q = req.query;
    const query: IncidentQuery = {
      id: q.id ? String(q.id) : undefined,
      text: q.text ? String(q.text) : undefined,
      status: list<IncidentStatus>(q.status),
      priority: list<Priority>(q.priority),
      category: q.category ? String(q.category) : undefined,
      serviceId: q.serviceId ? String(q.serviceId) : undefined,
      technicianId: q.technicianId ? String(q.technicianId) : undefined,
      from: q.from ? new Date(String(q.from)) : undefined,
      to: q.to ? new Date(`${String(q.to)}T23:59:59`) : undefined,
      slaStatus: q.slaStatus ? (String(q.slaStatus) as SLAStatus) : undefined,
      openOnly: q.openOnly === "true",
    };
    res.json(sys.reports.search(S.visibleTo(me(req)), query).map(dto));
  });

  app.post("/api/incidents", async (req, res) => {
    const b = req.body ?? {};
    const { incident, duplicates } = await S.report(me(req), {
      title: str(b.title, "Title"), description: str(b.description, "Description"), serviceId: str(b.serviceId, "Service"),
      impact: level(b.impact, "Impact"), urgency: level(b.urgency, "Urgency"),
      affectedUsers: Number(b.affectedUsers ?? 1), category: b.category || undefined,
    });
    res.status(201).json({ incident: detail(incident), duplicates: duplicates.map((d) => ({ id: d.incident.id, title: d.incident.title, similarity: d.similarity })) });
  });

  app.get("/api/incidents/:id", (req, res) => {
    const u = me(req);
    const inc = S.get(u, req.params.id);
    const canWork = u.role !== Role.EMPLOYEE;
    res.json({
      ...detail(inc),
      audit: u.can(Permission.VIEW_AUDIT) ? sys.reports.auditTrail(u, inc.id).map(auditDTO) : undefined,
      suggestions: canWork ? S.suggestResolutions(u, inc.id) : undefined,
    });
  });

  const action = (path: string, fn: (u: User, id: string, body: Record<string, unknown>) => unknown) =>
    app.post(`/api/incidents/:id/${path}`, (req, res) => {
      const result = fn(me(req), String(req.params.id), req.body ?? {});
      res.json(detail(result as Parameters<typeof incidentDTO>[0]));
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
  action("feedback", (u, id, b) => S.feedback(u, id, Number(b.rating), String(b.comment ?? "")));
  action("assign", (u, id, b) => S.assign(u, id, b.technicianId ? String(b.technicianId) : undefined));

  // ------------------------------------------------------------------ notifications
  app.get("/api/notifications", (req, res) => { res.json(sys.inApp.inboxOf(me(req).id).slice(0, 50)); });
  app.post("/api/notifications/read", (req, res) => { sys.inApp.markAllRead(me(req).id); res.json({ ok: true }); });

  // ------------------------------------------------------------------ reports (admin)
  app.get("/api/reports/overview", (req, res) => { res.json(sys.reports.overview(me(req))); });
  app.get("/api/reports/workload", (req, res) => { res.json(sys.reports.technicianWorkload(me(req))); });
  app.get("/api/reports/by-service", (req, res) => { res.json(sys.reports.byService(me(req))); });
  app.get("/api/reports/by-category", (req, res) => { res.json(sys.reports.byCategory(me(req))); });
  app.get("/api/reports/by-priority", (req, res) => { res.json(sys.reports.byPriority(me(req))); });
  app.get("/api/reports/trend", (req, res) => { res.json(sys.reports.dailyTrend(me(req), 10)); });
  app.get("/api/reports/sla-violations", (req, res) => {
    if (!me(req).can(Permission.VIEW_REPORTS)) throw new UnauthorizedOperationException(me(req).name, "view SLA violations");
    res.json(sys.sla.violations.reverse());
  });
  app.get("/api/reports/audit", (req, res) => {
    const id = req.query.incidentId ? String(req.query.incidentId) : undefined;
    res.json(sys.reports.auditTrail(me(req), id).reverse().slice(0, 300).map(auditDTO));
  });

  // ------------------------------------------------------------------ admin configuration
  app.get("/api/admin/users", (req, res) => { res.json(sys.admin.listUsers(me(req)).map(userDTO)); });
  app.post("/api/admin/users", (req, res) => {
    const b = req.body ?? {};
    const kind = b.role === "ADMIN" ? "ADMIN" : "TECHNICIAN";
    const u = sys.auth.createStaff(me(req), kind, {
      name: str(b.name, "Name"), email: str(b.email, "Email"), password: String(b.password ?? ""),
      skills: Array.isArray(b.skills) ? b.skills : String(b.skills ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      experienceYears: Number(b.experienceYears ?? 0), maxActive: Number(b.maxActive ?? 5),
    });
    res.status(201).json(userDTO(u));
  });
  app.patch("/api/admin/technicians/:id", (req, res) => {
    res.json(userDTO(sys.admin.setTechnicianAvailability(me(req), String(req.params.id), Boolean(req.body?.available))));
  });
  app.post("/api/admin/services", (req, res) => {
    const b = req.body ?? {};
    const s = sys.admin.addService(me(req), { id: str(b.id, "Service id"), name: str(b.name, "Service name"), criticality: level(b.criticality, "Criticality"), userBase: Number(b.userBase) });
    res.status(201).json({ id: s.id, name: s.name, criticality: s.criticality, userBase: s.userBase });
  });
  app.patch("/api/admin/services/:id", (req, res) => {
    const s = sys.admin.setServiceCriticality(me(req), String(req.params.id), level(req.body?.criticality, "Criticality"));
    res.json({ id: s.id, name: s.name, criticality: s.criticality, userBase: s.userBase });
  });
  app.post("/api/admin/categories", (req, res) => {
    const b = req.body ?? {};
    const kw = Array.isArray(b.keywords) ? b.keywords : String(b.keywords ?? "").split(",").map((s: string) => s.trim());
    const c = sys.admin.addCategory(me(req), str(b.name, "Category name"), kw);
    res.status(201).json({ name: c.name, keywords: c.keywordList });
  });
  app.put("/api/admin/sla/:priority", (req, res) => {
    const p = sys.admin.configureSla(me(req), String(req.params.priority) as Priority, Number(req.body?.responseMinutes), Number(req.body?.resolutionMinutes));
    res.json({ priority: p.priority, responseMinutes: p.responseMinutes, resolutionMinutes: p.resolutionMinutes });
  });
  app.put("/api/admin/strategies", (req, res) => {
    const u = me(req);
    if (req.body?.assignment) {
      S.setAssignmentStrategy(u, String(req.body.assignment));
      settings?.set("assignment_strategy", String(req.body.assignment).toUpperCase());
    }
    if (req.body?.priority) {
      S.setPriorityStrategy(u, PriorityStrategyFactory.create(String(req.body.priority)));
      settings?.set("priority_strategy", String(req.body.priority).toUpperCase());
    }
    res.json(S.currentStrategies);
  });
  app.post("/api/admin/sla-check", (req, res) => {
    if (!me(req).can(Permission.CONFIGURE_SYSTEM)) throw new UnauthorizedOperationException(me(req).name, "run the SLA monitor");
    res.json(sys.sla.checkAll());
  });

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
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "BadRequest", message: "Malformed JSON body" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "InternalError", message: (err as Error).message ?? "Unexpected error" });
  });

  return app;
}
