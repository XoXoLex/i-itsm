import { AuditEntry } from "./domain/AuditEntry";
import { Category, ITService, SLAPolicy } from "./domain/catalog";
import { Level, Priority } from "./domain/enums";
import { Incident } from "./domain/Incident";
import { User } from "./domain/users";
import { EventBus } from "./events/EventBus";
import { AuditLogger, NotificationDispatcher } from "./events/observers";
import { DuplicateDetector, KeywordCategorizer, ResolutionSuggester } from "./intelligence/intelligence";
import { InAppChannel, InboxItem, NotificationChannel, SimulatedEmailChannel } from "./notifications/channels";
import { SqliteStore } from "./persistence/SqliteStore";
import { InMemoryRepository } from "./repositories/Repository";
import { AuthService } from "./services/AuthService";
import { Clock, SystemClock } from "./services/Clock";
import { IncidentService } from "./services/IncidentService";
import { ReportService } from "./services/ReportService";
import { AdminService } from "./services/AdminService";
import { SLAService, SLAViolation } from "./services/SLAService";
import { Categorizer } from "./intelligence/intelligence";
import { SkillBasedAssignment } from "./strategies/assignment/AssignmentStrategy";
import { WeightedScorePriorityStrategy } from "./strategies/priority/PriorityStrategy";

export interface BuildOptions {
  store?: SqliteStore;                 // omit for a pure in-memory system (tests)
  categorizer?: Categorizer;           // defaults to keyword matching
  extraChannels?: NotificationChannel[]; // e.g. real-time push, real email
}

/** Composition root: the one place that wires concrete classes together. */
export function buildSystem(clock: Clock = new SystemClock(), opts: BuildOptions = {}) {
  const st = opts.store;
  const users = st?.users ?? new InMemoryRepository<User>();
  const incidents = st?.incidents ?? new InMemoryRepository<Incident>();
  const services = st?.services ?? new InMemoryRepository<ITService>();
  const categories = st?.categories ?? new InMemoryRepository<Category>();
  const policies = st?.policies ?? new InMemoryRepository<SLAPolicy>();
  const audit = st?.audit ?? new InMemoryRepository<AuditEntry>();
  const violations = st?.violations ?? new InMemoryRepository<SLAViolation>();
  const inbox = st?.inbox ?? new InMemoryRepository<InboxItem>();

  const inApp = new InAppChannel(inbox);
  const email = new SimulatedEmailChannel();

  const bus = new EventBus();
  bus.subscribe(new AuditLogger(audit));
  bus.subscribe(new NotificationDispatcher([inApp, email, ...(opts.extraChannels ?? [])], users));

  const sla = new SLAService(policies, incidents, bus, clock, violations);
  const auth = new AuthService(users);
  const incidentService = new IncidentService({
    incidents, users, services, categories, bus, clock, sla,
    priorityStrategy: new WeightedScorePriorityStrategy(),
    assignmentStrategy: new SkillBasedAssignment(),
    categorizer: opts.categorizer ?? new KeywordCategorizer(),
    duplicateDetector: new DuplicateDetector(),
    resolutionSuggester: new ResolutionSuggester(),
  });
  const reports = new ReportService(incidents, users, audit, sla);
  const admin = new AdminService(users, services, categories, sla);

  return { users, incidents, services, categories, policies, audit, inApp, email, bus, sla, auth, incidentService, reports, admin, clock, store: st };
}

export type ItsmSystem = ReturnType<typeof buildSystem>;

/** Default reference data: SLA table from the brief, categories, services, staff. */
export function seed(sys: ItsmSystem) {
  for (const p of [
    new SLAPolicy(Priority.P1, 5, 30),
    new SLAPolicy(Priority.P2, 15, 120),
    new SLAPolicy(Priority.P3, 60, 480),
    new SLAPolicy(Priority.P4, 240, 1440),
  ]) sys.policies.save(p);

  const cats: [string, string[]][] = [
    ["HARDWARE", ["laptop", "printer", "monitor", "keyboard", "mouse", "hardware", "screen", "battery"]],
    ["SOFTWARE", ["install", "license", "update", "crash", "software", "excel", "word", "outlook"]],
    ["NETWORK", ["wifi", "network", "internet", "vpn", "slow", "latency", "router", "connection", "dns"]],
    ["DATABASE", ["database", "query", "sql", "db", "table", "deadlock", "replica"]],
    ["CLOUD", ["aws", "azure", "cloud", "server", "instance", "kubernetes", "container"]],
    ["SECURITY", ["phishing", "virus", "malware", "breach", "suspicious", "hack", "ransomware"]],
    ["AUTHENTICATION", ["login", "password", "sso", "otp", "locked", "authentication", "access", "mfa"]],
    ["APPLICATION", ["payment", "transaction", "app", "application", "portal", "checkout", "error", "unavailable", "page"]],
    ["STORAGE", ["disk", "storage", "drive", "quota", "backup", "file", "upload"]],
  ];
  for (const [name, kw] of cats) sys.categories.save(new Category(name, kw));

  const svc = {
    payment: sys.services.save(new ITService("SVC-PAY", "Payment Application", Level.CRITICAL, 500)),
    email: sys.services.save(new ITService("SVC-MAIL", "Corporate Email", Level.HIGH, 800)),
    vpn: sys.services.save(new ITService("SVC-VPN", "VPN", Level.HIGH, 300)),
    db: sys.services.save(new ITService("SVC-DB", "Customer Database", Level.CRITICAL, 200)),
    printer: sys.services.save(new ITService("SVC-PRINT", "Office Printing", Level.LOW, 150)),
    sso: sys.services.save(new ITService("SVC-SSO", "SSO Login", Level.CRITICAL, 1000)),
    storage: sys.services.save(new ITService("SVC-CLOUD", "Cloud File Storage", Level.MEDIUM, 600)),
    devices: sys.services.save(new ITService("SVC-DEVICE", "Laptops & Desktops", Level.MEDIUM, 900)),
  };

  const admin = sys.auth.bootstrapAdmin("Priya Admin", "admin@itsm.local", "admin1234");
  const pw = "tech12345";
  const techs = {
    t1: sys.auth.createStaff(admin, "TECHNICIAN", { name: "Rahul (App/DB)", email: "rahul@itsm.local", password: pw, skills: ["APPLICATION", "DATABASE"], experienceYears: 6 }),
    t2: sys.auth.createStaff(admin, "TECHNICIAN", { name: "Sneha (Network)", email: "sneha@itsm.local", password: pw, skills: ["NETWORK", "SECURITY", "AUTHENTICATION"], experienceYears: 4 }),
    t3: sys.auth.createStaff(admin, "TECHNICIAN", { name: "Arjun (App/Cloud)", email: "arjun@itsm.local", password: pw, skills: ["APPLICATION", "CLOUD"], experienceYears: 2, maxActive: 2 }),
    t4: sys.auth.createStaff(admin, "TECHNICIAN", { name: "Meera (Desktop)", email: "meera@itsm.local", password: pw, skills: ["HARDWARE", "SOFTWARE", "STORAGE"], experienceYears: 3 }),
  };
  const employees = {
    e1: sys.auth.registerEmployee("Ankit Sharma", "ankit@corp.local", "employee1", "Finance"),
    e2: sys.auth.registerEmployee("Divya Rao", "divya@corp.local", "employee2", "Sales"),
    e3: sys.auth.registerEmployee("Karan Mehta", "karan@corp.local", "employee3", "Support"),
  };
  return { admin, techs, employees, svc };
}
