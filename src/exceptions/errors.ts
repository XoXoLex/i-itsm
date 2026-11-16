/**
 * Custom exception hierarchy. Every domain error extends ItsmError so the API
 * layer can catch one base type and map it to an HTTP status code.
 */
export abstract class ItsmError extends Error {
  abstract readonly httpStatus: number;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidLoginException extends ItsmError {
  readonly httpStatus = 401;
  constructor() { super("Invalid email or password"); }
}

export class AuthenticationRequiredException extends ItsmError {
  readonly httpStatus = 401;
  constructor(reason = "Please log in") { super(reason); }
}

export class UnauthorizedOperationException extends ItsmError {
  readonly httpStatus = 403;
  constructor(userName: string, action: string) {
    super(`${userName} is not allowed to ${action}`);
  }
}

export class InvalidInputException extends ItsmError {
  readonly httpStatus = 400;
}

export class InvalidStateTransitionException extends ItsmError {
  readonly httpStatus = 409;
  constructor(from: string, action: string) {
    super(`Cannot ${action} an incident in state ${from}`);
  }
}

export class IncidentNotFoundException extends ItsmError {
  readonly httpStatus = 404;
  constructor(id: string) { super(`Incident ${id} not found`); }
}

export class ServiceNotFoundException extends ItsmError {
  readonly httpStatus = 404;
  constructor(id: string) { super(`IT service ${id} not found`); }
}

export class UserNotFoundException extends ItsmError {
  readonly httpStatus = 404;
  constructor(id: string) { super(`User ${id} not found`); }
}

export class DuplicateUserException extends ItsmError {
  readonly httpStatus = 409;
  constructor(email: string) { super(`A user with email ${email} already exists`); }
}

export class TechnicianUnavailableException extends ItsmError {
  readonly httpStatus = 409;
  constructor(reason: string) { super(`No technician available: ${reason}`); }
}

export class TechnicianWorkloadExceededException extends ItsmError {
  readonly httpStatus = 409;
  constructor(name: string, max: number) {
    super(`Technician ${name} already has the maximum of ${max} active incidents`);
  }
}

export class MissingSLAConfigurationException extends ItsmError {
  readonly httpStatus = 500;
  constructor(priority: string) { super(`No SLA policy configured for ${priority}`); }
}

export class PersistenceException extends ItsmError {
  readonly httpStatus = 503;
}
