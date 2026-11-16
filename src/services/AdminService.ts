import { Category, ITService, SLAPolicy } from "../domain/catalog";
import { Level, Permission, Priority } from "../domain/enums";
import { Technician, User } from "../domain/users";
import { InvalidInputException, UnauthorizedOperationException, UserNotFoundException } from "../exceptions/errors";
import { Repository } from "../repositories/Repository";
import { SLAService } from "./SLAService";

/** Administrator configuration: services, categories, SLA policies, technician availability. */
export class AdminService {
  constructor(
    private readonly users: Repository<User>,
    private readonly services: Repository<ITService>,
    private readonly categories: Repository<Category>,
    private readonly sla: SLAService,
  ) {}

  listUsers(actor: User): User[] {
    this.guard(actor, Permission.MANAGE_USERS, "list users");
    return this.users.findAll().sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  setTechnicianAvailability(actor: User, techId: string, available: boolean): Technician {
    this.guard(actor, Permission.MANAGE_USERS, "change technician availability");
    const t = this.users.findById(techId);
    if (!(t instanceof Technician)) throw new UserNotFoundException(techId);
    t.setAvailable(available);
    this.users.save(t);
    return t;
  }

  addService(actor: User, data: { id: string; name: string; criticality: Level; userBase: number }): ITService {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "add IT services");
    const id = data.id?.trim().toUpperCase();
    if (!id || !data.name?.trim()) throw new InvalidInputException("Service id and name are required");
    if (this.services.findById(id)) throw new InvalidInputException(`Service ${id} already exists`);
    if (!(data.criticality >= 1 && data.criticality <= 4)) throw new InvalidInputException("Criticality must be 1–4");
    if (!(data.userBase > 0)) throw new InvalidInputException("User base must be positive");
    return this.services.save(new ITService(id, data.name.trim(), data.criticality, data.userBase));
  }

  setServiceCriticality(actor: User, serviceId: string, level: Level): ITService {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "change service criticality");
    const s = this.services.findById(serviceId);
    if (!s) throw new InvalidInputException(`Unknown service ${serviceId}`);
    if (!(level >= 1 && level <= 4)) throw new InvalidInputException("Criticality must be 1–4");
    s.setCriticality(level);
    return this.services.save(s);
  }

  /** New categories need no code change: they are data, and the categorizer picks them up immediately. */
  addCategory(actor: User, name: string, keywords: string[]): Category {
    this.guard(actor, Permission.CONFIGURE_SYSTEM, "add categories");
    const c = new Category(name, keywords.filter((k) => k.trim()));
    if (this.categories.findById(c.name)) throw new InvalidInputException(`Category ${c.name} already exists`);
    return this.categories.save(c);
  }

  configureSla(actor: User, priority: Priority, responseMinutes: number, resolutionMinutes: number): SLAPolicy {
    if (!Object.values(Priority).includes(priority)) throw new InvalidInputException(`Unknown priority ${priority}`);
    const policy = new SLAPolicy(priority, responseMinutes, resolutionMinutes);
    this.sla.configure(actor, policy);
    return policy;
  }

  private guard(actor: User, p: Permission, action: string): void {
    if (!actor.can(p)) throw new UnauthorizedOperationException(actor.name, action);
  }
}
