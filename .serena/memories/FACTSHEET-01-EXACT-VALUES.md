Last commit: 77a10e0

# Factsheet — exact-string extraction — `src/core/factsheet.ts`

Purpose: precision-critical, hard-to-OCR strings (paths, URLs, SHAs/UUIDs,
version numbers, CLI flags, large numbers, CONST_IDS) ride as plain text next
to imaged content instead of being trusted to OCR/recall
(`factsheet.ts:5-6`).

## Budget

- `MAX_TOKENS = 64` (`factsheet.ts:44`) — global cap on kept exact-value
  tokens.
- `MAX_URLS = 8` (`factsheet.ts:47`) — URLs get at most this many exemplars
  (long, structured, low OCR-risk, so capped rather than fully kept).

## Priority tiers (by token SHAPE, not length) — `factsheet.ts:52-77`

- **Tier 0** (protect always, never evicted): matches any of
  `SHAPE_HEX` (git SHA / opaque hex, 7-40 chars, `factsheet.ts:58`),
  `SHAPE_UUID` (`factsheet.ts:57`), `SHAPE_CONST` (`CONST_IDS`/env var names,
  `factsheet.ts:59`), `SHAPE_TICKET` (`PROJ-1482`/`CVE-2024-30078` style,
  `factsheet.ts:60`), `SHAPE_FLAG` (CLI flag, `factsheet.ts:61`), `SHAPE_NUM`
  (port / large or separated number / decimal, `factsheet.ts:62`).
- **Tier 1**: everything else that isn't a URL, including camelCase/PascalCase
  identifiers with ≥2 case humps (comment example: `tokenLedgerShard`,
  `factsheet.ts:33-36`) and file paths — deliberately tier-1 (not tier-0) so
  tier-0 zero-redundancy identifiers are never evicted by camelCase noise.
- **Tier 2**: `SHAPE_URL` (`^https?://`, `factsheet.ts:63,77`), capped at
  `MAX_URLS = 8` and kept last (`factsheet.ts:153,210`:
  `if (tier === 2 && urls++ >= MAX_URLS) continue;`).

Rationale comment (`factsheet.ts:52-56`): budget priority is by shape, not
length — "length is anti-correlated with importance: a short hex SHA or a
port has zero redundancy and fails silently when misread," so short opaque
identifiers outrank long URLs when the budget is tight. Comparator is
total-order → deterministic → cache-stable output.

## Global budget pass

A single priority-budget selection pass runs across all pages so a tier-0
identifier discovered on a later page is never evicted by many tier-1 tokens
from an earlier page (`factsheet.ts:169,201-202`, applied again at
`factsheet.ts:209`).

Used by `src/core/export.ts`: "factsheet.txt is the authoritative source of
truth for all exact strings" (`export.ts:382`).
