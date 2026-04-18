# agent.md

## Purpose

This project automates monthly rental income management in two stages:

1. **Extraction** — logs into the Nido ADM client area, extracts monthly **Extrato de Repasse** data with Playwright, and writes **one JSON file per payment source** into `output/`. Also generates files for self-managed properties defined in `manual-payments.json`.
2. **Registration** — logs into the Receita Federal **Carnê-Leão** website and registers each payment from `output/` as a rendimento, filling the form and waiting for manual confirmation before submitting.

## Stack

- Node.js
- CommonJS modules
- Playwright
- chalk (v4), inquirer (TUI)

## Main scripts

- `npm run save-session`
  - Opens the Nido login page
  - Optionally auto-fills credentials from `.env.local`
  - Waits for manual captcha/login completion
  - Saves session state to `storage/auth.json`

- `npm run extract-repasses`
  - Reuses `storage/auth.json`
  - Opens `Extrato de Repasse` for the previous month
  - Extracts all paid repasses and writes one JSON file per source into `output/`
  - Also generates output files for properties in `manual-payments.json`

- `npm run save-session-carne-leao`
  - Opens the Receita Federal login page using real system Chrome
  - Waits for manual login (including captcha/gov.br auth)
  - Saves session state to `storage/carne-leao-auth.json`

- `npm run register-rendimentos`
  - Reuses `storage/carne-leao-auth.json`
  - Shows a TUI summary of all payments in `output/`
  - For each payment: navigates to the Carnê-Leão form, fills all fields, then waits for manual submit + confirmation
  - Use `--dry-run` (`npm run register-rendimentos:dry`) to preview without opening a browser

- `npm run check`
  - Syntax-checks the current scripts

## Credentials

Credentials must stay local and out of tracked files.

Use:

- `.env.local`
- or environment variables

Supported keys:

- `NIDO_USERNAME`
- `NIDO_PASSWORD`

Template:

```env
NIDO_USERNAME=
NIDO_PASSWORD=
```

`.env.local` is gitignored.

## Important files

- `scripts/save-session.js` — Nido manual-login bootstrap
- `scripts/extract-repasses.js` — monthly extraction + manual payment generation
- `scripts/save-session-carne-leao.js` — Carnê-Leão login bootstrap (real Chrome)
- `scripts/register-rendimentos.js` — Carnê-Leão form automation with TUI
- `scripts/lib.js` — shared helpers
- `storage/auth.json` — saved Nido session
- `storage/carne-leao-auth.json` — saved Carnê-Leão session
- `manual-payments.json` — config for self-managed properties (rent, IPTU, Seguro, paymentDay)
- `output/` — flat directory with one JSON file per source

## Output format

Each file in `output/` represents a single payment source.

Typical root fields:

- `generatedAt`
- `reference`
- `transfer`
- `totals`
- `contractId`
- `propertyId`
- `address`
- `tenantName`
- `total` / `totalValue`
- `discounts` / `discountsValue`
- `remainingAmount`
- `lineItems`

Filenames are month-prefixed, for example:

- `03-2026-6997-05-...json`
- `03-2026-manual-rua-ida-verdi-...json`

## Deduction rules (register-rendimentos)

Only these `lineItems` descriptions count toward `valorDeducao` on the Carnê-Leão form:

- Contains `"Taxa ADM"` (management fee)
- Contains `"IPTU"`
- Matches `/seguro/i` (insurance)

## Operational notes

- Captcha is not automated — login is always manual.
- Carnê-Leão requires real system Chrome (`/opt/google/chrome/chrome`) to avoid bot detection.
- If either session expires, rerun the corresponding `save-session` script.
- The extractor expects Nido's existing HTML/table structure for `Extrato de Repasse`.

## Safe change guidelines

- Keep output flat in `output/`
- Preserve one-file-per-source behavior
- Do not add tracked secrets
- Prefer updating existing scripts over creating parallel alternatives unless behavior really differs
- Validate changes with `npm run check`
