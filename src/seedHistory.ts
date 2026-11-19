import { Level } from "./domain/enums";
import { FakeClock } from "./services/Clock";
import { ItsmSystem, seed } from "./system";

type T = [title: string, description: string, svc: string, impact: Level, urgency: Level, users: number, resolution: string];

const HISTORY: T[] = [
  ["Payment checkout returning 500", "Customers get error 500 on the payment checkout page", "SVC-PAY", 4, 4, 200, "Rolled back payment service release 4.2 that broke the checkout endpoint"],
  ["Cannot login with SSO", "SSO login page loops back after entering password", "SVC-SSO", 4, 3, 400, "Renewed expired SAML signing certificate on the identity provider"],
  ["VPN connection drops every few minutes", "VPN disconnects repeatedly when working from home", "SVC-VPN", 3, 3, 60, "Increased VPN gateway keep-alive timeout and restarted the concentrator"],
  ["Outlook not syncing email", "New mail not arriving in Outlook desktop since morning", "SVC-MAIL", 2, 3, 30, "Rebuilt the Outlook profile and cleared the OST cache"],
  ["Customer database queries very slow", "CRM screens time out, database query latency above 10 seconds", "SVC-DB", 4, 3, 120, "Added missing index on orders.customer_id and killed a runaway report query"],
  ["Printer on floor 3 jammed", "Printer shows paper jam error and will not print", "SVC-PRINT", 1, 2, 8, "Cleared paper jam and replaced worn pickup roller"],
  ["File upload to cloud storage failing", "Uploading files to shared drive fails with quota exceeded", "SVC-CLOUD", 2, 2, 25, "Increased department storage quota and archived old backups"],
  ["Payment transactions declined for all cards", "All card transactions being declined by payment gateway", "SVC-PAY", 4, 4, 350, "Gateway API key had been rotated; updated the key in the payment service config"],
  ["Password reset email not received", "Users requesting password reset do not get the email", "SVC-SSO", 2, 3, 15, "Whitelisted the identity provider sender address in the mail relay"],
  ["Email bouncing for external recipients", "Emails to external domains bounce with SPF failure", "SVC-MAIL", 3, 3, 100, "Corrected the SPF DNS record after the mail provider migration"],
  ["Database replica out of sync", "Read replica lagging behind primary by over an hour", "SVC-DB", 3, 2, 40, "Re-seeded the read replica from a fresh snapshot"],
  ["VPN authentication failing", "VPN client says authentication failed with correct password", "SVC-VPN", 3, 4, 80, "Re-synced VPN RADIUS server with the directory after password policy change"],
  ["Shared drive files missing", "Files deleted from shared cloud drive folder", "SVC-CLOUD", 3, 3, 12, "Restored folder from the 24-hour storage backup snapshot"],
  ["Payment page slow to load", "Payment page takes over 15 seconds to load", "SVC-PAY", 3, 3, 150, "Scaled payment frontend from 2 to 6 instances and enabled CDN caching"],
  ["MFA codes not accepted", "OTP codes from authenticator app rejected at login", "SVC-SSO", 3, 4, 90, "Fixed NTP drift on the authentication servers; OTP time window was off"],
  ["Printer not visible on network", "Office printer not found when adding printer", "SVC-PRINT", 1, 1, 5, "Assigned the printer a static IP and re-registered it in DNS"],
  ["Calendar invites not sending", "Meeting invites stuck in outbox", "SVC-MAIL", 2, 2, 20, "Restarted the mail transport service that had stalled"],
  ["Database deadlock errors in orders", "Order screen shows deadlock detected error intermittently", "SVC-DB", 3, 3, 50, "Changed order update transaction to lock rows in a consistent order"],
];

/**
 * Generates ~10 days of realistic history (resolved incidents, some SLA breaches, feedback),
 * plus a few currently open incidents, so dashboards and resolution suggestions have data.
 */
export async function seedWithHistory(sys: ItsmSystem, clock: FakeClock, realNow = new Date()): Promise<void> {
  const d = seed(sys);
  const S = sys.incidentService;
  const emps = Object.values(d.employees);
  const admin = d.admin;

  for (let k = 0; k < HISTORY.length; k++) {
    const [title, description, serviceId, impact, urgency, affectedUsers, resolution] = HISTORY[k];
    clock.advanceMinutes(420 + (k % 4) * 60); // spread over ~9 days
    const { incident } = await S.report(emps[k % emps.length], { title, description, serviceId, impact, urgency, affectedUsers });
    if (!incident.assignee) continue;

    const breach = k % 5 === 2; // every 5th incident blows its SLA
    clock.advanceMinutes(breach ? 40 : 3 + (k % 4));
    sys.sla.checkAll(); // a breached incident may be escalated and handed to another technician here
    const tech = incident.assignee;
    S.acknowledge(tech, incident.id);
    S.startWork(tech, incident.id);
    S.addInvestigationNote(tech, incident.id, "Checked service logs and recent changes");
    const window = incident.sla ? (incident.sla.resolveBy.getTime() - incident.createdAt.getTime()) / 60_000 : 60;
    clock.advanceMinutes(breach ? window + 20 : Math.max(5, Math.round(window * 0.4)));
    sys.sla.checkAll();
    S.resolve(tech, incident.id, resolution);
    if (k % 6 !== 5) {
      S.verify(incident.reporter, incident.id);
      S.close(admin, incident.id);
    }
    if (k % 3 !== 1) S.feedback(incident.reporter, incident.id, breach ? 3 : 4 + (k % 2), breach ? "Took longer than expected" : "Quick fix, thanks");
  }

  // currently open work, created within the last couple of hours of real time
  clock.jumpTo(new Date(realNow.getTime() - 2 * 3_600_000));
  const vpn = (await S.report(d.employees.e2, {
    title: "VPN very slow from Hyderabad office", description: "VPN latency high, file transfers crawling over the network",
    serviceId: "SVC-VPN", impact: Level.MEDIUM, urgency: Level.MEDIUM, affectedUsers: 20,
  })).incident;
  if (vpn.assignee) {
    S.acknowledge(vpn.assignee, vpn.id);
    S.startWork(vpn.assignee, vpn.id);
    S.requestInfo(vpn.assignee, vpn.id, "Which VPN server region are you connected to?");
  }
  clock.advanceMinutes(30);
  await S.report(d.employees.e3, {
    title: "Laptop battery not charging", description: "Laptop hardware battery stuck at 0 percent even when plugged in",
    serviceId: "SVC-DEVICE", impact: Level.LOW, urgency: Level.LOW, affectedUsers: 1,
  });
}
