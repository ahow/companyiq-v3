/**
 * Calibrate a document-level proxy classifier. For NVIDIA's proxy (nvda-20260512)
 * vs real 10-Ks (NVIDIA nvda-20260125 + Salesforce/Amazon/Meta/Microsoft), count
 * STRONG proxy-exclusive markers and STRONG 10-K markers, to find a separating rule.
 */
import pg from "pg";

const PG = process.env.PG || "";
const DOCS: Array<{ name: string; cid: number; kind: string }> = [
  { name: "NVDA-proxy nvda-20260512", cid: 207834, kind: "PROXY" },
  { name: "NVDA-10K nvda-20260125", cid: 207831, kind: "10-K" },
  { name: "CRM-10K crm-20260131", cid: 235179, kind: "10-K" },
  { name: "AMZN-10K", cid: 215829, kind: "10-K" },
  { name: "META-10K", cid: 156982, kind: "10-K" },
  { name: "MSFT-10K", cid: 214934, kind: "10-K" },
];

// Proxy-EXCLUSIVE phrases (essentially never the bulk of a 10-K).
const STRONG_PROXY = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|board of directors recommends|proxy card|voting (instructions|your shares)|record date|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;
// Strong 10-K-Item-1A markers.
const STRONG_10K = /item\s*1a|item\s*7\.|management's discussion and analysis|consolidated (balance sheet|statements of operations)|item\s*8\./gi;

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  console.log("doc | kind | len | strongProxy | strong10K | ratio(proxy/len*1e5)");
  for (const d of DOCS) {
    const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [d.cid]);
    const t = rows[0]?.content || "";
    const p = (t.match(STRONG_PROXY) || []).length;
    const k = (t.match(STRONG_10K) || []).length;
    const ratio = t.length ? (p / t.length * 1e5).toFixed(2) : "0";
    console.log(`${d.name} | ${d.kind} | ${t.length} | ${p} | ${k} | ${ratio}`);
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
