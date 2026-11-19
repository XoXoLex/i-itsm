import { Admin, EMAIL_RE, Employee, PasswordHash, Technician, User } from "../domain/users";
import { Permission } from "../domain/enums";
import {
  AccountDisabledException,
  AuthenticationRequiredException,
  DuplicateUserException,
  InvalidInputException,
  InvalidLoginException,
  TooManyAttemptsException,
  UnauthorizedOperationException,
  UserNotFoundException,
} from "../exceptions/errors";
import { IdGenerator, Repository } from "../repositories/Repository";
import { Clock, SystemClock } from "./Clock";

/**
 * Brute-force protection: five failed logins for one account from one address lock that
 * pair out for five minutes. Keying on the address as well means someone guessing
 * passwords from elsewhere cannot lock the real owner out.
 */
export class LoginGuard {
  private readonly fails = new Map<string, number[]>();

  constructor(private readonly clock: Clock = new SystemClock(), private readonly limit = 5, private readonly windowMinutes = 5) {}

  check(email: string, address: string): void {
    const key = this.key(email, address);
    const now = this.clock.now().getTime();
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMinutes * 60_000);
    if (recent.length) this.fails.set(key, recent); else this.fails.delete(key);
    if (recent.length >= this.limit) {
      throw new TooManyAttemptsException(Math.max(1, Math.ceil((recent[0] + this.windowMinutes * 60_000 - now) / 60_000)));
    }
  }

  failed(email: string, address: string): void {
    const key = this.key(email, address);
    this.fails.set(key, [...(this.fails.get(key) ?? []), this.clock.now().getTime()]);
  }

  succeeded(email: string, address: string): void {
    this.fails.delete(this.key(email, address));
  }

  private key(email: string, address: string): string {
    return `${email.toLowerCase()}|${address}`;
  }
}

export class AuthService {
  private readonly empIds = new IdGenerator("E", 101);
  private readonly techIds = new IdGenerator("T", 201);
  private readonly adminIds = new IdGenerator("A", 1);

  constructor(private readonly users: Repository<User>, private readonly guard: LoginGuard = new LoginGuard()) {
    const ids = users.findAll().map((u) => u.id);
    [this.empIds, this.techIds, this.adminIds].forEach((g) => g.resumeAfter(ids));
  }

  /** Self-registration is only for employees. */
  registerEmployee(name: string, email: string, password: string, department: string): Employee {
    this.validate(name, email, password);
    return this.users.save(new Employee(this.empIds.generate(), name.trim(), email.trim(), PasswordHash.fromPlain(password), String(department ?? "").trim())) as Employee;
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
    // Build first (the constructor validates), then take the ID, so a rejected request does not burn a number.
    const user =
      kind === "TECHNICIAN"
        ? new Technician(this.techIds.peek(), data.name.trim(), data.email.trim(), pw, data.skills ?? [], data.experienceYears ?? 0, data.maxActive ?? 5)
        : new Admin(this.adminIds.peek(), data.name.trim(), data.email.trim(), pw);
    (kind === "TECHNICIAN" ? this.techIds : this.adminIds).generate();
    return this.users.save(user);
  }

  /** Used only for seeding the very first admin. */
  bootstrapAdmin(name: string, email: string, password: string): Admin {
    this.validate(name, email, password);
    return this.users.save(new Admin(this.adminIds.generate(), name, email, PasswordHash.fromPlain(password))) as Admin;
  }

  /** `address` identifies where the attempt came from (the client IP), for the lockout rule. */
  login(email: string, password: string, address = "local"): User {
    this.guard.check(email, address);
    const user = this.users.findAll().find((u) => u.email.toLowerCase() === String(email).toLowerCase());
    // Same error for unknown email and wrong password: don't leak which accounts exist.
    if (!user || !user.checkPassword(String(password))) {
      this.guard.failed(email, address);
      throw new InvalidLoginException();
    }
    this.guard.succeeded(email, address);
    if (!user.active) throw new AccountDisabledException();
    return user;
  }

  /** Resolves the user behind a session token; a deactivated or deleted account ends the session. */
  getUser(id: string): User {
    const u = this.users.findById(id);
    if (!u || !u.active) throw new AuthenticationRequiredException("Session expired or invalid, please log in again");
    return u;
  }

  changeOwnPassword(actor: User, current: string, next: string): void {
    if (!actor.checkPassword(String(current))) throw new InvalidInputException("Current password is wrong");
    actor.changePassword(next);
    this.users.save(actor);
  }

  /** Administrator sets a new temporary password for someone who is locked out. */
  resetPassword(actor: User, userId: string, next: string): User {
    if (!actor.can(Permission.MANAGE_USERS)) throw new UnauthorizedOperationException(actor.name, "reset passwords");
    const u = this.find(userId);
    u.changePassword(next);
    return this.users.save(u);
  }

  /** Name and email, for any kind of user; role-specific fields are handled by AdminService. */
  updateIdentity(actor: User, userId: string, name: string, email: string): User {
    if (!actor.can(Permission.MANAGE_USERS)) throw new UnauthorizedOperationException(actor.name, "edit users");
    const u = this.find(userId);
    if (email.toLowerCase() !== u.email.toLowerCase() && this.emailTaken(email)) throw new DuplicateUserException(email);
    if (!name?.trim()) throw new InvalidInputException("Name cannot be empty");
    if (!EMAIL_RE.test(email)) throw new InvalidInputException(`Invalid email: ${email}`);
    u.rename(name);
    u.changeEmail(email);
    return u;
  }

  private find(id: string): User {
    const u = this.users.findById(id);
    if (!u) throw new UserNotFoundException(id);
    return u;
  }

  private emailTaken(email: string): boolean {
    return this.users.findAll().some((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  private validate(name: string, email: string, password: string): void {
    if (typeof name !== "string" || !name.trim()) throw new InvalidInputException("Name is required");
    if (name.trim().length > 80) throw new InvalidInputException("Name must be at most 80 characters");
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) throw new InvalidInputException(`Invalid email: ${email}`);
    if (typeof password !== "string" || password.length < 8) throw new InvalidInputException("Password must be at least 8 characters");
    if (password.length > 200) throw new InvalidInputException("Password must be at most 200 characters");
    if (this.emailTaken(email.trim())) throw new DuplicateUserException(email);
  }
}
