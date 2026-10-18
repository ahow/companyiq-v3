/**
 * phase2-holdout-roster.ts — DATA/CONFIG for the Phase 2 ground-truth holdout.
 *
 * This file is pure CONFIGURATION, not logic. It lists the companies eligible for
 * the holdout roster and flags the non-English filers so the (generic) selection
 * in phase2-groundtruth.ts can satisfy the "≥2 non-English filers" coverage rule.
 * The selection code contains NO company- or topic-specific branches — it only
 * reads these flags. Edit this list to re-stratify; no code change required.
 *
 * Non-English filers that have run artifacts (e.g. Sumitomo Forestry, TSMC,
 * Suzano) are selected through the normal strata. Non-English filers WITHOUT run
 * artifacts yet (e.g. Idemitsu, Otsuka — suggested by the review) are kept as
 * placeholder cells flagged `needs-evidence`, so the roster stays representative
 * before their evidence is collected.
 */

import type { RosterCompany } from "./phase2-groundtruth.js";

/**
 * The default holdout roster. Companies 1 & 11–22 have post-fix replay artifacts
 * under var_out_phase1_postfix; Idemitsu/Otsuka are forward-looking non-English
 * placeholders (no artifacts yet ⇒ needs-evidence).
 */
export const DEFAULT_HOLDOUT_ROSTER: RosterCompany[] = [
  { companyId: 1, companyName: "Nestlé" },
  { companyId: 11, companyName: "Unilever" },
  { companyId: 12, companyName: "BHP Group" },
  { companyId: 13, companyName: "Kering" },
  { companyId: 14, companyName: "Walmart" },
  { companyId: 16, companyName: "Banco Santander" },
  { companyId: 18, companyName: "Newmont Corporation" },
  { companyId: 20, companyName: "Sumitomo Forestry", nonEnglish: true },
  { companyId: 21, companyName: "Taiwan Semiconductor Manufacturing Company", nonEnglish: true },
  { companyId: 22, companyName: "Suzano", nonEnglish: true },
  // Forward-looking non-English placeholders (no run artifacts yet ⇒ needs-evidence):
  { companyId: 9001, companyName: "Idemitsu Kosan", nonEnglish: true },
  { companyId: 9002, companyName: "Otsuka Holdings", nonEnglish: true },
];

/** Default reproducibility seed for the standing holdout. */
export const DEFAULT_HOLDOUT_SEED = "companyiq-v3-phase2-holdout-v1";
