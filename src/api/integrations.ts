import type { Response } from "express";
import { Category } from "../domain/catalog";
import { IncidentEvent, IncidentObserver } from "../events/EventBus";
import { Categorizer, CategorySuggestion } from "../intelligence/intelligence";
import { Notification, NotificationChannel } from "../notifications/channels";

/**
 * ADAPTER around Google's Gemini REST API, exposed as our own Categorizer interface.
 * Any failure (no key, network, bad JSON, unknown category) falls back to the keyword categorizer,
 * so the reporting flow never breaks because of the AI service.
 */
export class GeminiCategorizer implements Categorizer {
  readonly name = "GEMINI";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fallback: Categorizer,
    private readonly timeoutMs = 6000,
    private readonly http: typeof fetch = fetch,
  ) {}

  async suggest(title: string, description: string, categories: Category[]): Promise<CategorySuggestion> {
    const names = categories.map((c) => c.name);
    const prompt =
      `You classify IT incidents for a service desk.\n` +
      `Allowed categories: ${names.join(", ")}.\n` +
      `Incident title: ${title}\nIncident description: ${description}\n` +
      `Reply with JSON only: {"category": one of the allowed categories, "confidence": number between 0 and 1}`;
    try {
      const res = await this.http(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { category?: string; confidence?: number };
      const category = String(parsed.category ?? "").toUpperCase();
      if (!names.includes(category)) throw new Error(`model returned unknown category "${category}"`);
      return { category, confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7))), source: `GEMINI (${this.model})` };
    } catch (e) {
      console.warn(`[Gemini] falling back to keywords: ${(e as Error).message}`);
      const s = await this.fallback.suggest(title, description, categories);
      return { ...s, source: `${s.source} (Gemini unavailable)` };
    }
  }
}

/**
 * ADAPTER around Google's Gemini Decisions API (gemini-decision-1, released 11 Nov 2026).
 * Purpose-built for closed-set choices: it scores every category in one pass and returns
 * the winner with a calibrated confidence, so there is no free text to parse.
 * POST https://generativelanguage.googleapis.com/v1beta/decisions
 */
export class GeminiDecisionCategorizer implements Categorizer {
  readonly name = "GEMINI_DECISIONS";

  constructor(
    private readonly apiKey: string,
    private readonly fallback: Categorizer,
    private readonly model = "gemini-decision-1",
    private readonly timeoutMs = 5000,
    private readonly http: typeof fetch = fetch,
  ) {}

  async suggest(title: string, description: string, categories: Category[]): Promise<CategorySuggestion> {
    const criteria = Object.fromEntries(
      categories.map((c) => [c.name, `IT problems about ${c.name.toLowerCase()}, e.g. ${c.keywordList.slice(0, 8).join(", ")}`]),
    );
    try {
      const res = await this.http("https://generativelanguage.googleapis.com/v1beta/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          model: this.model,
          input: `Incident title: ${title}\nIncident description: ${description}`,
          questions: {
            category: {
              type: "choice",
              instructions: "Which IT support category does this incident report belong to?",
              criteria,
            },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { answers?: { category?: { choice?: string; confidence?: number } } };
      const answer = body.answers?.category;
      const category = String(answer?.choice ?? "").toUpperCase();
      if (!criteria[category]) throw new Error(`unexpected choice "${answer?.choice}"`);
      return { category, confidence: Number(answer?.confidence ?? 0), source: `GEMINI_DECISIONS (${this.model})` };
    } catch (e) {
      console.warn(`[Gemini Decisions] falling back: ${(e as Error).message}`);
      const s = await this.fallback.suggest(title, description, categories);
      return { ...s, source: `${s.source} (Gemini unavailable)` };
    }
  }
}

/**
 * Real-time push over Server-Sent Events. It is just another NotificationChannel
 * (third mechanism, alongside in-app inbox and email): no other class had to change to add it.
 */
export class LiveChannel implements NotificationChannel, IncidentObserver {
  readonly name = "LIVE_PUSH";
  private readonly clients = new Map<string, Set<Response>>();

  connect(userId: string, res: Response): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: hello\ndata: {}\n\n`);
    const set = this.clients.get(userId) ?? new Set();
    set.add(res);
    this.clients.set(userId, set);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      set.delete(res);
    });
  }

  /** Personal notification to one user. */
  send(n: Notification): void {
    this.write(n.recipient.id, "notification", { subject: n.subject, body: n.body, incidentId: n.incidentId, at: n.at });
  }

  /** Observer: tell every open dashboard that an incident changed, so it refreshes. */
  onEvent(e: IncidentEvent): void {
    for (const userId of this.clients.keys()) this.write(userId, "incident", { id: e.incident.id, type: e.type, status: e.incident.status });
  }

  private write(userId: string, event: string, data: unknown): void {
    for (const res of this.clients.get(userId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
