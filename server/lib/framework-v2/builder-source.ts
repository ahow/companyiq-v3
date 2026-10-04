/**
 * STEP 1 — Builder-source resolver.
 *
 * The drift (D1) and generalisation (D3) detectors operate on the BUILDER
 * prompt text. This resolves WHICH text to scan, in priority order:
 *
 *   1. explicit text passed by the caller (e.g. the client pastes/edits it);
 *   2. a file path from env `BUILDER_REVIEW_SOURCE_PATH` (fail-loud if set but
 *      unreadable — an operator who points at a file expects it to exist);
 *   3. the DEFAULT — the live in-repo generator prompt, assembled by
 *      concatenating the exported system-prompt constants from intake-prompt.ts.
 *
 * Topic-agnostic: no hardcoded sample/Uploads path in production code. The unit
 * tests feed a committed fixture directly via the explicit-text path, so the
 * reproducible sample findings never depend on this resolver's default.
 */
import fs from "node:fs";
import path from "node:path";
import {
  INTAKE_SYSTEM_PROMPT,
  DRAFTING_SYSTEM_PROMPT_HEAD,
  CHUNKED_SKELETON_SYSTEM_PROMPT,
  CHUNKED_MEASURES_SYSTEM_PROMPT,
} from "./intake-prompt.js";

export type BuilderSourceOrigin = "explicit" | "env-file" | "in-repo-default";

export interface ResolvedBuilderSource {
  text: string;
  origin: BuilderSourceOrigin;
  detail: string; // human-readable provenance (path, or which constants were used)
}

/**
 * Assemble the live in-repo builder prompt from the exported generator
 * constants. This is the text a drift/generalisation audit should scan when no
 * explicit source is supplied — it reflects what the engine ACTUALLY ships, so
 * findings describe the real builder (not a stale sample).
 */
export function assembleInRepoBuilderPrompt(): string {
  return [
    "# INTAKE_SYSTEM_PROMPT",
    INTAKE_SYSTEM_PROMPT,
    "",
    "# DRAFTING_SYSTEM_PROMPT_HEAD",
    DRAFTING_SYSTEM_PROMPT_HEAD,
    "",
    "# CHUNKED_SKELETON_SYSTEM_PROMPT",
    CHUNKED_SKELETON_SYSTEM_PROMPT,
    "",
    "# CHUNKED_MEASURES_SYSTEM_PROMPT",
    CHUNKED_MEASURES_SYSTEM_PROMPT,
  ].join("\n");
}

export function resolveBuilderSource(explicitText?: string): ResolvedBuilderSource {
  if (typeof explicitText === "string" && explicitText.trim()) {
    return { text: explicitText, origin: "explicit", detail: "caller-supplied builder text" };
  }
  const envPath = process.env.BUILDER_REVIEW_SOURCE_PATH;
  if (envPath && envPath.trim()) {
    const abs = path.resolve(envPath);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch (e: any) {
      // Fail-loud: an operator who sets the env var expects that exact file.
      throw new Error(
        `[builder-source] BUILDER_REVIEW_SOURCE_PATH is set to ${abs} but it could not be read: ${e?.message || e}`,
      );
    }
    return { text, origin: "env-file", detail: abs };
  }
  return {
    text: assembleInRepoBuilderPrompt(),
    origin: "in-repo-default",
    detail:
      "assembled from intake-prompt.ts (INTAKE_SYSTEM_PROMPT + DRAFTING_SYSTEM_PROMPT_HEAD + CHUNKED_SKELETON_SYSTEM_PROMPT + CHUNKED_MEASURES_SYSTEM_PROMPT)",
  };
}
