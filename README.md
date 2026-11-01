# strata

**See what your agents leave behind.** Strata turns a local git repository into a 3D city you can scrub through time, then gives Codex the same module-boundary facts.

One journey: find a violet shortcut, inspect the public gate, ask Codex to investigate, make a focused repair, and rescan to see the arc disappear.

## Run locally

Requires Node.js 22+, Python 3.9+, git, and a WebGL-capable browser. Codex features require the [Codex CLI](https://developers.openai.com/codex/quickstart) signed in with ChatGPT.

```sh
git clone https://github.com/themonk911/strata.git
cd strata
npm ci
npm test
npm run build

# Analyze a repository. This does not execute or modify its code.
node bin/strata.mjs scan --repo /path/to/repo --out .local/city.json

# Point the investigator and rescan button at the same repository.
STRATA_REPO=/path/to/repo npm run dev
```

Open `http://127.0.0.1:4317`. The local server binds only to loopback. Use `STRATA_CONFIG=/path/to/strata.config.json` for an external configuration file, or put the config in the scanned repository.

For a public, synthetic example with a real gate repair:

```sh
npm run demo
STRATA_DATA=.local/demo-city.json STRATA_REPO="$PWD/.demo-repo" npm run dev
```

The synthetic dates are illustrative; the fixture and generator were built during the hackathon. They are not a claim of earlier development activity.

## Declare module gates

```json
{
  "name": "my-project",
  "private": true,
  "pythonRoots": ["backend"],
  "modules": [
    { "path": "backend/app/billing", "public": ["backend/app/billing/__init__.py"] },
    { "path": "frontend/src/orders", "public": ["frontend/src/orders/index.ts"] }
  ],
  "allow": ["backend/app/routers/*"],
  "aliases": { "@/": "frontend/src/" }
}
```

Paths are repository-relative. Public paths and adapter exceptions accept glob patterns. Tests are exempt. Without declarations, package entry points are inferred and visibly labeled as hypotheses. Confirm those boundaries before treating a shortcut as something to fix.

```sh
node bin/strata.mjs explain --repo /path/to/repo --module backend/app/billing
node bin/strata.mjs check --repo /path/to/repo --base HEAD
node bin/strata.mjs scan --repo /path/to/repo --working --out .local/city.json
```

`check` exits 1 for newly added shortcuts and 2 if analysis fails. Existing shortcuts are reported but do not fail a change. `scan` follows first-parent history, samples up to 70 snapshots by default, and includes deleted files in the stable layout. `--max-snapshots` accepts 2–366.

## Codex and Decisions

- **Investigate:** a local `codex app-server` uses your existing ChatGPT sign-in. It can read the named gate and source files in a read-only session. It does not edit the repository.
- **Illustrate:** the app sends a screenshot of the real city to Codex’s built-in image generation. The output is an artistic interpretation, kept separate from measured facts. Included-plan image generation is verified; a specific Image 2.5 backend is **not claimed**.
- **Judge the gate:** optional Decisions API call with `gpt-6-luna`, using bounded import facts rather than repository source. Add `OPENAI_API_KEY=...` to `.env.local`. Never put the key in browser code. Repeated evidence is cached; the server caps requests at 50 per process and 40,000 request characters. This is a conservative request cap, not an account-wide dollar budget.

The app-server process has `OPENAI_API_KEY` removed from its environment so these Codex actions do not accidentally use API-key billing. Ordinary Codex plan limits still apply.

## Use the Strata plugin

The plugin packages the checker, skill, and optional pre-edit/stop hooks. Build it from an explicit allowlist; private datasets and environment files are never included.

```sh
npm run package:plugin
codex plugin marketplace add .
codex plugin add strata@strata-dev
```

Review and trust the hooks in Codex before enabling them, then use a new session. The repository marketplace points at the generated `.local/strata-plugin` package. The pre-edit hook previews supported `apply_patch` calls in memory. Other write mechanisms require the stop check or an explicit `strata check`. A hook is not a security boundary, and Strata does not bypass Codex’s permission or trust controls.

Strata dogfoods declared gates for its own `core`, `server`, and `web` modules. See [the verified example](docs/codex-example.md).

## Read the city

- Buildings are files; height scales with the square root of line count.
- District shapes and file placement follow imports. Positions stay fixed while scrubbing.
- Walls enclose modules. Gates represent public entry points.
- Violet arcs are imports into another module’s private files. Selected districts show individual arcs; other arcs are bundled.
- Rings mark private files reached from at least two other districts.
- Warmth means change since the preceding sampled snapshot. Activity dots trace actual commits, not asserted agent identities.

Python and JS/TS imports use ASTs. Resolution covers local static paths, configured Python roots, and configured JS aliases. Computed imports, external packages, runtime path changes, and some language-specific resolution rules are outside this version’s coverage. Gate definitions from the current config apply to the whole window; the city does not infer historical design intent.

**There is no validated composite entropy score.** Import boundaries are observable signals. Decisions recommendations and generated illustrations are labeled as interpretation. Rework survival analysis, causal validation, reversals, and leftover-code detection are outside this release.

## Privacy and static sharing

The core scanner needs no account or hosted service. Output includes source paths, import relationships, counts, and commit times, but excludes file contents, commit messages, author names, and emails. That structure can still be private. Keep private scans under ignored `.local/` or `.strata/`.

Codex investigation sends selected code to the signed-in Codex service; Decisions sends selected boundary facts to OpenAI; illustrations send the displayed city screenshot to Codex. These are explicit button actions. Generated assets and cached responses stay in `.local/` and are not served as a directory listing.

To export an approved public dataset as a static page:

```sh
npm run build
node scripts/export.mjs .local/demo-city.json
```

Host `dist/` on a static web host. Static sharing supports exploring history and copying repair tasks; live Codex and Decisions actions require the local server. The exporter refuses data unless `meta.private` is explicitly `false`. Review the data before publication.

## Development and credits

Built at the DevDay Exchange Community Hackathon, London, 1 November 2026. [Credits and prior work](CREDITS.md). [90-second demo outline](docs/demo.md).

```sh
npm test
npm run build
```

Official references: [Codex app-server](https://developers.openai.com/codex/app-server), [hooks](https://learn.chatgpt.com/docs/hooks), [plugins](https://developers.openai.com/plugins/build/plugins), [image generation](https://learn.chatgpt.com/docs/image-generation), [Decisions API](https://developers.openai.com/api/docs/guides/decisions).
