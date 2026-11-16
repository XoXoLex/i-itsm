import { Admin, Employee, PasswordHash, Technician, User } from "../domain/users";
import { Permission } from "../domain/enums";
import {
  DuplicateUserException,
  InvalidInputException,
  InvalidLoginException,
  UnauthorizedOperationException,
  UserNotFoundException,
} from "../exceptions/errors";
import { IdGenerator, Repository } from "../repositories/Repository";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthService {
  private readonly empIds = new IdGenerator("E", 101);
  private readonly techIds = new IdGenerator("T", 201);
  private readonly adminIds = new IdGenerator("A", 1);

  constructor(private readonly users: Repository<User>) {
    const ids = users.findAll().map((u) => u.id);
    [this.empIds, this.techIds, this.adminIds].forEach((g) => g.resumeAfter(ids));
  }

  /** Self-registration is only for employees. */
  registerEmployee(name: string, email: string, password: string, department: string): Employee {
    this.validate(name, email, password);
    return this.users.save(new Employee(this.empIds.generate(), name, email, PasswordHash.fromPlain(password), department)) as Employee;
  }

  /** FACTORY-style creation of staff accounts; admin only. */
  createStaff(
    actor: User,
    kind: "TECHNICIAN" | "ADMIN",
    data: { name: string; email: string; password: string; skills?: string[]; experienceYears?: number; maxActive?: number },
  ): User {
    if (!actor.can(Permission.MANAGE_USERS)) throw new UnauthorizedOperationException(actor.name, "create staff accounts");
    this.validate(data.name, data.email, data.password);
    const pw = PasswordHash.fromPlain(data.password);
    const user =
      kind === "TECHNICIAN"
        ? new Technician(this.techIds.generate(), data.name, data.email, pw, data.skills ?? [], data.experienceYears ?? 0, data.maxActive ?? 5)
        : new Admin(this.adminIds.generate(), data.name, data.email, pw);
    return this.users.save(user);
  }

  /** Used only for seeding the very first admin. */
  bootstrapAdmin(name: string, email: string, password: string): Admin {
    this.validate(name, email, password);
    return this.users.save(new Admin(this.adminIds.generate(), name, email, PasswordHash.fromPlain(password))) as Admin;
  }

  login(email: string, password: string): User {
    const user = this.users.findAll().find((u) => u.email.toLowerCase() === email.toLowerCase());
    // Same error for unknown email and wrong password: don't leak which accounts exist.
    if (!user || !user.checkPassword(password)) throw new InvalidLoginException();
    return user;
  }

  getUser(id: string): User {
    const u = this.users.findById(id);
    if (!u) throw new UserNotFoundException(id);
    return u;
  }

  private validate(name: string, email: string, password: string): void {
    if (!name?.trim()) throw new InvalidInputException("Name is required");
    if (!EMAIL_RE.test(email)) throw new InvalidInputException(`Invalid email: ${email}`);
    if (!password || password.length < 8) throw new InvalidInputException("Password must be at least 8 characters");
    if (this.users.findAll().some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new DuplicateUserException(email);
  }
}
