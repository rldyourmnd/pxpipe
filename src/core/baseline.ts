/**
 * Cache-aware baseline math for the unproxied counterfactual.
 *
 * Answers, per turn: "if the user had sent the ORIGINAL request (no pxpipe),
 * what would Anthropic bill MORE than pxpipe actually paid?"
 *
 * THE PRINCIPLE (prefix cancellation). The unproxied path and pxpipe send the
 * SAME conversation. The cached prefix (system + tools + frozen history) is
 * byte-stable and cached IDENTICALLY on both paths, so it contributes the same
 * cc/cr to both bills and CANCELS. This is not a theory — it's confirmed by
 * production /cost: a pxpipe run billed cache_read 109.5k vs the same task's
 * unproxied run 108.1k (within noise). pxpipe's ONLY creditable lever is the
 * per-turn NEW (uncached) content it compresses away. We credit exactly that
 * and no more — the saving is the honest `baseline_eff − actual_eff` with NO
 * floor: usually >= 0, honestly 0% when there's nothing to credit, and NEGATIVE
 * on a turn that net-lost (e.g. a cc-heavy image-cache rewrite costs more than
 * the text prefix it replaced). We report the real loss rather than fabricate a
 * >=0 floor. (A probe-miss turn — no cacheable baseline — falls back to actual,
 * i.e. exactly 0 saving.) The dashboard renders negatives with a `.neg` style;
 * see sessions.ts (per-session rollup) and tests/sessions.test.ts (the −8960 case).
 *
 * History: two prior versions BOTH over-credited. v1 inferred the unproxied
 * cache class from the proxied (cc, cr) — pxpipe's image churn (cc>0, cr=0)
 * faked a cold write. v2 keyed warmth off "the session's first observed turn is
 * cold" — but a session that resumes against a hot cache reads warm on turn 0,
 * so that, too, fabricated a cacheable*1.25 cold write (62% of a real 69.6%
 * headline that was actually ~0%; see the 2026-06-16 dashboard audit). The
 * warmth flag is GONE; this version is warmth-free and deterministic.
 *
 * Workers-safe: no node:, no Buffer, no process.*. Pure number math.
 */

/** Anthropic input-token price multipliers we use for cost-weighting.
 *  These are the documented per-token rates relative to the base input
 *  rate (cache_create_5m at 1.25×, cache_read at 0.1×). Centralized so a
 *  future rate change is a one-line edit. The 1-hour cache tier (2×) is
 *  not yet used by Claude Code's default config; we'd add a parameter
 *  here when it is. */
export const CACHE_CREATE_RATE = 1.25;
export const CACHE_READ_RATE = 0.1;

/**
 * Cache-aware baseline-eff for the UNPROXIED counterfactual.
 *
 * The counterfactual is "the SAME body sent as TEXT (no pxpipe)":
 *
 *   baseline_eff = cacheable × CACHE_READ_RATE   ← unproxied reads its (larger,
 *                                                   TEXT) cacheable prefix warm
 *                + coldTail   × 1.0              ← + the uncached new-content tail
 *   where cacheable = min(baselineCacheable, baseline), coldTail = baseline − cacheable
 *
 * The saving is then `baseline_eff − actual_eff`, and it surfaces pxpipe's REAL
 * compression: pxpipe's actual `cache_read` is the IMAGE prefix — measured ~67%
 * FEWER tokens than `baselineCacheable`, the TEXT prefix — and both are billed at
 * CACHE_READ_RATE, so the difference is a genuine saving. (Production: image
 * prefix / text prefix ≈ 0.33 median over 7k+ warm requests.)
 *
 * History of two bugs this version fixes:
 *  - OVER-credit (the old "59–70%"): billed the cacheable prefix at the 1.25×
 *    COLD-write rate on a session's first turn. The cache is almost always already
 *    warm (cross-session persistence), so that 1.25× write never happened — it
 *    fabricated ~62% of the headline. We bill the prefix at CACHE_READ_RATE only;
 *    no cold-write term, so nothing is invented (slightly under-credits the genuine
 *    one-time write instead — the safe direction).
 *  - UNDER-credit (the "cancel → 0%" interlude): wrongly assumed the prefix is
 *    identical on both paths and cancels. It does NOT — pxpipe's image prefix is
 *    FEWER tokens than the text prefix; that gap is the whole point. Restored here.
 *  - `baselineCacheable ≤ 0` (probe miss): cannot split prefix from tail, so credit
 *    NOTHING (return actual_eff) rather than bill the whole body cold (old fabrication).
 *
 * WEIGHTING NOTE (one math, not two): CACHE_READ_RATE = 0.1 is Anthropic's
 * documented API price ratio. A subscription's weekly/5h usage cap is a cost-
 * weighted tally at the SAME ratios, EXCEPT the cache_read weight there may be
 * lower (possibly ~0, if the cap inherits the rate-limit "cache reads don't count"
 * rule — Anthropic doesn't publish it). Since pxpipe's compression lands almost
 * entirely in cache_read, a lower cap-weight only moves the headline toward 0 —
 * never negative in raw-token terms. We report the documented 0.1× and caption the
 * caveat rather than guess a second number.
 *
 * @param baseline           count_tokens on the ORIGINAL (pre-compression) body.
 * @param baselineCacheable  count_tokens on the original truncated at the last
 *                           cache_control marker. ≤0 ⇒ credit nothing.
 * @param inputTokens        fresh (uncached) input tokens pxpipe actually billed.
 * @param cc                 cache_create tokens pxpipe actually billed.
 * @param cr                 cache_read tokens pxpipe actually billed.
 */
export function computeBaselineInputEff(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
): number {
  if (baseline <= 0) return 0;
  // Untrustworthy prefix probe: cannot split cached prefix from new tail, so the
  // honest counterfactual is "same as actual" — credit nothing. (This is exactly
  // where the old cacheable=0 → cold_tail=baseline path fabricated huge savings.)
  if (baselineCacheable <= 0) return computeActualInputEff(inputTokens, cc, cr);
  const cacheable = Math.min(baselineCacheable, baseline);
  const coldTail = baseline - cacheable;
  return cacheable * CACHE_READ_RATE + coldTail * 1.0;
}

/**
 * Companion: the weighted INPUT cost the proxied path actually paid this
 * turn. Centralized so all three consumers (live dashboard, JSONL replay,
 * per-session rollup) use one definition.
 */
export function computeActualInputEff(
  inputTokens: number,
  cc: number,
  cr: number,
): number {
  return inputTokens + cc * CACHE_CREATE_RATE + cr * CACHE_READ_RATE;
}
