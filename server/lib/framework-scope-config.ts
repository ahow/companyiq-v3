// framework-scope-config.ts — generic scope-config enrichment for the framework
// object returned by storage.getFrameworkById.
//
// The analyzer builds two scope contexts (analyzer.ts, Priority-2 flags
// REPORTING_PERIOD_ENFORCED / ENTITY_SCOPE_ENFORCED) by reading these fields off
// the framework object:
//   • fw.entityType            (string)
//   • fw.universe              (string)
//   • fw.reportingPeriodMonths (number of months)
//   • fw.subsidiaryDomains     (string[])
// None of these are columns on the frameworks Drizzle table, so they are always
// undefined and the strictness fails open. This helper back-fills them from the
// framework's existing `metadata` jsonb column, under `metadata.scopeConfig`, so
// the already-enabled strictness flags can actually engage.
//
// COMPLETELY GENERIC: no company / framework / measure name is referenced. The
// helper is pure — given the same inputs it returns the same output and never
// mutates its argument. When disabled, or when metadata/scopeConfig is absent, it
// returns the framework UNCHANGED (same reference). A field is set ONLY when it is
// present and valid in scopeConfig AND not already set (non-null) on the framework
// — so a real framework column always wins over the metadata carrier.

/** Shape of the carrier object read from `framework.metadata.scopeConfig`.
 *  All fields optional; invalid/unknown fields are ignored defensively. */
export interface FrameworkScopeConfig {
  entityType?: unknown;
  universe?: unknown;
  reportingPeriodMonths?: unknown;
  subsidiaryDomains?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** A framework field counts as "already set" (and must not be overwritten) when
 *  it is neither null nor undefined. */
function alreadySet(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/**
 * Enrich a framework object with scope-config fields carried in
 * `framework.metadata.scopeConfig`.
 *
 * @param framework  the raw framework object (as returned by db.select())
 * @param opts.enabled  gate; when false the framework is returned UNCHANGED
 * @returns the same reference when nothing is enriched, otherwise a shallow clone
 *          with the applicable fields set.
 */
export function enrichFrameworkScopeConfig<T extends Record<string, any>>(
  framework: T,
  opts: { enabled: boolean },
): T {
  if (!opts || !opts.enabled) return framework;
  if (!framework || typeof framework !== "object") return framework;

  const metadata = (framework as any).metadata;
  if (!metadata || typeof metadata !== "object") return framework;

  const scopeConfig = (metadata as any).scopeConfig as FrameworkScopeConfig | undefined;
  if (!scopeConfig || typeof scopeConfig !== "object") return framework;

  // Build the set of changes defensively; only apply a field when valid in
  // scopeConfig AND not already set on the framework.
  const patch: Record<string, any> = {};

  // entityType — non-empty string
  if (
    !alreadySet((framework as any).entityType) &&
    isNonEmptyString(scopeConfig.entityType)
  ) {
    patch.entityType = scopeConfig.entityType.trim();
  }

  // universe — non-empty string
  if (
    !alreadySet((framework as any).universe) &&
    isNonEmptyString(scopeConfig.universe)
  ) {
    patch.universe = scopeConfig.universe.trim();
  }

  // reportingPeriodMonths — finite number > 0
  if (!alreadySet((framework as any).reportingPeriodMonths)) {
    const n = Number(scopeConfig.reportingPeriodMonths);
    if (
      typeof scopeConfig.reportingPeriodMonths === "number" &&
      Number.isFinite(n) &&
      n > 0
    ) {
      patch.reportingPeriodMonths = n;
    }
  }

  // subsidiaryDomains — string[] filtered to non-empty trimmed strings
  if (!alreadySet((framework as any).subsidiaryDomains)) {
    if (Array.isArray(scopeConfig.subsidiaryDomains)) {
      const cleaned = scopeConfig.subsidiaryDomains
        .filter((d): d is string => isNonEmptyString(d))
        .map((d) => d.trim());
      if (cleaned.length > 0) {
        patch.subsidiaryDomains = cleaned;
      }
    }
  }

  // Nothing applicable → return unchanged reference.
  if (Object.keys(patch).length === 0) return framework;

  return { ...framework, ...patch };
}
