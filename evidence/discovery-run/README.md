# Discovery-run evidence — real, live, LLM-driven

This is the untouched output of one real invocation of `npm run discover`, using
`claude-sonnet-4-5-20250929` against the live `https://www.saucedemo.com`:

```bash
npm run discover -- \
  --goal "Log in, add the Sauce Labs Backpack to the cart, proceed to checkout, fill in the \
shipping information, and reach the checkout overview (review) page showing the order total." \
  --capability-id saucedemo.add_item_and_checkout \
  --param username=standard_user \
  --param password=secret_sauce --redact password \
  --param firstName=Ada --param lastName=Lovelace --param postalCode=94107 \
  --headless
```

- **`log.jsonl`** — one structured entry per turn: the tool the model called, its own
  free-text reasoning (redacted — see below), whether the action succeeded, and a link to that
  turn's screenshot. Ends with a `run_finished` entry (`status: "completed"`).
- **`screenshots/001..011.png`** — one screenshot per turn, in order. `011-turn-10-finish.png`
  is the model's own final observation: the checkout overview page it navigated to entirely on
  its own, showing the same $29.99 / $2.40 / $32.39 line items it reported in its `finish`
  summary.
- **`recorded-artifact.json`** — the `CapabilityArtifact` this run produced (a copy of
  `artifacts/saucedemo.add_item_and_checkout@v1.json` at the moment it was recorded).

## What this run found, and what it proves

The **first** attempt at this run completed the goal correctly but then **failed to record**,
because `recordArtifact`'s `assertNoLeakedSecrets` defense-in-depth check (built in an earlier
phase, before any live model output existed to test it against) caught a real leak: the model's
own reasoning for the password-entry step narrated
`Now I need to enter the password "secret_sauce" into the password field...` — echoing the exact
param value verbatim inside an otherwise-harmless explanatory sentence. `recorder.ts` was copying
that raw reasoning straight into the artifact's `locatorReasoning`/output `description` fields
with no redaction pass, even though the console/JSONL log of the same turn was already correctly
redacted (see the git history / `REPORT.md` for the fix — `redactReasoning` in
`src/artifact/recorder.ts`, with regression tests in `tests/unit/recorder.test.ts`). This run is
the second attempt, after that fix, and recorded successfully with no leak:

```
$ grep -c secret_sauce artifacts/saucedemo.add_item_and_checkout@v1.json evidence/discovery-run/log.jsonl
0
0
```

This is exactly the kind of runtime condition a live run — and only a live run — can surface: no
amount of scripted/mocked testing exercises what a *real* model actually writes in its own
reasoning text.

## Note on this artifact vs. the one in `evidence/artifacts/`

This run's `recorded-artifact.json` shares the same capability id as the hand-authored artifact
in `evidence/artifacts/`, but is a different object: it's `status: "draft"` (as every freshly
recorded artifact starts — see `recorder.ts`'s module doc comment) and has no `expected[]`
business-outcome branches, because discovery only ever demonstrates the happy path it actually
walked; declaring exceptional branches is curation a human adds afterward. `evidence/artifacts/`'s
copy is the already-curated, `status: "approved"` version with those branches added by hand,
which is what `evidence/replay-runs/` actually replays — see `evidence/README.md`'s provenance
note for why.
