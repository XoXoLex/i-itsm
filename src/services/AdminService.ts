import { Category, ITService, SLAPolicy } from "../domain/catalog";
import { Level, Permission, Priority } from "../domain/enums";
import { Employee, Technician, User } from "../domain/users";
import { InvalidInputException, ServiceNotFoundException, UnauthorizedOperationException, UserNotFoundException } from "../exceptions/errors";
import { Repository } from "../repositories/Repository";
import { AuthService } from "./AuthService";
import { IncidentService } from "./IncidentService";
import { SLAService } from "./SLAService";

export interface StaffData {
  name: string; email: string; password: string;
  skills?: string[]; experienceYears?: number; maxActive?: number;
}

export interface UserChanges {
  name?: string; email?: string; department?: string;
  skills?: string[]; experienceYears?: number; maxActive?: number;
}

/** Administrator use cases: people, IT services, categories and SLA policies. */
export class AdminService {
  constructor(
    private readonly users: Repository<User>,
    private readonly services: Repository<ITService>,
    private readonly categories: Repository<Category>,
    private readonly sla: SLAService,
    private readonly auth: AuthService,
    private readonly incidents: IncidentService,
  ) {}

  // ======================= people =======================
  listUsers(actor: User): User[] {
    this.guard(actor, Permission.MANAGE_USERS, "list users");
    return this.users.findAll().sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  addStaff(actor: User, kind: "TECHNICIAN" | "ADMIN", data: StaffData): User {
    this.guard(actor, Permission.MANAGE_USERS, "create staff accounts");
    return this.auth.createStaff(actor, kind, { ...data, skills: kind === "TECHNICIAN" ? this.knownSkills(data.skills ?? []) : [] });
  }

  /** Only the fields that are sent change; everything is validated before anything is saved. */
  updateUser(actor: User, userId: string, c: UserChanges): User {
    this.guard(actor, Permission.MANAGE_USERS, "edit users");
    const u = this.user(userId);
    const profile = u instanceof Technician
      ? {
          skills: c.skills !== undefined ? this.knownSkills(c.skills) : u.skillList,
          experienceYears: c.experienceYears ?? u.experienceYears,
          maxActiveIncidents: c.maxActive ?? u.maxActiveIncidents,
        }
      : undefined;
    if (u instanceof Technician && profile!.maxActiveIncidents < u.workload) {
      throw new InvalidInputException(`${u.name} already has ${u.workload} active incidents; the limit cannot go below that`);
    }
    // Validate the technician profile before the name changes, so a bad value cannot leave the account half-edited.
    if (profile) Technician.validateProfile(profile);
    this.auth.updateIdentity(actor, userId, c.name ?? u.name, c.email ?? u.email);
    if (u instanceof Technician) u.updateProfile(profile!);
    if (u instanceof Employee && c.department !== undefined) u.moveTo(c.department);
    return this.users.save(u);
  }

  /**
   * Deactivating keeps the account and its history but ends its access. A deactivated
   * technician's open incidents are handed to colleagues.
   */
  setUserActive(actor: User, userId: string, active: boolean): { user: User; moved: number; kept: number } {
    this.guard(actor, Permission.MANAGE_USERS, "deactivate users");
    const u = this.user(userId);
    if (u.id === actor.id && !active) throw new InvalidInputException("You cannot deactivate your own account");
    if (!active && u.can(Permission.MANAGE_USERS) && this.users.findAll().filter((x) => x.can(Permission.MANAGE_USERS)).length <= 1) {
      throw new InvalidInputException("At least one administrator must stay active");
    }
    u.setActive(active);
    this.users.save(u);
    const r = !active && u instanceof Technician ? this.incidents.releaseWorkOf(actor, u, `${u.name} deactivated`) : { moved: 0, kept: 0 };
    return { user: u, ...r };
  }

  /** Marking a technician away stops new assignments and hands their open incidents to colleagues. */
  setTechnicianAvailability(actor: User, techId: string, available: boolean): { user: Technician; moved: number; kept: number } {
    this.guard(actor, Permission.MANAGE_USERS, "change technician availability");
    const t = this.users.findById(techId);
    if (!(t instanceof Technician)) throw new UserNotFoundException(techId);
    t.setAvailable(available);
    this.users.save(t);
    const r = available ? { moved: 0, kept: 0 } : this.incidents.releaseWorkOf(actor, t, `${t.name} is away`);
    return { user: t, ...r };
  }

  // ======================= IT services =======================
  addService(actor: User, data: { id: string; name: string; criticality: Level; userBase: number }): ITService {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "add IT services");
    const id = String(data.id ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9-]{1,19}$/.test(id)) throw new InvalidInputException("Service ID must be 2–20 letters, digits or dashes, e.g. SVC-HR");
    if (this.services.findById(id)) throw new InvalidInputException(`Service ${id} already exists`);
    return this.services.save(new ITService(id, String(data.name ?? "").trim(), data.criticality, data.userBase));
  }

  /** Changing criticality re-prioritises the service's open incidents, because priority depends on it. */
  updateService(actor: User, serviceId: string, c: { name?: string; userBase?: number; criticality?: Level; active?: boolean }): { service: ITService; reprioritised: number } {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "change IT services");
    const s = this.services.findById(serviceId);
    if (!s) throw new ServiceNotFoundException(serviceId);
    ITService.validate(c.name ?? s.name, c.criticality ?? s.criticality, c.userBase ?? s.userBase); // before touching anything
    const criticalityChanged = c.criticality !== undefined && c.criticality !== s.criticality;
    if (c.name !== undefined || c.userBase !== undefined) s.update(c.name ?? s.name, c.userBase ?? s.userBase);
    if (criticalityChanged) s.setCriticality(c.criticality!);
    if (c.active !== undefined) s.setActive(c.active);
    this.services.save(s);
    return { service: s, reprioritised: criticalityChanged ? this.incidents.reprioritiseOpenIncidents(actor, s.id) : 0 };
  }

  // ======================= categories =======================
  /** New categories need no code change: they are data, and the categorizer picks them up immediately. */
  addCategory(actor: User, name: string, keywords: string[]): Category {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "add categories");
    const c = new Category(name, keywords);
    if (this.categories.findById(c.name)) throw new InvalidInputException(`Category ${c.name} already exists`);
    return this.categories.save(c);
  }

  setCategoryKeywords(actor: User, name: string, keywords: string[]): Category {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "edit categories");
    const c = this.category(name);
    c.setKeywords(keywords);
    return this.categories.save(c);
  }

  /** Existing incidents keep the category name they were filed under; it just stops being offered. */
  removeCategory(actor: User, name: string): void {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "remove categories");
    const c = this.category(name);
    if (this.categories.count() <= 1) throw new InvalidInputException("At least one category must remain");
    this.categories.delete(c.id);
  }

  // ======================= SLA =======================
  configureSla(actor: User, priority: Priority, responseMinutes: number, resolutionMinutes: number): SLAPolicy {
    if (!Object.values(Priority).includes(priority)) throw new InvalidInputException(`Unknown priority ${priority}`);
    const policy = new SLAPolicy(priority, responseMinutes, resolutionMinutes);
    this.sla.configure(actor, policy);
    return policy;
  }

  // ======================= helpers =======================
  private user(id: string): User {
    const u = this.users.findById(id);
    if (!u) throw new UserNotFoundException(id);
    return u;
  }

  private category(name: string): Category {
    const c = this.categories.findById(String(name).toUpperCase());
    if (!c) throw new InvalidInputException(`Unknown category ${name}`);
    return c;
  }

  /** Skills are category names, so a technician can only hold skills the classifier can actually produce. */
  private knownSkills(skills: string[]): string[] {
    const out = [...new Set(skills.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    const unknown = out.filter((s) => !this.categories.findById(s));
    if (unknown.length) throw new InvalidInputException(`Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Skills must be category names.`);
    return out;
  }

  private guard(actor: User, p: Permission, action: string): void {
    if (!actor.can(p)) throw new UnauthorizedOperationException(actor.name, action);
  }
}
