# Evidence

This folder is the deliverable required by the assignment brief's §6.3: "a saved example
artifact plus logs from both a discovery run and a replay run." Everything here is real output
from actually running this system's CLIs against the live `saucedemo.com` target — nothing is
hand-crafted to look like a run.

```
evidence/
├── artifacts/
│   └── saucedemo.add_item_and_checkout@v1.json   the example capability artifact
├── discovery-run/
│   ├── README.md                                 what this is + a bug it caught (read this one)
│   ├── log.jsonl / screenshots/                   a real, live, LLM-driven discovery run
│   └── recorded-artifact.json                     the artifact THAT run produced
└── replay-runs/
    ├── success/                                   happy path
    ├── business-outcome-validation-error/         blank postal code
    └── business-outcome-user-locked-out/          locked_out_user account
```

## `artifacts/` — the example capability artifact

`saucedemo.add_item_and_checkout@v1.json` is the artifact all three replay runs below execute.
**Provenance note**: this specific copy was hand-authored (see its own
`provenance.discoveryRunId: "hand-authored-fixture-for-replay-engine-development"`) rather than
produced by a live discovery run, so that the artifact schema, deterministic replay engine, and
error-taxonomy handling (Phases 2–3, 6–7) could be built and tested before Anthropic API access
was available. It is schema-valid, was verified step-by-step against the live target while
authoring it, and every claim it makes about the app's behavior (the exact validation message
text, the locked-out message, the DOM structure) was confirmed by hand against the real site —
it is not fabricated data. It is, however, not itself evidence of a *live LLM-driven discovery
run* — see `discovery-run/` for that, including the actual artifact a real run produced.

## `discovery-run/` — a real, live, LLM-driven run

`log.jsonl` + `screenshots/` + `recorded-artifact.json` from one real `npm run discover`
invocation against the live target, using `claude-sonnet-4-5-20250929` — not scripted, not
mocked. See `discovery-run/README.md` for the exact command and, notably, a real leak this
specific run caught and how it was fixed (the model's own reasoning text echoed a redacted
param's raw value verbatim on its first attempt; `recorder.ts` now redacts free-text reasoning
before it becomes part of an artifact, with regression tests added in
`tests/unit/recorder.test.ts`).

## `replay-runs/` — three real deterministic replays, no LLM involved

Each folder is the untouched output of one real `npm run replay` invocation (see the exact
commands in `/README.md`'s demo path) — a `log.jsonl` with one structured, redacted entry per
step, and a `screenshots/` folder with a real PNG captured at the moment the run concluded.
Together they demonstrate the full three-way `ReplayResult` taxonomy (§3.3) against the same
artifact and the same live target, varying only the input parameters:

| Folder | Input | Result |
|---|---|---|
| `success/` | `username=standard_user`, valid checkout fields | `success`, with typed `itemTotalText`/`taxText`/`totalText` outputs extracted from the live page |
| `business-outcome-validation-error/` | `postalCode=` (blank) | `business_outcome` code `validation_error` — the app's own inline form validation, detected and reported, not a crash |
| `business-outcome-user-locked-out/` | `username=locked_out_user` | `business_outcome` code `user_locked_out` — an anticipated account-state condition, detected at the login step |

Note what's absent from every `log.jsonl`: the `password` parameter's actual value. All three
runs were invoked with `--redact password`, and every logged field is passed through
`redactSensitiveValues` (`src/safety/redaction.ts`) before being written, so the credential typed
into the live login form never appears in any file under `replay-runs/`.
