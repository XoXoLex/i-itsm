import { Category } from "../domain/catalog";
import { Incident } from "../domain/Incident";

const STOPWORDS = new Set(
  "a an the is are was were be to of and or in on at for with my our we i it this that not unable cannot can't cant from by as".split(" "),
);

/** Lowercase, strip punctuation, drop stopwords, crude stemming. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

// ---------------------------------------------------------------------------
// Intelligent feature 1: automatic categorization (Strategy: keyword now, LLM later)
// ---------------------------------------------------------------------------
export interface CategorySuggestion {
  category: string;
  confidence: number; // 0–1
  source?: string;    // which engine produced it
}

/** STRATEGY: keyword matching now, an LLM-backed implementation can be swapped in. */
export interface Categorizer {
  readonly name: string;
  suggest(title: string, description: string, categories: Category[]): Promise<CategorySuggestion>;
}

export class KeywordCategorizer implements Categorizer {
  readonly name = "KEYWORD";

  async suggest(title: string, description: string, categories: Category[]): Promise<CategorySuggestion> {
    return this.suggestSync(title, description, categories);
  }

  suggestSync(title: string, description: string, categories: Category[]): CategorySuggestion {
    // Each distinct word counts once per field, in both its plain and stemmed form; a hit in the title counts double.
    const words = (text: string) => [...new Set([...text.toLowerCase().split(/\W+/).filter(Boolean), ...tokenize(text)])];
    const inTitle = words(title);
    const inDescription = words(description);
    let best = { category: "", hits: 0 };
    let total = 0;
    for (const c of categories) {
      const hits = 2 * c.keywordHits(inTitle) + c.keywordHits(inDescription);
      total += hits;
      if (hits > best.hits) best = { category: c.name, hits };
    }
    // No keyword matched at all: say so (confidence 0) and let the caller choose its fallback category.
    return { category: best.category, confidence: total === 0 ? 0 : best.hits / total, source: this.name };
  }
}

// ---------------------------------------------------------------------------
// Intelligent feature 2: duplicate / related incident detection
// ---------------------------------------------------------------------------
export interface DuplicateMatch {
  incident: Incident;
  similarity: number;
}

export class DuplicateDetector {
  constructor(private readonly threshold = 0.3, private readonly windowHours = 24) {}

  findDuplicates(candidate: Incident, existing: Incident[]): DuplicateMatch[] {
    const mine = new Set(tokenize(`${candidate.title} ${candidate.description}`));
    const cutoff = candidate.createdAt.getTime() - this.windowHours * 3_600_000;

    return existing
      .filter((o) => o.id !== candidate.id && o.isOpen && o.createdAt.getTime() >= cutoff)
      .map((o) => {
        let sim = jaccard(mine, new Set(tokenize(`${o.title} ${o.description}`)));
        if (o.service.id === candidate.service.id) sim += 0.2; // same service = strong signal
        return { incident: o, similarity: Math.min(sim, 1) };
      })
      .filter((m) => m.similarity >= this.threshold)
      .sort((a, b) => b.similarity - a.similarity);
  }
}

// ---------------------------------------------------------------------------
// Intelligent feature 3: suggested resolution from similar past incidents
// ---------------------------------------------------------------------------
export class ResolutionSuggester {
  suggest(incident: Incident, history: Incident[], limit = 3): { from: string; resolution: string; similarity: number }[] {
    const mine = new Set(tokenize(`${incident.title} ${incident.description}`));
    return history
      .filter((h) => h.id !== incident.id && h.resolution)
      .map((h) => ({
        from: h.id,
        resolution: h.resolution!,
        similarity: jaccard(mine, new Set(tokenize(`${h.title} ${h.description}`))) + (h.category === incident.category ? 0.1 : 0),
      }))
      .filter((s) => s.similarity > 0.15)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}
