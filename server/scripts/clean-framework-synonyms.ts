/**
 * clean-framework-synonyms.ts
 *
 * Maintenance script: clean filing/report boilerplate + generic filler out of an
 * EXISTING framework's topic_synonyms (and, optionally, retrieval_query_terms)
 * using the same topic-agnostic sanitiser the builder now applies at build time
 * (server/lib/framework-v2/boilerplate-hygiene.ts). This is the "clean existing
 * frameworks" companion to the build-time B2 hygiene.
 *
 * SAFE BY DEFAULT — dry-run: prints the exact before/after diff for every
 * affected framework and writes NOTHING. Pass --apply to persist the cleaned
 * lists. The sanitiser is non-destructive to the framework's own lexicon: the
 * topic term and adjacent-topic names are protected, so a genuine topic term is
 * never removed.
 *
 * Usage (never run against prod without review):
 *   # dry-run, all frameworks in the workspace:
 *   DATABASE_URL=... node --import tsx server/scripts/clean-framework-synonyms.ts
 *   # dry-run, one framework:
 *   DATABASE_URL=... node --import tsx server/scripts/clean-framework-synonyms.ts --framework 12
 *   # apply:
 *   DATABASE_URL=... node --import tsx server/scripts/clean-framework-synonyms.ts --framework 12 --apply
 *   # also clean retrieval_query_terms:
 *   DATABASE_URL=... node --import tsx server/scripts/clean-framework-synonyms.ts --include-retrieval --apply
 */
import { db } from "../db.js";
import * as schema from "../../shared/schema.js";
import { eq } from "drizzle-orm";
import { sanitizeTopicTerms } from "../lib/framework-v2/boilerplate-hygiene.js";

function parseArgs(argv: string[]) {
  const args = { apply: false, frameworkId: null as number | null, includeRetrieval: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--include-retrieval") args.includeRetrieval = true;
    else if (a === "--framework") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) throw new Error("--framework requires a numeric id");
      args.frameworkId = n;
    }
  }
  return args;
}

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[clean-synonyms] mode=${args.apply ? "APPLY" : "DRY-RUN"} ` +
      `framework=${args.frameworkId ?? "ALL"} includeRetrieval=${args.includeRetrieval}`,
  );

  const rows = args.frameworkId != null
    ? await db.select().from(schema.frameworks).where(eq(schema.frameworks.id, args.frameworkId))
    : await db.select().from(schema.frameworks);

  if (!rows.length) {
    console.log("[clean-synonyms] no frameworks matched — nothing to do.");
    return;
  }

  let changedCount = 0;
  for (const fw of rows as any[]) {
    const topicTerm = typeof fw.topicTerm === "string" ? fw.topicTerm : "";
    const adjacentNames = Array.isArray(fw.adjacentTopics)
      ? fw.adjacentTopics.map((a: any) => (typeof a === "string" ? a : a?.name)).filter(Boolean)
      : [];
    // Protect the framework's CANONICAL lexicon only — never the candidate list
    // itself, so boilerplate that slipped into the synonyms can be removed.
    const protectTokens = [topicTerm, ...adjacentNames].filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );

    const synBefore = asStrArray(fw.topicSynonyms);
    const synResult = sanitizeTopicTerms(synBefore, { topicTokens: protectTokens });
    const synChanged = synResult.dropped.length > 0;

    let retBefore: string[] = [];
    let retResult: ReturnType<typeof sanitizeTopicTerms> | null = null;
    let retChanged = false;
    if (args.includeRetrieval) {
      retBefore = asStrArray(fw.retrievalQueryTerms);
      retResult = sanitizeTopicTerms(retBefore, { topicTokens: protectTokens });
      retChanged = retResult.dropped.length > 0;
    }

    if (!synChanged && !retChanged) continue;
    changedCount++;

    console.log(`\n─── framework #${fw.id} "${fw.name}" (topicTerm: ${topicTerm || "?"}) ───`);
    if (synChanged) {
      console.log(`  topic_synonyms: ${synBefore.length} → ${synResult.kept.length}`);
      console.log(`    dropped: ${synResult.dropped.map((d) => `${d.term} (${d.reason})`).join(", ")}`);
    }
    if (retChanged && retResult) {
      console.log(`  retrieval_query_terms: ${retBefore.length} → ${retResult.kept.length}`);
      console.log(`    dropped: ${retResult.dropped.map((d) => `${d.term} (${d.reason})`).join(", ")}`);
    }

    if (args.apply) {
      const set: any = {};
      if (synChanged) set.topicSynonyms = synResult.kept;
      if (retChanged && retResult) set.retrievalQueryTerms = retResult.kept;
      await db.update(schema.frameworks).set(set).where(eq(schema.frameworks.id, fw.id));
      console.log(`  ✔ applied.`);
    }
  }

  console.log(
    `\n[clean-synonyms] ${changedCount} framework(s) ${args.apply ? "cleaned" : "would be cleaned"}. ` +
      `${args.apply ? "" : "Re-run with --apply to persist."}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[clean-synonyms] FAILED:", err?.stack || err);
    process.exit(1);
  });
