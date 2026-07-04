Last commit: 77a10e0

# Anthropic vision cost model — `src/core/anthropic-vision.ts`

Single source of truth for Anthropic's documented image-billing formula
(not the gate's conservatism — that lives in `transform.ts`).

## Formula

Anthropic bills images by 28×28-pixel patches: `⌈w/28⌉ × ⌈h/28⌉` visual tokens,
computed AFTER downscaling to fit the model tier's long-edge and visual-token
limits (`src/core/anthropic-vision.ts:1-15`).

- `ANTHROPIC_PATCH_PX = 28` (`anthropic-vision.ts:19`).
- `patchTokens(width, height)` = `Math.ceil(w/28) * Math.ceil(h/28)`
  (`anthropic-vision.ts:55-59`), the raw cost when no downscale is needed.
- The retired `(width×height)/750` figure is documented in-file as only a
  "~4-5% continuous approximation" of the same 28² px²/patch grid — "no longer
  the documented formula" (`anthropic-vision.ts:7-8`).

## Tiers (`anthropic-vision.ts:29-41`)

- `HIGH_RES_BASES` (high-res tier: `maxLongEdge=2576`, `maxVisualTokens=4784`):
  `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-opus-4-7`,
  `claude-sonnet-5`.
- Everything else → `STANDARD` tier: `maxLongEdge=1568`, `maxVisualTokens=1568`.
- `anthropicVisionProfile(model)` matches exact base, `<base>-suffix`, or
  `<base>[variant]` (e.g. `claude-fable-5-high`, `claude-fable-5[1m]`); unknown
  or blank models fall back to the smaller `STANDARD` tier (`anthropic-vision.ts:43-50`).

## Resize path

`resizedSize(w, h, maxLongEdge, maxVisualTokens)` (`anthropic-vision.ts:75-96`)
recurses with a swap for portrait images, then binary-searches the largest long
edge (short edge = `round(long × aspect)`) that still satisfies `fitsTier`
(`anthropic-vision.ts:64-70`, both the padded-patch long-edge check and the
patch-count budget). Original size is returned unchanged if it already fits.

`anthropicVisionTokens(model, width, height)` (`anthropic-vision.ts:109-119`)
applies the resize then returns `patchTokens(rw, rh)`.

**pxpipe's own rendered pages are always ≤ 1568×728** (see
`mem:RENDER-01-GEOMETRY`), so the resize path never fires for proxy output —
both tiers charge the raw patch count. The resize path exists for correctness
as a general-purpose estimator (e.g. arbitrary `pxpipe export` input), per the
doc comment at `anthropic-vision.ts:105-107`.

## Gate usage

The compression-profitability gate in `src/core/transform.ts` computes its own
image-token estimate via `imageTokensForRows` (`transform.ts:208-238`), which
sums per-image patch tokens and applies `ANTHROPIC_GATE_MARGIN = 1.10`
(`transform.ts:190`) on top: `Math.ceil(patchSum * ANTHROPIC_GATE_MARGIN)`
(`transform.ts:238`). The margin is gate-side conservatism, deliberately kept
out of `anthropic-vision.ts` so that module stays an honest statement of what
Anthropic actually charges.
