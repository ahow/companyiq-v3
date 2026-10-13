// LOCAL-ONLY diagnostic harness (batch 1277 timeout investigation). No LLM, no browser,
// no network, no DB writes. Replays the synchronous corpus-assembly loop that runs in
// runPipeline() (server/lib/pipeline.ts ~2293-2361) between the log lines
// "Analyzing with N fetched documents" and "ABOUTNESS corpus: ...", using the real
// batch_corpus snapshot of batch 1277 (dumped read-only to /home/ubuntu/var_corpus_1277).
//
// Usage: DATABASE_URL=<local container url> npx tsx timeout1277_analyze_prep.ts <companyId> [peerLimit]
//   (DATABASE_URL is only needed because issuer-resolver imports db.ts; no query is issued.)
// Run under `node --cpu-prof` via: node --cpu-prof --cpu-prof-dir=DIR --import tsx <this file> ...
import { readFileSync } from "node:fs";
import { scoreAboutness } from "../../../server/lib/aboutness.js";
import { classifyProvenance } from "../../../server/lib/provenance.js";
import { deriveAliases } from "../../../server/lib/issuer-resolver.js";

const cid = Number(process.argv[2]);
const peerLimit = process.argv[3] ? Number(process.argv[3]) : Infinity;
const dir = process.env.CORPUS_DIR || "/home/ubuntu/var_corpus_1277";
const { company, docs } = JSON.parse(readFileSync(`${dir}/${cid}.json`, "utf8"));
const peersAll: string[] = JSON.parse(readFileSync(`${dir}/peers.json`, "utf8"))
  .filter((c: any) => c.id !== cid)
  .map((c: any) => (c.name || "").toLowerCase())
  .filter((n: string) => n && n.length >= 4);
const peers = peersAll.slice(0, Number.isFinite(peerLimit) ? peerLimit : peersAll.length);
const aliases = deriveAliases(company.name, company.ticker || null);
const domain = (company.domain || "").replace(/^www\./, "").toLowerCase();

let tAbout = 0, tProv = 0, kept = 0, rejected = 0, deprio = 0;
const perDoc: any[] = [];
const t0 = performance.now();
for (const doc of docs) {
  if (!doc.content) continue;
  let a = 0, p = 0;
  if (doc.content.length > 50) {
    const s = performance.now();
    const ab = scoreAboutness(doc.content, company.name, aliases, peers);
    a = performance.now() - s; tAbout += a;
    if (ab.decision === "reject") { rejected++; perDoc.push({ id: doc.id, len: doc.content.length, aboutMs: Math.round(a), provMs: 0, decision: "reject" }); continue; }
    if (ab.decision === "deprioritize") deprio++;
  }
  const s2 = performance.now();
  classifyProvenance({
    url: doc.url, title: doc.title, content: doc.content, companyDomain: domain,
    relatedDomains: company.related_domains || [], companyName: company.name,
    companyTicker: company.ticker || null, companyAliases: aliases, companyIsin: company.isin || null,
    companySecCik: null, knownIrTenants: new Map(),
  });
  p = performance.now() - s2; tProv += p; kept++;
  perDoc.push({ id: doc.id, len: doc.content.length, aboutMs: Math.round(a), provMs: Math.round(p) });
}
const wall = performance.now() - t0;
perDoc.sort((x, y) => y.aboutMs + y.provMs - (x.aboutMs + x.provMs));
console.log(JSON.stringify({
  companyId: cid, company: company.name, docs: docs.length,
  totalChars: docs.reduce((s: number, d: any) => s + (d.content?.length || 0), 0),
  peers: peers.length, aliases, wallMs: Math.round(wall), aboutnessMs: Math.round(tAbout),
  provenanceMs: Math.round(tProv), kept, rejected, deprioritized: deprio, top5: perDoc.slice(0, 5),
}));
process.exit(0);
