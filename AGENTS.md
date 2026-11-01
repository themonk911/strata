# Working in Strata

Strata analyzes local Git repositories, visualizes their history as a code city,
and gives agents the same module-boundary facts. Keep the implementation small,
the boundaries meaningful, and measured facts distinct from interpretation.

- Understand the observable behavior and invariants before changing code.
- Find the existing owner of a responsibility before adding another.
- Treat plans and audits as context; verify them against current code.
- Preserve unrelated work in the checkout. Keep changes focused on the task.
- Prefer reducing code and concepts. Keep prompts and tool descriptions lean.
- Edit this file only when the user requests changes to repository guidance.

## Module boundaries and ownership

`strata.config.json` is the authority for declared module gates:

- `core/` owns repository reading, import resolution, boundary analysis, and
  scan/check results. Python consumers import from `core` through
  `core/__init__.py`. `core/parse-js.mjs` is the scanner's internal JS/TS parser.
- `server/` owns local service integrations. Cross-module JS consumers use
  `server/api.mjs`. Keep HTTP handling in `server/index.mjs` focused on transport;
  integration lifecycle, validation, and operations belong with their owners.
- `web/` owns the browser experience. `web/app.js` is its application entry point;
  layout and rendering live behind it. Keep analysis rules in `core/`, rather
  than independently reimplementing them in presentation code.
- `bin/strata.mjs` and `hooks/check.py` adapt CLI and hook inputs to the scanner.
  They should use its operations rather than implement separate boundary rules.

Imports within a declared module can use its internal files. Consumers outside
it should use its public gate or supported CLI. Expose a narrow operation when
needed; do not widen `public` or `allow` just to silence the checker. Inferred
boundaries in scanned repositories are hypotheses, not confirmed design intent.

- Maintain one authoritative implementation of each rule and operation.
- Route callers through the owning API instead of duplicating its logic.
- Keep transport and UI adapters focused on translating inputs and outputs.
- Distinguish low-level file access from operations that also own validation,
  caching, job state, or other side effects. Preserve those effects when moving
  or consolidating code.
- Make invalid states difficult to represent and failures explicit. Do not turn
  parse failures, unavailable checks, or missing data into apparent success.

## Build deep modules

A deep module provides useful functionality behind a small, clear interface
while hiding substantial implementation complexity.

- Design interfaces around what callers need to accomplish.
- Keep validation, sequencing, and internal bookkeeping with the module that
  owns the operation.
- Prefer an operation that completes a coherent task over an interface that
  makes every caller coordinate several implementation steps.
- Keep implementation details private. Callers should not need to understand
  storage layouts, subprocess protocols, cache keys, or lifecycle rules to use
  a module correctly.
- Avoid pass-through wrappers and tiny classes that add navigation without
  hiding complexity or enforcing a useful boundary. A public gate can re-export
  an operation; it does not need an extra wrapper around it.
- Judge design by how much a caller must know, not by file length. Split a large
  file only when it improves responsibility, cohesion, or the interface.
- For example, a scan should own parsing and boundary classification; a service
  operation should own its protocol and cleanup; a renderer should own its
  scene resources. Callers supply intent and consume results.

## Test behavior through stable interfaces

- Add tests when they protect meaningful behavior, a regression, or a failure
  contract. Avoid tests that add little value or unnecessary runtime.
- Exercise real code paths through the smallest appropriate public interface.
  Module APIs count; not every test needs HTTP, a browser, or the whole CLI.
- Assert outcomes, contracts, and meaningful failure behavior. Write tests that
  a bug would break, not ones that only a deliberate rewording would break.
- Tests should survive internal restructuring when behavior is unchanged.
  Do not test private helpers, internal call order, or mock wiring as a
  substitute for behavior. Do not expand a production gate solely for tests.
- Mock external boundaries such as network services, Codex processes, clocks,
  and randomness when needed. Prefer real internal collaborators and isolated
  temporary repositories or storage. Ordinary tests should not require a login,
  an API key, or live paid calls.
- Cover relevant edge cases and failures. For analysis, consider unresolved
  imports, invalid syntax, declared versus inferred gates, and new versus
  pre-existing shortcuts. For stateful integrations, consider cleanup, retries,
  partial failure, and concurrency when they are part of the contract.
- For layout, test useful invariants such as deterministic placement, coverage,
  and non-overlap rather than incidental coordinates or rendering internals.
- Never weaken a test merely to make a change pass. Explain why an expectation
  is wrong before changing it.

## Refactor deliberately

- Refactor when it makes the requested change clearer or safer.
- Work in small, behavior-preserving steps. Keep structural refactoring distinct
  from behavior changes and unrelated cleanup separate.
- Prefer removing duplication and unnecessary concepts to adding frameworks.
- Extract abstractions around a demonstrated shared responsibility.
  Similar-looking code alone does not establish that responsibility.
- Avoid speculative extension points, configuration, and general-purpose
  machinery.
- Complete migrations within the affected scope: update consumers and remove
  obsolete paths when safe. Do not add compatibility layers by default; retain
  compatibility only for an identified consumer or explicit requirement.

A successful refactor leaves fewer valid-looking ways to perform an operation
incorrectly and less knowledge required to change it safely.

## Strata invariants

- Scanning reads source and Git history without executing analyzed code or
  modifying source, the index, or history. Write generated output only to its
  intended output location.
- Import relationships are observable signals, not proof of bugs or a validated
  composite quality score. Keep inferred gates, model recommendations, and
  generated illustrations visibly distinct from measured facts.
- Keep private scans, cached responses, and generated assets in ignored local
  storage. Scan output excludes source contents, commit messages, author names,
  and emails. Preserve the export requirement that `meta.private` is explicitly
  `false`, and the plugin packager's explicit file allowlist.
- Preserve the local server's loopback binding, host/origin checks, and bounded
  file serving. Keep API keys server-side and out of the Codex subprocess
  environment so included-plan actions do not accidentally use API-key billing.

## Verification

Use Node.js 22+ and Python 3.9+. Choose checks that exercise the change:

- `npm test` runs the Python scanner/hook tests and Node tests. Use a focused
  test while iterating, then run this suite for code behavior changes.
- Focused examples: `python3 -m unittest discover -s tests -p 'test_scan.py'`
  and `node --test tests/layout.test.mjs`.
- `npm run build` verifies browser bundling; run it for frontend or build changes.
  For visible UI changes, also exercise the affected journey in a WebGL-capable
  browser and inspect the result. A build alone does not verify the experience.
- After import or boundary changes, run
  `node bin/strata.mjs check --repo . --base HEAD`. Exit 1 means new shortcuts;
  exit 2 means analysis failed. Existing shortcuts do not fail the check. If the
  change is already committed, compare against its actual pre-change base.
- Run `npm run package:plugin` when changing packaged files or packaging, and
  verify the relevant behavior through the generated package as appropriate.
- Documentation-only changes need a diff and accuracy review, not an app build
  or journey. Do not add tests just to accompany documentation or trivial edits.

Report what was verified and any relevant limitations. Diagnose failures before
rerunning; do not repeatedly run unchanged checks after they pass.
