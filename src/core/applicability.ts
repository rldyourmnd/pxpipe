/** Applicability helpers for pxpipe's production-safe model scope. */

export type PxpipeApplicabilityReason =
  | 'eligible'
  | 'unsupported_model'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'empty_body';

export interface PxpipeApplicabilityInput {
  readonly model?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly bodyBytes?: number | null;
}

/** Bracketed variant tags that don't change reading behavior and so must not
 *  affect the gate — e.g. the context-window tag in `claude-opus-4-8[1m]`.
 *  Stripped before matching so a base model and its `[1m]` form gate alike. */
const VARIANT_TAG = /\[[^\]]*\]/g;

function baseModelId(model: string): string {
  return model.replace(VARIANT_TAG, '');
}

/** Runtime override of the allowed-model scope, set from the dashboard
 *  ("compress models" chips). `null` = no override → fall back to the
 *  `PXPIPE_MODELS` env (or the built-in default). In-memory only; a restart
 *  drops it and the env/default scope applies again. */
let runtimeModelBases: readonly string[] | null = null;

/** Base model ids pxpipe is allowed to transform. Resolution order, read per
 *  call so the scope can be flipped LIVE (no rebuild/restart):
 *    1. runtime override (dashboard chips), if set
 *    2. `PXPIPE_MODELS` env (comma-separated)
 *    3. built-in default: **Fable 5 only**.
 *
 *  Opus 4.8 is OFF by default (opt-in via the dashboard or PXPIPE_MODELS): it
 *  uses the identical pipeline/render, but reads imaged content at a measurable
 *  tax (FINDINGS.md 2026-06-16: ~2pp arithmetic, 6/15 dense-hex recall vs
 *  Fable's 100/100, 13/15), so silently compressing the operator's main driver
 *  is the wrong default. Examples:
 *    PXPIPE_MODELS=claude-fable-5                 # Fable only (the default)
 *    PXPIPE_MODELS=claude-fable-5,claude-opus-4-8 # add Opus */
/** The CONFIGURED scope — `PXPIPE_MODELS` env (comma-separated) or the built-in
 *  Fable-only default — IGNORING any dashboard runtime override. */
function envOrDefaultBases(): string[] {
  const raw = process.env.PXPIPE_MODELS;
  return (raw && raw.trim() ? raw : 'claude-fable-5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function allowedModelBases(): string[] {
  if (runtimeModelBases !== null) return [...runtimeModelBases];
  return envOrDefaultBases();
}

/** Current effective allowed-model scope (runtime override ?? env ?? default). */
export function getAllowedModelBases(): string[] {
  return allowedModelBases();
}

/** The configured base scope (`PXPIPE_MODELS` env, or the Fable-only default),
 *  independent of the dashboard runtime override. The dashboard unions this into
 *  its chip set so every env-enabled model is always offered as a toggle —
 *  even one switched off at runtime — instead of vanishing once it leaves the
 *  active scope. */
export function getConfiguredModelBases(): string[] {
  return envOrDefaultBases();
}

/** Set the runtime allowed-model scope from the dashboard. An empty array means
 *  compress NO models (scope off); `null` clears the override and falls back to
 *  the env/default. In-memory only — not persisted across restart. */
export function setAllowedModelBases(list: readonly string[] | null): void {
  runtimeModelBases = list === null ? null : list.map((s) => s.trim()).filter(Boolean);
}

/** True when pxpipe is allowed to transform requests for this model. A model
 *  matches an allowed base when it equals the base or extends it with a
 *  `-suffix` alias (`claude-fable-5-high`) — hosts may send either the client
 *  alias or the resolved upstream id. Bracketed variant tags (`[1m]`) are
 *  stripped first so `claude-opus-4-8[1m]` matches its base. */
export function isPxpipeSupportedModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model);
  return allowedModelBases().some((b) => base === b || base.startsWith(`${b}-`));
}

/** GPT image-tokenization has not been validated across the whole OpenAI
 *  model matrix. Keep the new OpenAI path scoped to the requested GPT 5.5
 *  family until production telemetry says it is safe to widen. */
export function isPxpipeSupportedGptModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^gpt-5\.5(?:-|$)/.test(model);
}

export function shouldTransformAnthropicMessages(
  input: PxpipeApplicabilityInput,
): { eligible: boolean; reason: PxpipeApplicabilityReason } {
  if (input.method !== undefined && input.method !== null && input.method.toUpperCase() !== 'POST') {
    return { eligible: false, reason: 'unsupported_method' };
  }
  if (input.path !== undefined && input.path !== null && !input.path.endsWith('/v1/messages')) {
    return { eligible: false, reason: 'unsupported_path' };
  }
  if (input.bodyBytes !== undefined && input.bodyBytes !== null && input.bodyBytes <= 0) {
    return { eligible: false, reason: 'empty_body' };
  }
  if (!isPxpipeSupportedModel(input.model)) {
    return { eligible: false, reason: 'unsupported_model' };
  }
  return { eligible: true, reason: 'eligible' };
}
