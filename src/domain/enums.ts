export enum Role {
  EMPLOYEE = "EMPLOYEE",
  TECHNICIAN = "TECHNICIAN",
  ADMIN = "ADMIN",
}

/** Shared 1–4 scale used for impact, urgency and business criticality. */
export enum Level {
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  CRITICAL = 4,
}

export enum Priority {
  P1 = "P1", // Critical
  P2 = "P2", // High
  P3 = "P3", // Medium
  P4 = "P4", // Low
}

export enum IncidentStatus {
  NEW = "NEW",
  CLASSIFIED = "CLASSIFIED",
  ASSIGNED = "ASSIGNED",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  IN_PROGRESS = "IN_PROGRESS",
  PENDING_INFO = "PENDING_INFO",
  RESOLVED = "RESOLVED",
  VERIFIED = "VERIFIED",
  CLOSED = "CLOSED",
}

export enum SLAStatus {
  ON_TRACK = "ON_TRACK",
  AT_RISK = "AT_RISK",
  BREACHED = "BREACHED",
  MET = "MET",
}

export enum Permission {
  REPORT_INCIDENT = "REPORT_INCIDENT",
  VIEW_OWN_INCIDENTS = "VIEW_OWN_INCIDENTS",
  VIEW_ALL_INCIDENTS = "VIEW_ALL_INCIDENTS",
  ADD_INFO = "ADD_INFO",
  VERIFY_RESOLUTION = "VERIFY_RESOLUTION",
  GIVE_FEEDBACK = "GIVE_FEEDBACK",
  WORK_ON_INCIDENT = "WORK_ON_INCIDENT", // acknowledge, notes, status, resolve
  ASSIGN_INCIDENT = "ASSIGN_INCIDENT",
  CLOSE_INCIDENT = "CLOSE_INCIDENT",
  MANAGE_USERS = "MANAGE_USERS",
  CONFIGURE_SYSTEM = "CONFIGURE_SYSTEM", // services, SLAs, categories, strategies
  VIEW_AUDIT = "VIEW_AUDIT",
  VIEW_REPORTS = "VIEW_REPORTS",
}
