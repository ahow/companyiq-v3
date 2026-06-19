# Follow-up Instructions

Two deliverables, each fully specified with exact code edits and verified commands.

1. **Ship the 9.x Item 1A evidence-packing fix** — guarantee that, for measures that require a regulatory filing (the `9.x` family), the top Item 1A passage from a confirmed 10-K/20-F is force-included in the evidence pack, and broaden the AI lexicon so filings that say "machine learning"/"generative AI" instead of "artificial intelligence" are recognized.
2. **Run the Chinese-issuer confirmation** — re-run 360 Security (company id **1914**) end-to-end under the deployed JS-shell + CJK fixes and confirm the Chinese annual report is now recovered.

All paths are relative to the repo root `/home/ubuntu/companyiq-v3` (GitHub `main`, auto-deploys to Railway on push).

---

## Part 1 — The 9.x Item 1A evidence-packing fix

### Background (why the current behavior is wrong)
- `server/lib/passage-retrieval.ts` already tags every chunk with its SEC item (`chunk.section`, e.g. `"item1a"`) and gives on-section chunks a `SEC_SECTION_BOOST` (line 377, default 2.5).
- But selection still goes through a **per-document cap** (`MAX_CHUNKS_PER_DOC = 5`, line 378) and a **topic floor** that ranks by raw topic-hit count (lines 481–501). For a measure like `9.1-ai-risk-factor-disclosure`, keyword-dense sustainability-report chunks out-rank the (correctly tagged) 10-K Item 1A chunk, so the 10-K passage never reaches the pack and the scorer correctly answers "No 10-K excerpt present."
- Additionally, Amazon's 10-K does not contain the literal phrase "artificial intelligence"; it uses "machine learning"/"generative AI". Those terms ARE in the lexicon already (lines 137–138), but they are not used to *identify a 10-K chunk as a risk-factor candidate*.

### Change 1a — broaden + reuse the AI lexicon for filing detection
The lexicon at `DEFAULT_AI_TOPIC_TERMS` (lines 136–158) already contains `machine learning`, `generative ai`, `foundation model`, `large language model`, `llm`. **No new terms are strictly required**, but if you want belt-and-suspenders coverage, add these inside the array (after line 143, the `algorithmic, automation, predictive model, foundation model` line):

```ts
  "frontier model", "transformer model", "diffusion model", "ai-enabled",
```

That is the only lexicon edit needed.

### Change 1b — add a "regulatory filing" detector
Add a small helper near the other section helpers (e.g. immediately after `relevantSecSections(...)`, after line 370):

```ts
// True when a measure's definition specifically requires a regulatory annual
// filing (10-K / 20-F / annual report risk factors). Used to force-include the
// top Item 1A chunk so filing-specific measures (the 9.x family) can never be
// starved by keyword-dense non-regulatory documents.
function requiresRegulatoryFiling(measure: FrameworkMeasure): boolean {
  const hay = `${measure.measureId} ${measure.title} ${measure.definition || ""}`.toLowerCase();
  return /10-?k|20-?f|form\s*10|annual report|risk-?factor|risk factor|regulatory filing|securities filing/.test(hay);
}

// Heuristic: does this chunk look like it came from a real 10-K/20-F risk-factor
// section? We require the Item 1A section tag OR explicit risk-factor language,
// AND at least one AI/ML topic term, so we never force in an irrelevant chunk.
function looksLike10KRiskChunk(chunkText: string, section: string | undefined, topicTerms: string[]): boolean {
  const t = chunkText.toLowerCase();
  const isRiskSection = section === "item1a" || /risk factors|item\s*1a/.test(t);
  if (!isRiskSection) return false;
  return countTopicHits(chunkText, topicTerms) > 0;
}
```

### Change 1c — force-include the top Item 1A risk chunk for 9.x measures
In `buildEvidencePackForMeasure(...)`, the selection happens in two steps:
- **Step 1 — topic floor** (lines 481–501)
- **Step 2 — fill remaining slots** (lines 503–508)

Insert a **Step 0 — guaranteed regulatory-filing chunk** *before* the topic floor (i.e. immediately after the `let evidenceLen = 0;` block and the `tryAdd` definition, before the comment `// Step 1 — Topic floor` at line 481). Paste:

```ts
  // Step 0 — Regulatory-filing guarantee (Concern 2 residual fix).
  // For measures that explicitly require a 10-K/20-F (the 9.x family), force the
  // single best 10-K Item 1A risk chunk into the pack BEFORE anything else, so it
  // can never be displaced by keyword-dense sustainability/governance documents.
  if (requiresRegulatoryFiling(measure)) {
    const filingCandidate = scored
      .filter((s) => looksLike10KRiskChunk(s.text, chunks[s.idx].section, topicTerms))
      .sort((a, b) => b.score - a.score)[0];
    if (filingCandidate && evidenceLen + filingCandidate.text.length <= maxChars) {
      selected.push(filingCandidate);
      perDocCount.set(filingCandidate.docIndex, (perDocCount.get(filingCandidate.docIndex) || 0) + 1);
      evidenceLen += filingCandidate.text.length + 2;
    }
  }
```

This reuses the already-computed `scored` array (so it costs nothing extra), respects `maxChars`, and counts against the per-doc budget. Because `tryAdd` (line 469) checks `selected.includes(item)`, the forced chunk will not be double-added by later steps.

### Change 1d — make the section map cover the 9.x family explicitly (defensive)
`relevantSecSections` (lines 350–370) already routes `risk|incident|safety` to `item1a`, which covers `9.1`/`9.3`/`9.4`. To be certain `9.2-ai-capex-rd-quantified` (capex/R&D, which lives in MD&A / Item 7) is also covered, the existing `strateg|...|invest|...|performance` branch (line 360) already adds `item7`. No edit strictly required, but if you want `9.x` hard-pinned, add at the top of the function body (after line 352 `const out = new Set...`):

```ts
  if (/^9\./.test(measure.measureId)) { out.add("item1a"); out.add("item7"); out.add("item7a"); }
```

### Change 1e — (optional) raise the per-doc cap for confirmed filings only
If after the above you still want more 10-K coverage, bump only the filing path rather than the global cap. The global `MAX_CHUNKS_PER_DOC=5` is fine for the rest; do **not** raise it globally (it would let one big filing dominate every measure). The Step 0 force-include is sufficient for the NVIDIA/Amazon cases.

### Validate Part 1 locally before deploying
The repo runs under `tsx` (no build step). Type-check only the changed file and run a quick scratch test:

```bash
cd /home/ubuntu/companyiq-v3
# 1) type-check the changed file (ignore the pre-existing pdf-parse types error on line 3 of other files)
npx tsc --noEmit -p tsconfig.json 2>&1 | grep passage-retrieval || echo "no new errors in passage-retrieval.ts"

# 2) scratch behavioral test
cat > _pack_test.mts <<'EOF'
import { chunkDocuments, buildBM25Index, buildEvidencePackForMeasure, DEFAULT_AI_TOPIC_TERMS } from "./server/lib/passage-retrieval.js";

const tenK = `--- DOCUMENT: NVIDIA Form 10-K [https://sec.gov/nvda] ---

Item 1A. Risk Factors
Our business is exposed to risks related to artificial intelligence and machine learning, including model performance, regulation, and competition in generative AI markets.`;
const esg = `--- DOCUMENT: NVIDIA Sustainability Report [https://nvidia.com/esg] ---

We are committed to responsible AI. Our responsible AI program covers AI ethics, AI governance, AI risk, AI strategy, AI systems, AI models, AI tools across our AI-powered platforms.`;

const chunks = chunkDocuments(esg + "\n\n" + tenK);
const bm25 = buildBM25Index(chunks.map((c) => c.text));
const measure: any = { measureId: "9.1-ai-risk-factor-disclosure", category: "AI Risk Disclosure and Capital Allocation", title: "AI risk-factor disclosure in 10-K", definition: "AI is named in the risk-factor section (Item 1A) of the regulatory annual filing (10-K/20-F)." };
const pack = buildEvidencePackForMeasure({ measure, chunks, bm25Index: bm25, topicTerms: DEFAULT_AI_TOPIC_TERMS });
const includes10K = /Item 1A|Risk Factors/i.test(pack.text);
console.log("pack includes Item 1A 10-K chunk:", includes10K);
if (!includes10K) { console.error("FAIL: 10-K Item 1A not force-included"); process.exit(1); }
console.log("PASS");
EOF
npx tsx _pack_test.mts && rm -f _pack_test.mts
```

You want to see `pack includes Item 1A 10-K chunk: true` / `PASS`. (Before the fix, the ESG chunk wins and this prints `false`.)

### Commit & deploy Part 1
```bash
cd /home/ubuntu/companyiq-v3
git add server/lib/passage-retrieval.ts
git -c user.email=you@example.com -c user.name=you commit -m "fix(retrieval): force-include 10-K Item 1A chunk for 9.x measures; widen AI lexicon"
git push origin main      # Railway auto-deploys app + worker
```

Wait until the worker shows the new commit Online (≈2–4 min):
```bash
export RAILWAY_API_TOKEN=<your token>
railway status            # or: railway logs --service worker | tail
```

---

## Part 2 — Chinese-issuer confirmation run (360 Security, id 1914)

### What this confirms
That the three deployed Chinese-cohort fixes work end-to-end on a real JS/WAF-protected Chinese source:
- JS-shell → browser-render escalation (`processor.ts`)
- non-terminal "generic-because-empty" verification (`pipeline.ts`)
- CJK bigram tokenizer (`passage-retrieval.ts`)

### Prerequisites
- Part 1 deployed (or at least the existing fixes are live — they already are).
- Worker env still has the elevated timeouts (`PIPELINE_TIMEOUT_MS=2100000`, `JOB_TIMEOUT_MS=2400000`) and `SCORING_STRICT_PROVIDER=true`, `SCORING_SELF_CONSISTENCY=3`. Verify:
  ```bash
  export RAILWAY_API_TOKEN=<your token>
  railway variables --service worker | grep -E "PIPELINE_TIMEOUT_MS|JOB_TIMEOUT_MS|SCORING_"
  ```

### Connection values (temporary public proxies — see security note at the end)
```
PG  : postgresql://postgres:ciq3securepass2024@caboose.proxy.rlwy.net:31535/companyiq_v3
REDIS: redis://thomas.proxy.rlwy.net:24450
```
(Both were verified OPEN at the time of writing. If they have since been removed, run the enqueue from inside the Railway network instead — see "Alternative enqueue" below.)

### Step 2.1 — enqueue 360 Security with a FULL reset (fresh discovery + fetch)
A full reset is required so discovery + fetch re-run from scratch under the new code (otherwise the previously-rejected docs persist). Run from the sandbox:

```bash
cd /home/ubuntu/companyiq-v3
export DATABASE_URL="postgresql://postgres:ciq3securepass2024@caboose.proxy.rlwy.net:31535/companyiq_v3"
export REDIS_URL="redis://thomas.proxy.rlwy.net:24450"
SAMPLE_COMPANY_IDS=1914 SAMPLE_FULL_RESET=1 \
  node --import tsx server/scripts/requeue-sample.ts
```
Note the printed `created batch <N>` — call it `BATCH`.

Because a single-company batch is enqueued at top priority (priority 0), it jumps the backlog. If it does NOT get claimed within ~3 min (e.g. a large batch is mid-flight), bump it explicitly:
```bash
# find the job tuple
PG="postgresql://postgres:ciq3securepass2024@caboose.proxy.rlwy.net:31535/companyiq_v3"
psql "$PG" -At -F: -c "SELECT id, company_id, batch_id, framework_id, workspace_id FROM analysis_jobs WHERE company_id=1914 ORDER BY id DESC LIMIT 1;"
# then (substitute the printed values jobId:companyId:batchId:frameworkId:workspaceId)
BUMP_JOBS="<jobId>:1914:<batchId>:7:3" node --import tsx server/scripts/priority-bump.ts
```

### Step 2.2 — watch it complete
```bash
PG="postgresql://postgres:ciq3securepass2024@caboose.proxy.rlwy.net:31535/companyiq_v3"
watch -n 30 "psql '$PG' -c \"SELECT status, attempts, age(now(),claimed_at) elapsed FROM analysis_jobs WHERE company_id=1914 ORDER BY id DESC LIMIT 1;\""
# in another shell, tail worker logs for the company
export RAILWAY_API_TOKEN=<your token>
railway logs --service worker | grep -i "360 Security"
```
Expect the pipeline to take 5–10 min (browser render of the Chinese annual report is slower).

### Step 2.3 — confirm the Chinese annual report was recovered (the actual success criteria)
```bash
PG="postgresql://postgres:ciq3securepass2024@caboose.proxy.rlwy.net:31535/companyiq_v3"

# (a) Document health: expect MORE than 1 'ok' doc, and at least one with real content length.
psql "$PG" -c "SELECT fetch_status, count(*) FROM documents WHERE company_id=1914 GROUP BY fetch_status ORDER BY 2 DESC;"

# (b) The annual report specifically: expect fetch_status='ok' and a large content_length (hundreds of KB), NOT a JS stub.
psql "$PG" -c "
  SELECT left(d.title,60) title, d.fetch_status, dc.content_length
  FROM documents d LEFT JOIN document_content dc ON dc.id = d.content_id
  WHERE d.company_id=1914 AND (d.title ILIKE '%年度报告%' OR d.title ILIKE '%annual report%' OR d.title ILIKE '%三六零%')
  ORDER BY dc.content_length DESC NULLS LAST;"

# (c) Corpus contains CJK AI terms (so the tokenizer has something to work with):
psql "$PG" -c "
  SELECT (position('人工智能' in dc.content)>0) has_cjk_ai,
         (position('风险' in dc.content)>0)     has_cjk_risk,
         dc.content_length
  FROM documents d JOIN document_content dc ON dc.id=d.content_id
  WHERE d.company_id=1914 AND dc.content_length > 5000
  ORDER BY dc.content_length DESC LIMIT 5;"

# (d) Final score is no longer a mechanical zero:
psql "$PG" -c "SELECT name, total_score, measures_met_count, measures_total_count FROM companies WHERE id=1914;"
```

**Success criteria:**
- (a) shows **>1 `ok` doc**, and the previous "all rejected/dead" pattern is gone.
- (b) shows the annual report as `ok` with a **large `content_length`** (i.e. real content, not a ~50-char JS stub).
- (c) returns `has_cjk_ai = t` for at least one substantial doc.
- (d) `total_score` is **> 0** and `measures_met_count` is non-null. (The exact score matters less than: it is no longer mechanically zero because of an empty corpus.)

If (b) still shows the annual report rejected/empty, pull the gate reason to see whether it's a *new* failure mode:
```bash
psql "$PG" -c "
  SELECT left(title,50) title, fetch_status, fetch_failures,
         left((discovery_metadata->>'gate_reason'),120) gate_reason
  FROM documents WHERE company_id=1914 ORDER BY fetch_status;"
```

### Alternative enqueue (if the public proxies are gone)
Run the same script **inside** the Railway worker network, where `redis.railway.internal` resolves:
```bash
cd /home/ubuntu/companyiq-v3
export RAILWAY_API_TOKEN=<your token>
railway ssh --service worker \
  "cd /app && SAMPLE_COMPANY_IDS=1914 SAMPLE_FULL_RESET=1 node --import tsx server/scripts/requeue-sample.ts"
```
(Note: during this session, `railway ssh` occasionally OOM-crashed while the worker was saturated. If that happens, retry when the queue is idle, or re-open the public Redis proxy temporarily.)

---

## Security cleanup (do this when both tasks are done)
The temporary public TCP proxies on **Postgres** and **Redis** were opened so jobs could be enqueued from outside Railway's private network. They use random hosts/ports but should be removed:
- Railway dashboard → **Postgres** service → **Settings → Networking → remove TCP proxy**
- Railway dashboard → **Redis** service → **Settings → Networking → remove TCP proxy**

(The Railway API token returns 403 on proxy deletion, so this must be done in the dashboard.) Keep the `SCORING_*` and timeout env vars in place.

---

## Quick reference — IDs and files
| Item | Value |
|---|---|
| Workspace | 3 |
| Framework | 7 (34 AI-governance measures) |
| 360 Security company id | **1914** |
| Retrieval code | `server/lib/passage-retrieval.ts` |
| Enqueue script | `server/scripts/requeue-sample.ts` |
| Priority bump script | `server/scripts/priority-bump.ts` |
| Key env (worker) | `SCORING_STRICT_PROVIDER=true`, `SCORING_SELF_CONSISTENCY=3`, `PIPELINE_TIMEOUT_MS=2100000`, `JOB_TIMEOUT_MS=2400000`, optional `RETRIEVAL_*` tunables |
