Last commit: 77a10e0

# Model allowlist and routing — `src/core/applicability.ts`

## Default scope

`DEFAULT_MODEL_BASES = ['claude-fable-5', 'gpt-5.6']` (`applicability.ts:33`),
used when `PXPIPE_MODELS` env is unset or empty
(`envOrDefaultBases`, `applicability.ts:44-52`).

Resolution order (`applicability.ts:39-52`, read per-call so scope can flip
live):
- unset or empty `PXPIPE_MODELS` → built-in default (`claude-fable-5` +
  `gpt-5.6`)
- `PXPIPE_MODELS` matching `/^(0|false|no|off|none)$/i` (falsey helper,
  `applicability.ts:35-37`) → compress nothing
- otherwise → CSV of model bases, split on `,` and trimmed

A separate in-memory `runtimeModelBases` override (settable via
`setAllowedModelBases`, cleared by passing `null`) takes precedence over the
env/default when non-null — this is the dashboard's live toggle, not
persisted (`applicability.ts:25,54-56,71-73`).

`getAllowedModelBases()` returns the effective scope (override-or-env);
`getConfiguredModelBases()` returns the env/default independent of the
runtime override, used by the dashboard to union in env-enabled models as
chips even when overridden (`applicability.ts:59-68`).

## Opt-in / excluded models

Comment at `applicability.ts:27-32`: GPT 5.5 and Opus 4.8 are intentionally
excluded from the default scope — "same pipeline but measurably worse at
reading imaged content" — citing `FINDINGS.md` 2026-06-16: "Opus 4.8 ~2pp
arithmetic, 6/15 dense-hex recall vs Fable's 100/100; GPT 5.5 likewise
degrades on imaged history/context". Both stay opt-in via dashboard chips or
`PXPIPE_MODELS`.

`src/core/anthropic-vision.ts:35-36` lists both `claude-opus-4-8` and
`claude-opus-4-7` in its high-res-tier base list (`HIGH_RES_BASES`), but only
Opus 4.8 is named in the applicability opt-in comment; Opus 4.7 is not
separately called out there. Verify current `applicability.ts` comment text
before asserting Opus 4.7's opt-in status explicitly — the vision-tier list
and the model-allowlist default are two different mechanisms (tier profile
vs. eligibility).

`FINDINGS.md:143-148` (a separate, more recent eval than the `2026-06-16`
citation above) reports a Fable-5-vs-Opus-4-8 arithmetic read eval
(`eval/gsm8k/` harness, N=100, same images): text baseline 100/100 both arms;
pxpipe-imaged: Opus 4-8 93/100, Fable-5 **100/100**. `FINDINGS.md:144-145`:
"Fable 5 launched today; ran the clean evals against it the same day and
narrowed the production gate from Opus 4.7+ to `claude-fable-5` only."

## Model matching

`isAllowed(model)` (`applicability.ts:77-81`) strips `[variant]` tags via
`VARIANT_TAG = /\[[^\]]*\]/g` (`applicability.ts:18`) before matching exact
base or `<base>-suffix` against the allowed list. Both
`isPxpipeSupportedModel` (Anthropic) and `isPxpipeSupportedGptModel` (GPT)
delegate to the same `isAllowed` — one CSV/scope controls every model family
(`applicability.ts:83-91`).

## Path routing

`isAnthropicMessagesPath(pathname)` (`applicability.ts:99-103`) is the single
canonical set of Anthropic Messages routes, shared between this module and
`createProxy` in `src/core/proxy.ts` so they can never disagree: exact matches
only — `/v1/messages`, `/anthropic/v1/messages`, `/anthropic/messages` —
`/v1/messages/count_tokens` is explicitly NOT matched.

`shouldTransformAnthropicMessages(input)` (`applicability.ts:105-121`) chains
method (`POST` only), path (`isAnthropicMessagesPath`), body-bytes (`> 0`),
and model checks, returning `{ eligible, reason }` with `reason` one of
`'eligible' | 'unsupported_model' | 'unsupported_method' | 'unsupported_path'
| 'empty_body'`.
