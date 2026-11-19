import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Permission, Role } from "./enums";
import { InvalidInputException, TechnicianWorkloadExceededException } from "../exceptions/errors";

/** Password is never stored in plain text: salted scrypt hash. */
export class PasswordHash {
  private constructor(private readonly salt: string, private readonly hash: string) {}

  static fromPlain(plain: string): PasswordHash {
    const salt = randomBytes(16).toString("hex");
    return new PasswordHash(salt, scryptSync(plain, salt, 32).toString("hex"));
  }

  static fromStored(stored: string): PasswordHash {
    const [salt, hash] = stored.split(":");
    return new PasswordHash(salt, hash);
  }

  matches(plain: string): boolean {
    const candidate = scryptSync(plain, this.salt, 32);
    return timingSafeEqual(candidate, Buffer.from(this.hash, "hex"));
  }

  toString(): string {
    return `${this.salt}:${this.hash}`;
  }
}

/**
 * Abstract base for every user. Subclasses only differ in role and permissions,
 * which is a true "is-a" relationship (a Technician IS a User).
 */
export abstract class User {
  private _active = true;

  constructor(
    readonly id: string,
    private _name: string,
    private _email: string,
    private password: PasswordHash,
  ) {}

  abstract get role(): Role;
  protected abstract permissions(): ReadonlySet<Permission>;

  get name(): string { return this._name; }
  get email(): string { return this._email; }
  /** A deactivated account keeps its history but cannot log in or act. */
  get active(): boolean { return this._active; }

  can(p: Permission): boolean {
    return this._active && this.permissions().has(p);
  }

  setActive(active: boolean): void { this._active = active; }

  checkPassword(plain: string): boolean {
    return this.password.matches(plain);
  }

  changePassword(plain: string): void {
    if (typeof plain !== "string" || plain.length < 8) throw new InvalidInputException("Password must be at least 8 characters");
    this.password = PasswordHash.fromPlain(plain);
  }

  /** Persistence only: salted hash, never the password itself. */
  get storedPasswordHash(): string {
    return this.password.toString();
  }

  rename(name: string): void {
    if (!name.trim()) throw new InvalidInputException("Name cannot be empty");
    this._name = name.trim();
  }

  /** Uniqueness is checked by the service; the format is checked here. */
  changeEmail(email: string): void {
    if (!EMAIL_RE.test(email)) throw new InvalidInputException(`Invalid email: ${email}`);
    this._email = email.trim();
  }

  toString(): string {
    return `${this.role} ${this.id} (${this._name})`;
  }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPLOYEE_PERMS: ReadonlySet<Permission> = new Set([
  Permission.REPORT_INCIDENT,
  Permission.VIEW_OWN_INCIDENTS,
  Permission.ADD_INFO,
  Permission.VERIFY_RESOLUTION,
  Permission.GIVE_FEEDBACK,
]);

/** A technician can also be a reporter, so they get the reporter follow-ups for incidents they filed themselves. */
const TECHNICIAN_PERMS: ReadonlySet<Permission> = new Set([
  ...EMPLOYEE_PERMS,
  Permission.WORK_ON_INCIDENT,
]);

const ADMIN_PERMS: ReadonlySet<Permission> = new Set(Object.values(Permission));

export class Employee extends User {
  constructor(id: string, name: string, email: string, password: PasswordHash, private _department: string) {
    super(id, name, email, password);
  }
  get department(): string { return this._department; }
  moveTo(department: string): void { this._department = department.trim(); }
  get role(): Role { return Role.EMPLOYEE; }
  protected permissions() { return EMPLOYEE_PERMS; }
}

export interface TechnicianProfile {
  skills: string[];
  experienceYears: number;
  maxActiveIncidents: number;
}

export class Technician extends User {
  private skills = new Set<string>();
  private _experienceYears = 0;
  private _maxActiveIncidents = 5;
  private readonly activeIncidents = new Set<string>();
  private readonly resolvedServiceHistory = new Map<string, number>(); // serviceId -> count
  private _available = true;

  constructor(
    id: string,
    name: string,
    email: string,
    password: PasswordHash,
    skills: string[],
    experienceYears: number,
    maxActiveIncidents = 5,
  ) {
    super(id, name, email, password);
    this.updateProfile({ skills, experienceYears, maxActiveIncidents });
  }

  get role(): Role { return Role.TECHNICIAN; }
  protected permissions() { return TECHNICIAN_PERMS; }

  get workload(): number { return this.activeIncidents.size; }
  get available(): boolean { return this._available; }
  get skillList(): string[] { return [...this.skills]; }
  get experienceYears(): number { return this._experienceYears; }
  get maxActiveIncidents(): number { return this._maxActiveIncidents; }

  hasSkill(category: string): boolean { return this.skills.has(category.toUpperCase()); }
  isOverloaded(): boolean { return this.workload >= this._maxActiveIncidents; }
  canTakeMore(): boolean { return this.active && this._available && !this.isOverloaded(); }
  experienceWith(serviceId: string): number { return this.resolvedServiceHistory.get(serviceId) ?? 0; }
  holds(incidentId: string): boolean { return this.activeIncidents.has(incidentId); }

  setAvailable(available: boolean): void { this._available = available; }

  /** The only way to change skills, experience or the workload limit; rejects values that would break assignment. */
  updateProfile(p: TechnicianProfile): void {
    Technician.validateProfile(p);
    this.skills = new Set(p.skills.map((s) => s.trim().toUpperCase()).filter(Boolean));
    this._experienceYears = p.experienceYears;
    this._maxActiveIncidents = p.maxActiveIncidents;
  }

  static validateProfile(p: TechnicianProfile): void {
    if (!Array.isArray(p.skills) || p.skills.some((s) => typeof s !== "string")) throw new InvalidInputException("Skills must be a list of category names");
    if (!Number.isInteger(p.maxActiveIncidents) || p.maxActiveIncidents < 1 || p.maxActiveIncidents > 50) {
      throw new InvalidInputException("Max active incidents must be a whole number from 1 to 50");
    }
    if (!Number.isFinite(p.experienceYears) || p.experienceYears < 0 || p.experienceYears > 60) {
      throw new InvalidInputException("Years of experience must be between 0 and 60");
    }
  }

  /** Persistence only: workload and history are derived from stored incidents on startup. */
  restoreWorkload(activeIds: string[], resolvedByService: Map<string, number>): void {
    this.activeIncidents.clear();
    activeIds.forEach((id) => this.activeIncidents.add(id));
    this.resolvedServiceHistory.clear();
    resolvedByService.forEach((n, svc) => this.resolvedServiceHistory.set(svc, n));
  }

  takeIncident(incidentId: string): void {
    if (this.activeIncidents.has(incidentId)) return; // already theirs: nothing to count twice
    if (this.isOverloaded()) throw new TechnicianWorkloadExceededException(this.name, this._maxActiveIncidents);
    this.activeIncidents.add(incidentId);
  }

  releaseIncident(incidentId: string, resolvedServiceId?: string): void {
    this.activeIncidents.delete(incidentId);
    if (resolvedServiceId) {
      this.resolvedServiceHistory.set(resolvedServiceId, this.experienceWith(resolvedServiceId) + 1);
    }
  }
}

export class Admin extends User {
  get role(): Role { return Role.ADMIN; }
  protected permissions() { return ADMIN_PERMS; }
}
