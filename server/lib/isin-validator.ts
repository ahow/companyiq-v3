/**
 * ISO 6166 ISIN validator.
 *
 * An ISIN is a 12-character identifier:
 *   - Chars 1-2: ISO 3166-1 alpha-2 country code (e.g. "GB", "US", "JP")
 *   - Chars 3-11: 9-char National Securities Identifying Number (alphanumeric)
 *   - Char 12:   Luhn-mod-10 check digit computed over the numeric expansion
 *                of the first 11 characters, with letters expanded as
 *                A=10, B=11, ..., Z=35 (i.e. each letter becomes two digits).
 *
 * Rationale: caller-supplied ISINs may arrive typo'd (transposed digits,
 * wrong check digit). A local validation is free, does not require an
 * outbound API call, and catches the vast majority of accidental corruption
 * at ingest time. It does NOT detect a right-format-but-wrong-issuer ISIN
 * (e.g. paste of Prudential Financial's ISIN when Prudential plc was
 * intended) \u2014 that needs a name/country cross-check against FMP or a
 * similar authoritative source, which is deliberately deferred to a
 * follow-up PR.
 *
 * Reference: ISO 6166:2013, Annex B, and the identical Luhn scheme used
 * for CUSIP check digits.
 */

/** Result of an ISIN validation attempt. */
export interface IsinValidation {
  /** True iff the input is a syntactically well-formed ISIN with a valid check digit. */
  valid: boolean;
  /** Uppercased, whitespace-trimmed canonical form. Only set when valid. */
  canonical: string | null;
  /**
   * Failure reason when `valid` is false. One of:
   *   - "empty"        : input was null / empty / whitespace
   *   - "length"       : not exactly 12 characters after trim
   *   - "charset"      : contains characters outside [A-Z0-9]
   *   - "country"      : first 2 characters are not both A-Z
   *   - "check-digit"  : format OK but Luhn check digit does not match
   */
  reason: "empty" | "length" | "charset" | "country" | "check-digit" | null;
}

/**
 * Validate a candidate ISIN string. Returns a structured result so callers
 * can log / warn / reject with a specific reason rather than a bare boolean.
 *
 * Whitespace and mixed case are tolerated: `" gb0007099541 "` and
 * `"gb0007099541"` both normalise to `"GB0007099541"`.
 */
export function validateIsin(input: string | null | undefined): IsinValidation {
  if (input == null) return { valid: false, canonical: null, reason: "empty" };
  const raw = String(input).trim().toUpperCase();
  if (raw.length === 0) return { valid: false, canonical: null, reason: "empty" };
  if (raw.length !== 12) return { valid: false, canonical: null, reason: "length" };
  if (!/^[A-Z0-9]{12}$/.test(raw)) return { valid: false, canonical: null, reason: "charset" };
  if (!/^[A-Z]{2}/.test(raw)) return { valid: false, canonical: null, reason: "country" };

  // Expand letters to two-digit numeric equivalents (A=10 ... Z=35) across
  // the first 11 characters, then run the Luhn-mod-10 algorithm right-to-left
  // on the resulting digit stream, doubling every second digit and summing
  // the base-10 digits of each product.
  let digitStream = "";
  for (const ch of raw.slice(0, 11)) {
    if (ch >= "0" && ch <= "9") {
      digitStream += ch;
    } else {
      digitStream += String(ch.charCodeAt(0) - "A".charCodeAt(0) + 10);
    }
  }

  let sum = 0;
  // Iterate right-to-left. `doubleFlag` starts true because the rightmost
  // digit of the expanded stream is at position 1 from the right when the
  // check digit is appended \u2014 i.e. it participates in the doubling.
  let doubleFlag = true;
  for (let i = digitStream.length - 1; i >= 0; i--) {
    let d = digitStream.charCodeAt(i) - "0".charCodeAt(0);
    if (doubleFlag) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleFlag = !doubleFlag;
  }
  const expectedCheck = (10 - (sum % 10)) % 10;
  const suppliedCheck = raw.charCodeAt(11) - "0".charCodeAt(0);
  if (suppliedCheck < 0 || suppliedCheck > 9) {
    // The final character isn't a digit at all. Treat as check-digit failure
    // rather than charset failure since the earlier /[A-Z0-9]{12}/ test would
    // already have caught non-alphanumeric, and this is specifically the
    // Luhn contract being violated.
    return { valid: false, canonical: null, reason: "check-digit" };
  }
  if (expectedCheck !== suppliedCheck) {
    return { valid: false, canonical: null, reason: "check-digit" };
  }
  return { valid: true, canonical: raw, reason: null };
}

/**
 * Convenience: return the canonical form if valid, else null.
 * Use when the caller just wants a "clean or drop" decision.
 */
export function canonicaliseIsin(input: string | null | undefined): string | null {
  return validateIsin(input).canonical;
}
