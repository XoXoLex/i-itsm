import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditEntry } from "../domain/AuditEntry";
import { Category, ITService, SLAPolicy } from "../domain/catalog";
import { IncidentStatus, Level, Priority, Role } from "../domain/enums";
import { Incident, IncidentNote, IncidentSnapshot } from "../domain/Incident";
import { Admin, Employee, PasswordHash, Technician, User } from "../domain/users";
import { PersistenceException } from "../exceptions/errors";
import { EmailRecord, EmailStatus, InboxItem } from "../notifications/channels";
import { Repository } from "../repositories/Repository";
import { SLAViolation } from "../services/SLAService";

type DB = DatabaseSync;

/** Runs fn inside one SQLite transaction; rolls back if it throws. */
function inTransaction(db: DB, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Maps one aggregate type to/from its table(s). */
interface RowMapper<T> {
  write(db: DB, entity: T): void;
  remove(db: DB, id: string): void;
}

/**
 * Write-through repository over Node's built-in SQLite (node:sqlite, no native build step).
 * It implements Repository<T> directly and owns an identity map (one object per row):
 * every save goes to SQLite inside a transaction first, and only then into the map, so
 * the map never holds something the database refused. Reads are served from the map.
 */
export class SqliteRepository<T extends { id: string }> implements Repository<T> {
  private readonly cache = new Map<string, T>();

  constructor(private readonly db: DB, private readonly mapper: RowMapper<T>) {}

  findById(id: string): T | undefined { return this.cache.get(id); }
  findAll(): T[] { return [...this.cache.values()]; }
  count(): number { return this.cache.size; }

  save(entity: T): T {
    this.run(() => this.mapper.write(this.db, entity));
    this.cache.set(entity.id, entity);
    return entity;
  }

  delete(id: string): boolean {
    this.run(() => this.mapper.remove(this.db, id));
    return this.cache.delete(id);
  }

  /** Load already-built objects into the identity map without re-writing them. */
  hydrate(items: T[]): void {
    for (const i of items) this.cache.set(i.id, i);
  }

  private run(fn: () => void): void {
    try {
      inTransaction(this.db, fn);
    } catch (e) {
      // The cause is logged for the operator; callers and API clients only see that the write failed.
      console.error("[SqliteRepository] write failed:", (e as Error).message);
      throw new PersistenceException("The database could not save this change. Nothing was changed; please try again.");
    }
  }
}

/** Columns added after the first release, so a database created by an older version keeps working. */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ["users", "active", "INTEGER NOT NULL DEFAULT 1"],
  ["it_services", "active", "INTEGER NOT NULL DEFAULT 1"],
  ["incidents", "response_warned", "INTEGER NOT NULL DEFAULT 0"],
];

function migrate(db: DB): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const bool = (b: boolean) => (b ? 1 : 0);

// --------------------------------------------------------------------------- mappers
const userMapper: RowMapper<User> = {
  write(db, u) {
    const t = u instanceof Technician ? u : undefined;
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, department, experience_years, max_active, available, active)
       VALUES (@id, @role, @name, @email, @hash, @dept, @exp, @max, @avail, @active)
       ON CONFLICT(id) DO UPDATE SET name=@name, email=@email, password_hash=@hash, department=@dept,
         experience_years=@exp, max_active=@max, available=@avail, active=@active`,
    ).run({
      id: u.id, role: u.role, name: u.name, email: u.email, hash: u.storedPasswordHash,
      dept: u instanceof Employee ? u.department : null,
      exp: t?.experienceYears ?? null, max: t?.maxActiveIncidents ?? null, avail: bool(t ? t.available : true),
      active: bool(u.active),
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
      `INSERT INTO it_services (id, name, criticality, user_base, active) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, criticality=excluded.criticality, user_base=excluded.user_base, active=excluded.active`,
    ).run(s.id, s.name, s.criticality, s.userBase, bool(s.active));
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
         closed_at, resolution, feedback_rating, feedback_comment, escalation_level, response_breached, resolution_breached,
         warned, response_warned)
       VALUES (@id, @reporterId, @title, @description, @serviceId, @impact, @urgency, @affectedUsers, @createdAt,
         @status, @category, @priority, @priorityScore, @assigneeId, @responseBy, @resolveBy, @acknowledgedAt, @resolvedAt,
         @closedAt, @resolution, @feedbackRating, @feedbackComment, @escalationLevel, @rb, @resb, @w, @rw)
       ON CONFLICT(id) DO UPDATE SET title=@title, description=@description, service_id=@serviceId, impact=@impact,
         urgency=@urgency, affected_users=@affectedUsers, status=@status, category=@category, priority=@priority, priority_score=@priorityScore,
         assignee_id=@assigneeId, response_by=@responseBy, resolve_by=@resolveBy, acknowledged_at=@acknowledgedAt,
         resolved_at=@resolvedAt, closed_at=@closedAt, resolution=@resolution, feedback_rating=@feedbackRating,
         feedback_comment=@feedbackComment, escalation_level=@escalationLevel, response_breached=@rb,
         resolution_breached=@resb, warned=@w, response_warned=@rw`,
    ).run({
      id: s.id, reporterId: s.reporterId, title: s.title, description: s.description, serviceId: s.serviceId,
      impact: s.impact, urgency: s.urgency, affectedUsers: s.affectedUsers, createdAt: s.createdAt, status: s.status,
      category: s.category, priority: s.priority, priorityScore: s.priorityScore, assigneeId: s.assigneeId,
      responseBy: s.responseBy, resolveBy: s.resolveBy, acknowledgedAt: s.acknowledgedAt, resolvedAt: s.resolvedAt,
      closedAt: s.closedAt, resolution: s.resolution, feedbackRating: s.feedbackRating, feedbackComment: s.feedbackComment,
      escalationLevel: s.escalationLevel, rb: bool(s.responseBreached), resb: bool(s.resolutionBreached),
      w: bool(s.resolutionWarned), rw: bool(s.responseWarned),
    });

    // Notes are append-only, so only the ones not stored yet are written.
    const stored = (db.prepare("SELECT COUNT(*) AS n FROM incident_notes WHERE incident_id = ?").get(inc.id) as { n: number }).n;
    const note = db.prepare("INSERT INTO incident_notes (incident_id, author_id, kind, text, at) VALUES (?, ?, ?, ?, ?)");
    inc.timeline.slice(stored).forEach((n) => note.run(inc.id, n.author.id, n.kind, n.text, iso(n.at)));

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

const emailMapper: RowMapper<EmailRecord> = {
  write(db, e) {
    db.prepare(
      `INSERT INTO email_outbox (id, user_id, recipient, subject, body, incident_id, at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, detail = excluded.detail`,
    ).run(e.id, e.userId, e.to, e.subject, e.body, e.incidentId, iso(e.at), e.status, e.detail);
  },
  remove(db, id) { db.prepare("DELETE FROM email_outbox WHERE id = ?").run(id); },
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
  readonly emails: SqliteRepository<EmailRecord>;

  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.db.exec(readFileSync(join(__dirname, "..", "..", "schema.sql"), "utf8"));
      migrate(this.db);
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
    this.emails = new SqliteRepository(this.db, emailMapper);
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
    inTransaction(this.db, () => {
      for (const inc of this.incidents.findAll()) inc.related.forEach((r) => ins.run(inc.id, r));
    });
  }

  private all<R>(sql: string): R[] {
    return this.db.prepare(sql).all() as unknown as R[];
  }

  private load(): void {
    // 1. reference data
    this.services.hydrate(
      this.all<{ id: string; name: string; criticality: Level; user_base: number; active: number }>("SELECT * FROM it_services")
        .map((r) => { const s = new ITService(r.id, r.name, r.criticality, r.user_base); s.setActive(!!r.active); return s; }),
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
    type URow = { id: string; role: Role; name: string; email: string; password_hash: string; department: string | null; experience_years: number | null; max_active: number | null; available: number; active: number };
    const build = (r: URow): User => {
      const pw = PasswordHash.fromStored(r.password_hash);
      if (r.role === Role.TECHNICIAN) {
        const t = new Technician(r.id, r.name, r.email, pw, skills.filter((s) => s.technician_id === r.id).map((s) => s.skill),
          // Rows written by an older version may hold values today's validation rejects; clamp instead of refusing to start.
          Math.min(60, Math.max(0, r.experience_years ?? 0)), Math.min(50, Math.max(1, Math.round(r.max_active ?? 5))));
        t.setAvailable(!!r.available);
        return t;
      }
      if (r.role === Role.ADMIN) return new Admin(r.id, r.name, r.email, pw);
      return new Employee(r.id, r.name, r.email, pw, r.department ?? "");
    };
    this.users.hydrate(
      this.all<URow>("SELECT * FROM users").map((r) => { const u = build(r); u.setActive(!!r.active); return u; }),
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
          resolutionBreached: !!r.resolution_breached, resolutionWarned: !!r.warned, responseWarned: !!r.response_warned,
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
      mine.filter((i) => i.resolvedAt && !i.isOpen).forEach((i) => history.set(i.service.id, (history.get(i.service.id) ?? 0) + 1));
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
