import { describe, it, expect } from 'vitest';
import {
  anthropicVisionProfile,
  anthropicVisionTokens,
  patchTokens,
  ANTHROPIC_PATCH_PX,
} from '../src/core/anthropic-vision.js';

// Anthropic bills images by 28×28-pixel patches: ⌈w/28⌉×⌈h/28⌉ visual tokens,
// after downscaling to the model tier's long-edge (1568/2576) and token-budget
// (1568/4784) limits. Numbers below are cross-checked against Anthropic's own
// worked cost table (platform.claude.com/docs/en/build-with-claude/vision).

describe('patchTokens — raw 28-px patch count', () => {
  it('is one token per full 28×28 patch, padding partial edges up', () => {
    expect(ANTHROPIC_PATCH_PX).toBe(28);
    expect(patchTokens(28, 28)).toBe(1);
    expect(patchTokens(29, 29)).toBe(4); // ⌈29/28⌉² = 2² = 4
    expect(patchTokens(1000, 1000)).toBe(1296); // 36² (docs worked example)
    expect(patchTokens(1568, 728)).toBe(1456); // 56×26 — pxpipe's full dense page
    expect(patchTokens(1928, 1928)).toBe(4761); // 69² (old page, high-res)
  });
});

describe('anthropicVisionProfile — tier by model', () => {
  it('puts the documented high-res models on the 2576/4784 tier', () => {
    for (const m of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5']) {
      expect(anthropicVisionProfile(m).tier).toBe('high-res');
    }
    // aliases / variant tags tier with their base
    expect(anthropicVisionProfile('claude-fable-5-high').tier).toBe('high-res');
    expect(anthropicVisionProfile('claude-opus-4-8[1m]').tier).toBe('high-res');
    expect(anthropicVisionProfile('claude-fable-5')).toEqual({ tier: 'high-res', maxLongEdge: 2576, maxVisualTokens: 4784 });
  });

  it('falls back to the conservative standard 1568/1568 tier otherwise', () => {
    for (const m of ['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet', '', undefined, null]) {
      expect(anthropicVisionProfile(m as string).tier).toBe('standard');
    }
    expect(anthropicVisionProfile('claude-opus-4-5')).toEqual({ tier: 'standard', maxLongEdge: 1568, maxVisualTokens: 1568 });
  });
});

describe('anthropicVisionTokens — documented cost with downscale', () => {
  it('charges the raw patch count when the image already fits (no clamp)', () => {
    // pxpipe's full dense page fits on BOTH tiers unchanged.
    expect(anthropicVisionTokens('claude-fable-5', 1568, 728)).toBe(1456);
    expect(anthropicVisionTokens('claude-opus-4-5', 1568, 728)).toBe(1456);
    // 1000×1000 fits both tiers.
    expect(anthropicVisionTokens('claude-fable-5', 1000, 1000)).toBe(1296);
    expect(anthropicVisionTokens('claude-opus-4-5', 1000, 1000)).toBe(1296);
  });

  it('leaves a big image unchanged on the high-res tier when it fits 2576/4784', () => {
    // 1928² (old page): padded 1932 ≤ 2576 and 4761 ≤ 4784 → unchanged.
    expect(anthropicVisionTokens('claude-fable-5', 1928, 1928)).toBe(4761);
    // 1568² fits high-res (3136 ≤ 4784, 1568 ≤ 2576).
    expect(anthropicVisionTokens('claude-fable-5', 1568, 1568)).toBe(3136);
  });

  it('downscales to the token budget on the standard tier', () => {
    // 1568² standard: 3136 > 1568 budget → shrinks to a 39×39 = 1521-token image.
    expect(anthropicVisionTokens('claude-opus-4-5', 1568, 1568)).toBe(1521);
    // 1928² standard: edge-clamp to 1568² then budget-clamp → 1521.
    expect(anthropicVisionTokens('claude-opus-4-5', 1928, 1928)).toBe(1521);
  });

  it('caps at the tier budget for very large images', () => {
    // 3840×2160 high-res: edge-clamps to 2576 long edge, lands exactly on the 4784 cap.
    expect(anthropicVisionTokens('claude-fable-5', 3840, 2160)).toBe(4784);
    // Any result must never exceed the tier's visual-token budget.
    for (const [w, h] of [[8000, 8000], [4000, 500], [500, 4000]] as const) {
      expect(anthropicVisionTokens('claude-fable-5', w, h)).toBeLessThanOrEqual(4784);
      expect(anthropicVisionTokens('claude-opus-4-5', w, h)).toBeLessThanOrEqual(1568);
    }
  });

  it('is ~4–5% below the retired w×h/750 approximation for standard-tier pages', () => {
    // The old gate used ceil(w*h/750). Patch is the exact grid it approximated.
    const legacy750 = Math.ceil((1568 * 728) / 750); // 1522
    expect(anthropicVisionTokens('claude-fable-5', 1568, 728)).toBeLessThan(legacy750);
    expect(legacy750 - anthropicVisionTokens('claude-fable-5', 1568, 728)).toBeLessThan(legacy750 * 0.06);
  });
});
