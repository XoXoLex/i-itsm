import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Permission, Role } from "./enums";
import { TechnicianWorkloadExceededException } from "../exceptions/errors";

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

  can(p: Permission): boolean {
    return this.permissions().has(p);
  }

  checkPassword(plain: string): boolean {
    return this.password.matches(plain);
  }

  changePassword(plain: string): void {
    if (!plain || plain.length < 8) throw new Error("Password must be at least 8 characters");
    this.password = PasswordHash.fromPlain(plain);
  }

  /** Persistence only: salted hash, never the password itself. */
  get storedPasswordHash(): string {
    return this.password.toString();
  }

  rename(name: string): void {
    if (!name.trim()) throw new Error("Name cannot be empty");
    this._name = name.trim();
  }

  toString(): string {
    return `${this.role} ${this.id} (${this._name})`;
  }
}

const EMPLOYEE_PERMS: ReadonlySet<Permission> = new Set([
  Permission.REPORT_INCIDENT,
  Permission.VIEW_OWN_INCIDENTS,
  Permission.ADD_INFO,
  Permission.VERIFY_RESOLUTION,
  Permission.GIVE_FEEDBACK,
]);

const TECHNICIAN_PERMS: ReadonlySet<Permission> = new Set([
  Permission.REPORT_INCIDENT,
  Permission.VIEW_OWN_INCIDENTS,
  Permission.WORK_ON_INCIDENT,
]);

const ADMIN_PERMS: ReadonlySet<Permission> = new Set(Object.values(Permission));

export class Employee extends User {
  constructor(id: string, name: string, email: string, password: PasswordHash, readonly department: string) {
    super(id, name, email, password);
  }
  get role(): Role { return Role.EMPLOYEE; }
  protected permissions() { return EMPLOYEE_PERMS; }
}

export class Technician extends User {
  private readonly skills: Set<string>;
  private readonly activeIncidents = new Set<string>();
  private readonly resolvedServiceHistory = new Map<string, number>(); // serviceId -> count
  private _available = true;

  constructor(
    id: string,
    name: string,
    email: string,
    password: PasswordHash,
    skills: string[],
    readonly experienceYears: number,
    readonly maxActiveIncidents = 5,
  ) {
    super(id, name, email, password);
    this.skills = new Set(skills.map((s) => s.toUpperCase()));
  }

  get role(): Role { return Role.TECHNICIAN; }
  protected permissions() { return TECHNICIAN_PERMS; }

  get workload(): number { return this.activeIncidents.size; }
  get available(): boolean { return this._available; }
  get skillList(): string[] { return [...this.skills]; }

  hasSkill(category: string): boolean { return this.skills.has(category.toUpperCase()); }
  isOverloaded(): boolean { return this.workload >= this.maxActiveIncidents; }
  canTakeMore(): boolean { return this._available && !this.isOverloaded(); }
  experienceWith(serviceId: string): number { return this.resolvedServiceHistory.get(serviceId) ?? 0; }

  setAvailable(available: boolean): void { this._available = available; }

  /** Persistence only: workload and history are derived from stored incidents on startup. */
  restoreWorkload(activeIds: string[], resolvedByService: Map<string, number>): void {
    this.activeIncidents.clear();
    activeIds.forEach((id) => this.activeIncidents.add(id));
    this.resolvedServiceHistory.clear();
    resolvedByService.forEach((n, svc) => this.resolvedServiceHistory.set(svc, n));
  }

  takeIncident(incidentId: string): void {
    if (this.isOverloaded()) throw new TechnicianWorkloadExceededException(this.name, this.maxActiveIncidents);
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
