/**
 * Anthropic image / vision INPUT-TOKEN cost model.
 *
 * Anthropic bills images by 28×28-pixel PATCHES, not by a pixel ratio: an image
 * costs `⌈width/28⌉ × ⌈height/28⌉` visual tokens, computed AFTER the image is
 * downscaled to fit the model tier's long-edge and visual-token limits.
 * (The older `(width×height)/750` figure was a ~4–5% continuous approximation of
 * this same 28²=784 px²/patch grid; it is no longer the documented formula.)
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
 *
 * This module is the single source of truth for that math. It is the *documented
 * provider formula* only — any gate conservatism (safety margin) lives at the
 * gate, not here, so this stays honest about what Anthropic actually charges.
 */

/** One visual token per 28×28-pixel patch. Also the Qwen2-VL grid; NOT OpenAI's
 *  32-px patch / 512-px tile model — keep those on the OpenAI path only. */
export const ANTHROPIC_PATCH_PX = 28;

export interface AnthropicVisionProfile {
  readonly tier: 'high-res' | 'standard';
  /** Neither side may exceed this after downscale (px). */
  readonly maxLongEdge: number;
  /** ⌈w/28⌉×⌈h/28⌉ may not exceed this after downscale (visual tokens). */
  readonly maxVisualTokens: number;
}

/** Model bases on Anthropic's high-resolution tier (max long edge 2576 px, max
 *  4784 visual tokens). Everything else is standard (1568 px / 1568 tokens).
 *  Source: the Vision docs resolution-tier table. */
const HIGH_RES_BASES = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
] as const;

const HIGH_RES: AnthropicVisionProfile = { tier: 'high-res', maxLongEdge: 2576, maxVisualTokens: 4784 };
const STANDARD: AnthropicVisionProfile = { tier: 'standard', maxLongEdge: 1568, maxVisualTokens: 1568 };

/** Resolve a model's vision tier. Unknown/blank models fall back to the
 *  conservative (smaller) standard tier. Matches exact base or `<base>-suffix` /
 *  `<base>[variant]` so aliases (e.g. `claude-fable-5-high`, `...[1m]`) tier alike. */
export function anthropicVisionProfile(model: string | null | undefined): AnthropicVisionProfile {
  const m = (model ?? '').toLowerCase();
  const isHighRes = HIGH_RES_BASES.some((b) => m === b || m.startsWith(`${b}-`) || m.startsWith(`${b}[`));
  return isHighRes ? HIGH_RES : STANDARD;
}

/** Raw 28-px patch count for a `w×h` image, i.e. the visual-token cost when the
 *  image already fits the tier limits (no downscale). `⌈w/28⌉` inherently pads
 *  the right/bottom edge up to the next 28-px multiple, as Anthropic documents. */
export function patchTokens(width: number, height: number): number {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  return Math.ceil(w / ANTHROPIC_PATCH_PX) * Math.ceil(h / ANTHROPIC_PATCH_PX);
}

/**
 * Anthropic visual-token cost of an image at `width×height` for `model`'s tier.
 * Applies the documented downscale — the largest aspect-preserving size that
 * satisfies BOTH the long-edge limit and the visual-token budget — then the
 * 28-px patch count. Matches Anthropic's reference `count_image_tokens`.
 *
 * Note: pxpipe's own pages are always ≤ 1568×728, so neither clamp ever fires
 * for proxy output (both tiers charge the raw patch count). The downscale exists
 * for correctness as a general-purpose estimator (e.g. arbitrary export input).
 */
export function anthropicVisionTokens(
  model: string | null | undefined,
  width: number,
  height: number,
): number {
  const { maxLongEdge, maxVisualTokens } = anthropicVisionProfile(model);
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));

  // 1. Long-edge clamp (aspect-preserving).
  const longEdge = Math.max(w, h);
  if (longEdge > maxLongEdge) {
    const s = maxLongEdge / longEdge;
    w = Math.max(1, Math.floor(w * s));
    h = Math.max(1, Math.floor(h * s));
  }

  // 2. Visual-token-budget clamp (aspect-preserving). Seed with the continuous
  //    solution (patch area ≈ w·h / 28²) then step the scale down to absorb the
  //    per-edge ceil overshoot. Bounded; converges in a few dozen steps.
  if (patchTokens(w, h) > maxVisualTokens) {
    const w0 = w;
    const h0 = h;
    let s = Math.min(1, Math.sqrt((maxVisualTokens * ANTHROPIC_PATCH_PX * ANTHROPIC_PATCH_PX) / (w0 * h0)));
    const step = 1 / Math.max(w0, h0);
    for (
      let i = 0;
      i < 4096 &&
      s > 0 &&
      patchTokens(Math.max(1, Math.floor(w0 * s)), Math.max(1, Math.floor(h0 * s))) > maxVisualTokens;
      i++
    ) {
      s -= step;
    }
    w = Math.max(1, Math.floor(w0 * Math.max(s, 0)));
    h = Math.max(1, Math.floor(h0 * Math.max(s, 0)));
  }

  return patchTokens(w, h);
}
