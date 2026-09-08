// Live validation of Strategies D (fetchPdfDirectRetry) and E (fetchPdfGoogleCache)
// against REAL dead suncor.com PDF URLs from production. This is an end-to-end test
// of actual recovery — not a check that the code path is wired.
import { readFileSync } from "node:fs";
import { fetchPdfDirectRetry, fetchPdfGoogleCache } from "../lib/processor.js";

interface TestDoc { url: string; title: string; reason: string; }

async function main() {
  const testset: TestDoc[] = JSON.parse(readFileSync("/tmp/suncor_testset.json", "utf-8"));
  console.log(`\n=== Validating D/E against ${testset.length} real dead suncor.com URLs ===\n`);
  const origin = "https://www.suncor.com";
  let dRecovered = 0, eRecovered = 0, combined = 0;
  for (const doc of testset) {
    console.log(`\n--- ${doc.title} [${doc.reason}] ---`);
    console.log(`    ${doc.url.slice(0, 110)}`);
    // Strategy D: direct node fetch with browser UA + delay
    let dText: string | null = null;
    try {
      dText = await fetchPdfDirectRetry(doc.url, origin, { delayMs: 500 });
    } catch (e: any) {
      console.log(`    D threw (should never happen): ${e?.message}`);
    }
    if (dText) { dRecovered++; console.log(`    ✅ D recovered ${dText.length} chars`); }
    else console.log(`    ❌ D: no recovery`);
    // Strategy E: google cache
    let eText: string | null = null;
    try {
      eText = await fetchPdfGoogleCache(doc.url);
    } catch (e: any) {
      console.log(`    E threw (should never happen): ${e?.message}`);
    }
    if (eText) { eRecovered++; console.log(`    ✅ E recovered ${eText.length} chars`); }
    else console.log(`    ❌ E: no recovery`);
    if (dText || eText) combined++;
  }
  console.log(`\n=== RESULT ===`);
  console.log(`Strategy D recovered: ${dRecovered}/${testset.length}`);
  console.log(`Strategy E recovered: ${eRecovered}/${testset.length}`);
  console.log(`Combined (D or E):    ${combined}/${testset.length}`);
  process.exit(0);
}
main();
