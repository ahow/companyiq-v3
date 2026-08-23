/**
 * Pipeline version tag for cache invalidation.
 *
 * Bump PIPELINE_VERSION whenever the FIGI resolution, alias derivation,
 * related-domain discovery, or domain-inference logic changes in a way
 * that would alter output for identical input. This forces the discovery
 * layer to re-derive on the next battery rather than reading a stale
 * cached value from a previous pipeline version.
 *
 * Convention: "vNN-<short-slug>". Increment NN on every logic change.
 */
export const PIPELINE_VERSION = "v57-doc-title-evidence-bonus";
