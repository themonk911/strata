# strata

**See what your agents leave behind.** Strata turns a local git repository into a 3D city you can scrub through time, then gives Codex the same module-boundary facts.

Explore how a codebase grew, follow the paths across its boundaries, and turn its history into a forty-second infographic film. Codex can investigate a boundary when you want to go deeper.

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

The fixture uses illustrative dates to make its history easy to explore.

## Declare module gates

In the local app, choose **Edit boundaries** below the repository name. Add a module directory and its public entry points (one repository-relative path or glob per line), then **Preview imports** to see the current working tree's violations, including newly flagged and resolved imports. Inferred boundaries are suggestions that you can explicitly add to the draft. An empty gate list makes a module private; removing a module removes its declared boundary.

**Save rules** writes `strata.config.json` in the repository and refreshes the city. Other config settings are preserved. The editor requires a fresh preview, rejects incomplete analysis, and asks you to reload if the config changed elsewhere. If source files change after preview, preview again before saving. Existing violations can be saved as architectural debt: hooks still block newly introduced shortcuts, not unchanged existing imports.

When the workspace uses an external config, the editor offers an explicit import into the repository's `strata.config.json`. The external file stays untouched; existing repository settings are preserved, with external settings filling missing fields. The current city switches to the saved repository rules. If you launched with an external `STRATA_CONFIG` override, remove that override on your next launch to continue using the repository rules.

Trusted Strata hooks read the saved rules on their next check; the editor does not install or trust hooks. Boundary editing is local-only, supports saving on macOS and Linux, and does not require a Codex login. Static exports remain read-only. You can also edit the same config directly:

```json
{
  "name": "my-project",
  "private": true,
  "pythonRoots": ["src"],
  "modules": [
    { "path": "src/billing", "public": ["src/billing/__init__.py"] },
    { "path": "ui/orders", "public": ["ui/orders/index.ts"] }
  ],
  "allow": ["src/adapters/*"],
  "aliases": { "@/": "ui/" }
}
```

Paths are repository-relative. Public paths and adapter exceptions accept glob patterns. Tests are exempt. Without declarations, package entry points are inferred and visibly labeled as hypotheses. Confirm those boundaries before treating a shortcut as something to fix.

Inference recognizes outer packages such as `billing/` and `src/billing/` when they contain an entry point and another source file. Nested subpackages belong to that outer module instead of creating additional walls. `src` and configured Python roots are source containers; declare narrower boundaries when they match your architecture. Python absolute imports search the repository root and `src` by default; set `pythonRoots` for other layouts. Relative Python imports stay within the importing file's package. JavaScript aliases require explicit configuration. Source folders such as `data/` are included; dependency, build, and tool-state folders remain excluded.

```sh
node bin/strata.mjs explain --repo /path/to/repo --module src/billing
node bin/strata.mjs check --repo /path/to/repo --base HEAD
node bin/strata.mjs scan --repo /path/to/repo --working --out .local/city.json
```

`check` exits 1 for newly added shortcuts and 2 if analysis fails. Existing shortcuts are reported but do not fail a change. In a repository without commits, `check` compares the working tree with an empty baseline, and `scan` shows the working tree.

`scan` samples first-parent commits, including multiple commits on the same day, and keeps the first and latest commits. It uses up to 70 historical snapshots by default; `--max-snapshots` accepts 2–366. For larger repositories, a budget of 100,000 file/import records reduces the sample count. Adjust it with `--max-snapshot-records`. This is an estimate based on HEAD, not a hard byte limit. `--working` adds a current snapshot, and deleted files retain their plots in the layout.

Ordinary scans and the local **Rescan** button analyze only the sampled commits. The timeline shows the sampled count and whether the record budget reduced it; `meta.sampling` records the limits on every scan. Full-history rework, scatter, and shortcut-age calculations are optional because they replay every first-parent commit:

```sh
node bin/strata.mjs scan --repo /path/to/repo --history-analysis --working --out .local/city.json
```

Large full-history runs can take several minutes; run them from the CLI. Without this flag, historical signals remain unavailable, and the breakdown labels the current unweighted shortcut ratio separately. A normal rescan returns to sampled mode.

## Codex and Decisions

- **Create codebase film:** preview five animated chapters with real history, camera moves, counts, and charts. “Write with Astra” uses `gpt-6-astra` at `medium` reasoning through the signed-in Codex app-server to write an evidence-backed storyboard. The model chooses validated snapshot references; displayed numbers come from the scan. Storyboards are cached for the same evidence.
- **Illustrate ending:** generate a city illustration for the final chapter through Codex. Saved illustrations are matched to their source dataset. Export a silent, captioned 40-second video locally using the browser’s MediaRecorder; supported browsers choose WebM or MP4. Keep the tab visible during recording. This is a rendered infographic film, not an image-to-video model call.
- **Investigate:** a local `codex app-server` uses your existing ChatGPT sign-in with a read-only sandbox and approvals disabled. Its instructions focus investigation on the named gate and source files.
- **Illustrate:** the app sends a screenshot of the real city to Codex’s built-in image generation. The output is an artistic interpretation, kept separate from measured facts, using included-plan usage.
- **Judge the gate:** optional Decisions API call with `gpt-6-luna`, using bounded import facts rather than repository source. Add `OPENAI_API_KEY=...` to `.env.local`. Never put the key in browser code. Repeated evidence is cached; the server caps requests at 50 per process and 40,000 request characters. This is a conservative request cap, not an account-wide dollar budget.

The app-server process has `OPENAI_API_KEY` removed from its environment so these Codex actions do not accidentally use API-key billing. Ordinary Codex plan limits still apply.

## Use the Strata plugin

The plugin packages the checker, skill, and optional pre-edit/stop hooks. Build it from an explicit allowlist; private datasets and environment files are never included.

```sh
npm run package:plugin
codex plugin marketplace add .
codex plugin add strata@strata-dev
```

Review and trust the hooks in Codex before enabling them, then use a new session. The repository marketplace points at the generated `.local/strata-plugin` package. The pre-edit hook previews `apply_patch`, `Edit`, and `Write` calls in memory, resolving relative paths from the tool's working directory. It reparses changed importers when the source paths are unchanged; adding, deleting, or moving files requires a full comparison. Other write mechanisms require the stop check or an explicit `strata check`.

Strata dogfoods declared gates for its own `core`, `server`, and `web` modules. See [the verified example](docs/codex-example.md).

## Read the city

- Buildings are files; height scales with the square root of line count.
- District shapes and file placement follow imports. Positions stay fixed while scrubbing.
- Walls enclose modules. Gates represent public entry points.
- Violet arcs are imports into another module’s private files. Selected districts show individual arcs; other arcs are bundled.
- Rings mark private files reached from at least two other districts.
- Warmth means change since the preceding sampled snapshot. Activity dots trace actual commits, not asserted agent identities.
- The film’s **boundary pressure** is shortcuts divided by all resolved imports, including imports inside a district. It normalizes the shortcut count for import growth; it is not a validated entropy or defect score.

## Experimental entropy index

Strata includes **entropy v2** (`strata-entropy-v2`), an optional experimental 0–1 summary of three observable signals. Enable it with `--history-analysis` and open its breakdown to inspect the raw measurements and coverage. It has not been validated as a predictor of bugs, code quality, or maintenance cost.

| Signal | Default measurement | Normalization anchor |
| --- | --- | --- |
| Rework | Of nonblank lines introduced at least 14 days ago, the fraction removed within 14 days of introduction. This uses cumulative mature cohorts, excluding the initial baseline and uncommitted edits. | 30% |
| Scatter | How widely each committed change spreads changed lines across source modules: normalized Shannon entropy, averaged equally across changes in the last 30 days. | 1.0 |
| Shortcuts | Live shortcuts divided by all resolved imports. Newly observed shortcuts count twice for 14 days, then once. | 10% |

Each signal is divided by its fixed anchor and capped at 1; the index is their **equal-weight mean**. The 30% rework and 10% shortcut anchors are uncalibrated display saturation choices; scatter 1.0 is the mathematical maximum of normalized Shannon entropy. The data records this rationale in `meta.entropy.anchorBasis`. These choices are not learned or validated quality thresholds. The unweighted boundary-pressure chart remains a separate measure.

Rework matches equal lines after removing whitespace, preserving reorders and exact moves within one commit. It does not recognize arbitrary semantic rewrites, line splitting/joining, or moves spread across commits; identical duplicate lines are ambiguous. First-parent commits represent integration events, not proof of reviewed pull requests.

**Partial coverage is explicit.** Unassigned test lines are excluded from scatter, with their paths, counts, and the attributable fraction reported. Changes with no attributable lines are excluded rather than scored as zero. District rework uses its known cohorts; unassigned cohorts still contribute to repository rework. A numeric composite based on partial coverage is labeled **Partial** in the app.

**Missing signals stay missing.** No attributable changes, immature history, shallow history, unreliable timestamps, or sampled mode can make a signal unavailable. The combined index is then incomplete, rather than treating the missing signal as zero or averaging only the available ones. Tests with one defensible production owner can be declared in `entropy.testOwners`, mapping repository-relative test paths or globs to module paths. Keep genuinely mixed integration tests unassigned. Window lengths and the shortcut premium can be configured under `entropy`; the score breakdown records the settings used.

## Limitations

Python and JS/TS imports use ASTs. Resolution covers local static paths, configured Python roots, and configured JS aliases. Computed imports, external packages, runtime path changes, and some language-specific resolution rules are outside this version’s coverage. Gate definitions from the current config apply to the whole window; the city does not infer historical design intent. Large scans still load sampled file and import data into browser memory; reduce the sampling budget when needed.

The experimental entropy index and import boundaries are descriptive signals. Decisions recommendations and generated illustrations are labeled as interpretation. Semantic rework tracking, causal validation, change coupling, reversals, and leftover-code detection are outside this release.

The Codex sandbox restricts writes, not filesystem reads. Instructions to avoid credentials and unrelated files are model guidance, not an enforced read allowlist. Hooks are advisory integration checks, not a security boundary; installation and trust remain under Codex's controls. Included-plan image generation has been verified, but its exact Image 2.5 backend has not. Decisions request and response handling are tested offline against the documented contract; ordinary tests do not verify live account access or consume API credits.

## Privacy and static sharing

The core scanner needs no account or hosted service. Output includes source paths, import relationships, counts, and commit times, but excludes file contents, commit messages, author names, and emails. That structure can still be private. Keep private scans under ignored `.local/` or `.strata/`.

Codex investigation sends selected code to the signed-in Codex service; Decisions sends selected boundary facts to OpenAI; illustrations send the displayed city screenshot to Codex; Astra receives aggregate history and top district names for the film narrative. These are explicit button actions. Generated assets and cached responses stay in `.local/` and are not served as a directory listing. Downloaded videos contain visible codebase structure and need the same privacy review as screenshots.

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
