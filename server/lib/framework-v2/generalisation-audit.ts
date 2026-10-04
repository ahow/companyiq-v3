/**
 * STEP 1 — Generalisation audit (Detector D3).
 *
 * Faithful TypeScript port of
 * `skills/framework-review/scripts/generalisation_audit.py`.
 *
 * Scans the builder prompt (a topic-agnostic generator) for topic- or
 * company-specific design elements that would be COPIED INTO every framework it
 * produces, while NOT flagging clearly-labelled illustrative examples.
 *
 * The precision-critical distinction:
 *  - LABELLED EXAMPLE position (after "e.g.", "Examples:", "for '…' →",
 *    "such as", "common alternative", "inspired") → topic tokens are FINE.
 *  - COPY-RISK position (inside the Part>=5 OUTPUT schema field values, or inside
 *    a Part 3/4 construction-rule's normative text) → topic tokens LEAK into
 *    output and should be generalised to a placeholder.
 *
 * Deterministic lexical pass only (the reproducible, model-free floor). A
 * semantic LLM pass is layered on top in builder-improve.ts (STEP 2).
 */

export type AuditPosition = "output-schema-default" | "construction-rule";

export interface AuditFinding {
  line: number;
  token: string;
  position: AuditPosition;
  excerpt: string;
  proposedFix: string;
}

export interface GeneralisationAuditReport {
  findings: AuditFinding[];
  counts: Record<string, number>;
  totalLines: number;
}

// Seed lexicon of ESG/topic domain terms (lowercase substring match). Extensible;
// the semantic pass catches anything the seed misses. Mirrors TOPIC_TERMS in the PoC.
const TOPIC_TERMS = [
  "biodivers", "nature", "ecosystem", "natural capital", "water", "climate",
  "emission", "scope 1", "scope 2", "scope 3", "net zero", "net-zero",
  "modern slavery", "deforestation", "pollution", "carbon",
];

// Domain standard/acronym pattern (3-6 caps, optional trailing digit): TNFD, SBTN,
// GBF, IPBES, ENCORE, LEAP, PBAF, TCFD, GRI, CSRD, ESRS, SBTN...
const ACRONYM_RE = /\b[A-Z]{3,6}\d?\b/g;

// Builder-infrastructure acronyms that are NOT topic-specific (allow-list).
const INFRA_ACRONYMS = new Set([
  "JSON", "LLM", "BM25", "URL", "ESG", "PDF", "ACWI", "MSCI", "FTSE",
  "STOXX", "GPT", "YES", "NOT", "AND", "BEGIN", "END", "ID",
  // common English words that the caps heuristic would otherwise mis-flag
  "ALL", "EVERY", "NEVER", "ONLY", "BUT", "FOR", "THE", "OR", "NO",
  "MUST", "WOULD", "LOOK", "INCLUDE", "DO",
]);

const LABELLED_EXAMPLE_MARKERS =
  /(e\.g\.|example|examples:|such as|for "|\u2192|->|common alternative|inspired)/i;

type BlockTag = "schema" | "codeblock" | "rule" | "prose" | "fence-delim";

/**
 * Tag each line: 'schema' (inside a Part>=5 ```json/``` output template),
 * 'codeblock' (a fenced block outside the output section), 'rule' (Part 3/4
 * normative construction text), or 'prose'. Faithful port of classify_blocks().
 */
export function classifyBlocks(lines: string[]): BlockTag[] {
  const tags: BlockTag[] = [];
  let inFence = false;
  let part = 0;
  for (const ln of lines) {
    const m = /^# Part (\d)/.exec(ln);
    if (m) part = parseInt(m[1], 10);
    if (ln.trim().startsWith("```")) {
      inFence = !inFence;
      tags.push("fence-delim");
      continue;
    }
    if (inFence && part >= 5) {
      tags.push("schema"); // output template -> copied verbatim
    } else if (inFence) {
      tags.push("codeblock");
    } else if (part === 3 || part === 4) {
      tags.push("rule"); // normative rule text -> applied to every measure
    } else {
      tags.push("prose");
    }
  }
  return tags;
}

/** Audit the builder prompt text. Pure function; faithful port of audit(). */
export function auditGeneralisation(builderText: string): GeneralisationAuditReport {
  const lines = builderText.split(/\r?\n/);
  const tags = classifyBlocks(lines);
  const findings: AuditFinding[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    const tag = tags[idx];
    const lineNo = idx + 1; // 1-based, matches the PoC's enumerate(start=1)
    if (tag === "prose" || tag === "codeblock" || tag === "fence-delim") {
      continue; // prose examples & non-output code are allowed to be topical
    }
    const labelled = LABELLED_EXAMPLE_MARKERS.test(ln);
    if (labelled && tag === "rule") {
      continue; // a rule line that is explicitly giving an example is fine
    }
    const hits = new Set<string>();
    const low = ln.toLowerCase();
    for (const t of TOPIC_TERMS) {
      if (low.includes(t)) hits.add(t);
    }
    ACRONYM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ACRONYM_RE.exec(ln)) !== null) {
      const tok = m[0];
      if (!INFRA_ACRONYMS.has(tok)) hits.add(tok);
    }
    // Deterministic per-line order (ASCII sort: uppercase acronyms before
    // lowercase topic terms), matching Python's sorted(hits).
    for (const tok of Array.from(hits).sort()) {
      findings.push({
        line: lineNo,
        token: tok,
        position: tag === "schema" ? "output-schema-default" : "construction-rule",
        excerpt: ln.trim().slice(0, 160),
        proposedFix:
          tag === "schema"
            ? "Replace the topic-specific default with a neutral placeholder " +
              "(e.g. <TOPIC_SYNONYM>, <ANCHOR_FRAMEWORK>, <DATA_PATTERN>) so it " +
              "is not copied verbatim into non-matching frameworks."
            : "Rephrase the rule to reference the topic abstractly (the topic " +
              "term / an adjacent topic) rather than naming a specific domain.",
      });
    }
  }

  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.position] = (counts[f.position] || 0) + 1;
  }
  return { findings, counts, totalLines: lines.length };
}
