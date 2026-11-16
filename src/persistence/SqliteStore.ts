import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditEntry } from "../domain/AuditEntry";
import { Category, ITService, SLAPolicy } from "../domain/catalog";
import { IncidentStatus, Level, Priority, Role } from "../domain/enums";
import { Incident, IncidentNote, IncidentSnapshot } from "../domain/Incident";
import { Admin, Employee, PasswordHash, Technician, User } from "../domain/users";
import { PersistenceException } from "../exceptions/errors";
import { InboxItem } from "../notifications/channels";
import { InMemoryRepository } from "../repositories/Repository";
import { SLAViolation } from "../services/SLAService";

type DB = Database.Database;

/** Maps one aggregate type to/from its table(s). */
interface RowMapper<T> {
  write(db: DB, entity: T): void;
  remove(db: DB, id: string): void;
}

/**
 * Write-through repository: keeps an identity map in memory (fast reads, one
 * object per row) and writes every save to SQLite inside a transaction.
 * Implements the same Repository<T> interface as the in-memory version.
 */
export class SqliteRepository<T extends { id: string }> extends InMemoryRepository<T> {
  constructor(private readonly db: DB, private readonly mapper: RowMapper<T>) {
    super();
  }

  save(entity: T): T {
    this.run(() => this.mapper.write(this.db, entity));
    return super.save(entity);
  }

  delete(id: string): boolean {
    this.run(() => this.mapper.remove(this.db, id));
    return super.delete(id);
  }

  /** Load already-built objects into the identity map without re-writing them. */
  hydrate(items: T[]): void {
    for (const i of items) this.store.set(i.id, i);
  }

  private run(fn: () => void): void {
    try {
      this.db.transaction(fn)();
    } catch (e) {
      throw new PersistenceException(`Database write failed: ${(e as Error).message}`);
    }
  }
}

const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const bool = (b: boolean) => (b ? 1 : 0);

// --------------------------------------------------------------------------- mappers
const userMapper: RowMapper<User> = {
  write(db, u) {
    const t = u instanceof Technician ? u : undefined;
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, department, experience_years, max_active, available)
       VALUES (@id, @role, @name, @email, @hash, @dept, @exp, @max, @avail)
       ON CONFLICT(id) DO UPDATE SET name=@name, email=@email, password_hash=@hash, department=@dept,
         experience_years=@exp, max_active=@max, available=@avail`,
    ).run({
      id: u.id, role: u.role, name: u.name, email: u.email, hash: u.storedPasswordHash,
      dept: u instanceof Employee ? u.department : null,
      exp: t?.experienceYears ?? null, max: t?.maxActiveIncidents ?? null, avail: bool(t ? t.available : true),
    });
    if (t) {
      db.prepare("DELETE FROM technician_skills WHERE technician_id = ?").run(t.id);
      const ins = db.prepare("INSERT INTO technician_skills (technician_id, skill) VALUES (?, ?)");
      t.skillList.forEach((s) => ins.run(t.id, s));
    }
  },
  remove(db, id) { db.prepare("DELETE FROM users WHERE id = ?").run(id); },
};

const serviceMapper: RowMapper<ITService> = {
  write(db, s) {
    db.prepare(
      `INSERT INTO it_services (id, name, criticality, user_base) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, criticality=excluded.criticality, user_base=excluded.user_base`,
    ).run(s.id, s.name, s.criticality, s.userBase);
  },
  remove(db, id) { db.prepare("DELETE FROM it_services WHERE id = ?").run(id); },
};

const categoryMapper: RowMapper<Category> = {
  write(db, c) {
    db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(c.name);
    db.prepare("DELETE FROM category_keywords WHERE category = ?").run(c.name);
    const ins = db.prepare("INSERT INTO category_keywords (category, keyword) VALUES (?, ?)");
    c.keywordList.forEach((k) => ins.run(c.name, k));
  },
  remove(db, id) { db.prepare("DELETE FROM categories WHERE name = ?").run(id); },
};

const policyMapper: RowMapper<SLAPolicy> = {
  write(db, p) {
    db.prepare(
      `INSERT INTO sla_policies (priority, response_minutes, resolution_minutes, warning_threshold) VALUES (?, ?, ?, ?)
       ON CONFLICT(priority) DO UPDATE SET response_minutes=excluded.response_minutes,
         resolution_minutes=excluded.resolution_minutes, warning_threshold=excluded.warning_threshold`,
    ).run(p.priority, p.responseMinutes, p.resolutionMinutes, p.warningThreshold);
  },
  remove(db, id) { db.prepare("DELETE FROM sla_policies WHERE priority = ?").run(id); },
};

const incidentMapper: RowMapper<Incident> = {
  write(db, inc) {
    const s = inc.toSnapshot();
    db.prepare(
      `INSERT INTO incidents (id, reporter_id, title, description, service_id, impact, urgency, affected_users, created_at,
         status, category, priority, priority_score, assignee_id, response_by, resolve_by, acknowledged_at, resolved_at,
         closed_at, resolution, feedback_rating, feedback_comment, escalation_level, response_breached, resolution_breached, warned)
       VALUES (@id, @reporterId, @title, @description, @serviceId, @impact, @urgency, @affectedUsers, @createdAt,
         @status, @category, @priority, @priorityScore, @assigneeId, @responseBy, @resolveBy, @acknowledgedAt, @resolvedAt,
         @closedAt, @resolution, @feedbackRating, @feedbackComment, @escalationLevel, @rb, @resb, @w)
       ON CONFLICT(id) DO UPDATE SET status=@status, category=@category, priority=@priority, priority_score=@priorityScore,
         assignee_id=@assigneeId, response_by=@responseBy, resolve_by=@resolveBy, acknowledged_at=@acknowledgedAt,
         resolved_at=@resolvedAt, closed_at=@closedAt, resolution=@resolution, feedback_rating=@feedbackRating,
         feedback_comment=@feedbackComment, escalation_level=@escalationLevel, response_breached=@rb,
         resolution_breached=@resb, warned=@w`,
    ).run({ ...s, related: undefined, rb: bool(s.responseBreached), resb: bool(s.resolutionBreached), w: bool(s.warned) });

    db.prepare("DELETE FROM incident_notes WHERE incident_id = ?").run(inc.id);
    const note = db.prepare("INSERT INTO incident_notes (incident_id, author_id, kind, text, at) VALUES (?, ?, ?, ?, ?)");
    inc.timeline.forEach((n) => note.run(inc.id, n.author.id, n.kind, n.text, iso(n.at)));

    // Links reference other incidents that may not be saved yet in this request; insert only existing ones.
    db.prepare("DELETE FROM incident_links WHERE incident_id = ?").run(inc.id);
    const link = db.prepare(
      "INSERT OR IGNORE INTO incident_links (incident_id, related_id) SELECT ?, id FROM incidents WHERE id = ?",
    );
    s.related.forEach((r) => link.run(inc.id, r));
  },
  remove(db, id) { db.prepare("DELETE FROM incidents WHERE id = ?").run(id); },
};

const auditMapper: RowMapper<AuditEntry> = {
  write(db, a) {
    db.prepare(
      `INSERT OR IGNORE INTO audit_log (id, at, actor, action, incident_id, previous_state, new_state, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, iso(a.at), a.actor, a.action, a.incidentId, a.previousState, a.newState, a.description);
  },
  remove() { throw new Error("Audit log is append-only"); },
};

const violationMapper: RowMapper<SLAViolation> = {
  write(db, v) {
    db.prepare(
      `INSERT OR REPLACE INTO sla_violations (id, incident_id, kind, deadline, detected_at, priority) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(v.id, v.incidentId, v.kind, iso(v.deadline), iso(v.detectedAt), v.priority);
  },
  remove(db, id) { db.prepare("DELETE FROM sla_violations WHERE id = ?").run(id); },
};

const inboxMapper: RowMapper<InboxItem> = {
  write(db, n) {
    db.prepare(
      `INSERT INTO notifications (id, user_id, subject, body, incident_id, at, read) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET read = excluded.read`,
    ).run(n.id, n.userId, n.subject, n.body, n.incidentId, iso(n.at), bool(n.read));
  },
  remove(db, id) { db.prepare("DELETE FROM notifications WHERE id = ?").run(id); },
};

// --------------------------------------------------------------------------- store
/** Opens the database, creates tables, and rebuilds the object graph from rows. */
export class SqliteStore {
  readonly db: DB;
  readonly users: SqliteRepository<User>;
  readonly services: SqliteRepository<ITService>;
  readonly categories: SqliteRepository<Category>;
  readonly policies: SqliteRepository<SLAPolicy>;
  readonly incidents: SqliteRepository<Incident>;
  readonly audit: SqliteRepository<AuditEntry>;
  readonly violations: SqliteRepository<SLAViolation>;
  readonly inbox: SqliteRepository<InboxItem>;

  constructor(path: string) {
    try {
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.exec(readFileSync(join(__dirname, "..", "..", "schema.sql"), "utf8"));
    } catch (e) {
      throw new PersistenceException(`Cannot open database at ${path}: ${(e as Error).message}`);
    }
    this.users = new SqliteRepository(this.db, userMapper);
    this.services = new SqliteRepository(this.db, serviceMapper);
    this.categories = new SqliteRepository(this.db, categoryMapper);
    this.policies = new SqliteRepository(this.db, policyMapper);
    this.incidents = new SqliteRepository(this.db, incidentMapper);
    this.audit = new SqliteRepository(this.db, auditMapper);
    this.violations = new SqliteRepository(this.db, violationMapper);
    this.inbox = new SqliteRepository(this.db, inboxMapper);
    this.load();
  }

  get isEmpty(): boolean {
    return this.users.count() === 0;
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Re-links incident_links rows that could not be written earlier (forward references). */
  relinkAll(): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO incident_links (incident_id, related_id) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const inc of this.incidents.findAll()) inc.related.forEach((r) => ins.run(inc.id, r));
    })();
  }

  private all<R>(sql: string): R[] {
    return this.db.prepare(sql).all() as R[];
  }

  private load(): void {
    // 1. reference data
    this.services.hydrate(
      this.all<{ id: string; name: string; criticality: Level; user_base: number }>("SELECT * FROM it_services")
        .map((r) => new ITService(r.id, r.name, r.criticality, r.user_base)),
    );
    const kw = this.all<{ category: string; keyword: string }>("SELECT * FROM category_keywords");
    this.categories.hydrate(
      this.all<{ name: string }>("SELECT * FROM categories")
        .map((c) => new Category(c.name, kw.filter((k) => k.category === c.name).map((k) => k.keyword))),
    );
    this.policies.hydrate(
      this.all<{ priority: Priority; response_minutes: number; resolution_minutes: number; warning_threshold: number }>("SELECT * FROM sla_policies")
        .map((p) => new SLAPolicy(p.priority, p.response_minutes, p.resolution_minutes, p.warning_threshold)),
    );

    // 2. users
    const skills = this.all<{ technician_id: string; skill: string }>("SELECT * FROM technician_skills");
    type URow = { id: string; role: Role; name: string; email: string; password_hash: string; department: string | null; experience_years: number | null; max_active: number | null; available: number };
    this.users.hydrate(
      this.all<URow>("SELECT * FROM users").map((r) => {
        const pw = PasswordHash.fromStored(r.password_hash);
        if (r.role === Role.TECHNICIAN) {
          const t = new Technician(r.id, r.name, r.email, pw, skills.filter((s) => s.technician_id === r.id).map((s) => s.skill), r.experience_years ?? 0, r.max_active ?? 5);
          t.setAvailable(!!r.available);
          return t;
        }
        if (r.role === Role.ADMIN) return new Admin(r.id, r.name, r.email, pw);
        return new Employee(r.id, r.name, r.email, pw, r.department ?? "");
      }),
    );

    // 3. incidents (+ notes, links)
    const notes = this.all<{ incident_id: string; author_id: string; kind: IncidentNote["kind"]; text: string; at: string }>("SELECT * FROM incident_notes ORDER BY id");
    const links = this.all<{ incident_id: string; related_id: string }>("SELECT * FROM incident_links");
    const user = (id: string) => this.users.findById(id)!;
    this.incidents.hydrate(
      this.all<Record<string, unknown>>("SELECT * FROM incidents").map((r) => {
        const s: IncidentSnapshot = {
          id: r.id as string, reporterId: r.reporter_id as string, title: r.title as string, description: r.description as string,
          serviceId: r.service_id as string, impact: r.impact as Level, urgency: r.urgency as Level, affectedUsers: r.affected_users as number,
          createdAt: r.created_at as string, status: r.status as IncidentStatus, category: r.category as string | null,
          priority: r.priority as Priority | null, priorityScore: r.priority_score as number, assigneeId: r.assignee_id as string | null,
          responseBy: r.response_by as string | null, resolveBy: r.resolve_by as string | null, acknowledgedAt: r.acknowledged_at as string | null,
          resolvedAt: r.resolved_at as string | null, closedAt: r.closed_at as string | null, resolution: r.resolution as string | null,
          feedbackRating: r.feedback_rating as number | null, feedbackComment: r.feedback_comment as string | null,
          escalationLevel: r.escalation_level as number, responseBreached: !!r.response_breached,
          resolutionBreached: !!r.resolution_breached, warned: !!r.warned,
          related: links.filter((l) => l.incident_id === r.id).map((l) => l.related_id),
        };
        return Incident.restore(s, {
          reporter: user(s.reporterId),
          service: this.services.findById(s.serviceId)!,
          assignee: s.assigneeId ? (user(s.assigneeId) as Technician) : undefined,
          notes: notes.filter((n) => n.incident_id === s.id).map((n) => new IncidentNote(user(n.author_id), n.kind, n.text, new Date(n.at))),
        });
      }),
    );

    // 4. technician workload is derived, not stored
    for (const t of this.users.findAll()) {
      if (!(t instanceof Technician)) continue;
      const mine = this.incidents.findAll().filter((i) => i.assignee?.id === t.id);
      const history = new Map<string, number>();
      mine.filter((i) => i.resolvedAt).forEach((i) => history.set(i.service.id, (history.get(i.service.id) ?? 0) + 1));
      t.restoreWorkload(mine.filter((i) => i.isOpen).map((i) => i.id), history);
    }

    // 5. logs
    this.audit.hydrate(
      this.all<{ id: string; at: string; actor: string; action: string; incident_id: string; previous_state: string | null; new_state: string | null; description: string }>("SELECT * FROM audit_log")
        .map((a) => new AuditEntry(a.id, new Date(a.at), a.actor, a.action, a.incident_id, a.previous_state, a.new_state, a.description)),
    );
    this.violations.hydrate(
      this.all<{ id: string; incident_id: string; kind: SLAViolation["kind"]; deadline: string; detected_at: string; priority: Priority }>("SELECT * FROM sla_violations")
        .map((v) => ({ id: v.id, incidentId: v.incident_id, kind: v.kind, deadline: new Date(v.deadline), detectedAt: new Date(v.detected_at), priority: v.priority })),
    );
    this.inbox.hydrate(
      this.all<{ id: string; user_id: string; subject: string; body: string; incident_id: string; at: string; read: number }>("SELECT * FROM notifications")
        .map((n) => ({ id: n.id, userId: n.user_id, subject: n.subject, body: n.body, incidentId: n.incident_id, at: new Date(n.at), read: !!n.read })),
    );
  }
}
