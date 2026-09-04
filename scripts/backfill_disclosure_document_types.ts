/**
 * R1 backfill: aggregate framework_measures.disclosure_vehicles into
 * framework.required_doc_types per framework.
 *
 * Framework-agnostic. Runs once per framework, or per --framework=<id>.
 *
 * By default runs in --dry-run mode (prints proposed values, doesn't write).
 * Pass --apply to actually update the DB.
 *
 * The function is idempotent: running twice against the same data produces
 * the same result. Existing non-null required_doc_types are OVERWRITTEN,
 * because the source of truth is the per-measure disclosureVehicles list.
 *
 * Usage:
 *   npx tsx scripts/backfill_disclosure_document_types.ts
 *   npx tsx scripts/backfill_disclosure_document_types.ts --framework=3
 *   npx tsx scripts/backfill_disclosure_document_types.ts --apply
 */

import { Client } from "pg";
import { aggregateDisclosureVehicles } from "../server/lib/disclosure-document-types.js";

const DB = process.env.DATABASE_URL ||
  "postgresql://postgres:ciq3securepass2024@hayabusa.proxy.rlwy.net:57064/companyiq_v3";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const frameworkArg = args.find(a => a.startsWith("--framework="));
  const frameworkFilter = frameworkArg ? parseInt(frameworkArg.split("=")[1], 10) : null;

  const c = new Client({ connectionString: DB, connect_timeout: 10 });
  await c.connect();

  const fw = await c.query(`
    select id, name, required_doc_types
      from frameworks
     ${frameworkFilter ? "where id = $1" : ""}
     order by id
  `, frameworkFilter ? [frameworkFilter] : []);

  if (fw.rows.length === 0) {
    console.log("No frameworks matched.");
    await c.end();
    return;
  }

  console.log(`Processing ${fw.rows.length} framework(s). ${apply ? "APPLYING." : "Dry run \u2014 pass --apply to persist."}\n`);

  for (const f of fw.rows) {
    const meas = await c.query(`
      select measure_id, disclosure_vehicles
        from framework_measures
       where framework_id = $1
       order by category_number, display_order
    `, [f.id]);

    const perMeasureVehicles = meas.rows.map((r: any) => r.disclosure_vehicles || []);
    const agg = aggregateDisclosureVehicles(perMeasureVehicles, { maxItems: 15 });

    console.log(`\u2500\u2500\u2500 Framework ${f.id}: ${f.name}`);
    console.log(`  measures scanned: ${meas.rows.length}`);
    console.log(`  vehicles kept (${agg.vehicles.length}):`);
    for (const v of agg.vehicles) console.log(`    \u2022 ${v}`);
    console.log(`  vehicles rejected (${agg.rejected.length}): ${agg.rejected.slice(0, 6).join(", ")}${agg.rejected.length > 6 ? " \u2026" : ""}`);
    console.log(`  current required_doc_types: ${JSON.stringify(f.required_doc_types)}`);

    if (agg.vehicles.length === 0) {
      console.log(`  SKIP: no vehicles aggregated`);
      continue;
    }

    // Idempotence check: if the current value equals the proposed value, no update.
    const current = f.required_doc_types || [];
    const same =
      Array.isArray(current) &&
      current.length === agg.vehicles.length &&
      current.every((v: string, i: number) => v === agg.vehicles[i]);
    if (same) {
      console.log(`  IDEMPOTENT: current value already matches proposed \u2014 no update needed.`);
      continue;
    }

    if (apply) {
      await c.query(
        `update frameworks set required_doc_types = $1, updated_at = now() where id = $2`,
        [JSON.stringify(agg.vehicles), f.id],
      );
      console.log(`  APPLIED: framework ${f.id} updated.`);
    } else {
      console.log(`  PROPOSED update: would set required_doc_types to ${agg.vehicles.length} items.`);
    }
  }

  await c.end();
  console.log(`\nDone.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
