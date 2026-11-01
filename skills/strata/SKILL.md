---
name: strata
description: Inspect codebase module boundaries and git-history signals with Strata before a cross-module change, investigate a shortcut or desire path, and verify that an edit preserves declared gates. Applies to repositories with strata.config.json or when explicitly asked to use Strata.
---

# Strata

Strata computes static import facts; its findings are prompts for investigation, not proof of decay or bugs. Respect the user's requested scope.

Use the CLI in this plugin's `bin/strata.mjs` (resolve relative to this skill's plugin root), or an installed `strata` command. `python3 core/scan.py` is equivalent in the Strata checkout.

- Read `strata.config.json` in the target repo to learn module paths, public gates, and permitted adapters.
- Before changing a module, run `strata explain --repo <repo> --module <module-path>`. Inspect the cited files and tests before choosing a repair.
- Prefer existing public APIs. If a private file has callers in several districts, consider exposing a narrow stable operation through the owning gate. Do not make every internal file public just to remove a warning.
- After editing, run `strata check --repo <repo> --base HEAD`. Exit 1 means new shortcuts; exit 2 means the analysis failed. Explain intentional boundary changes instead of claiming a clean check.
- Run the relevant behavioral tests. Use `strata scan --repo <repo> --working` to update the city after a repair.

Gates marked inferred are hypotheses. Confirm them against the repo's architecture; don't enforce their inferred intent as an established rule. Python imports use AST parsing. JavaScript/TypeScript extraction covers static string imports and can miss runtime resolution. Tests and configured adapters are exempt. No validated composite entropy index is supplied.

The bundled pre-edit hook previews supported `apply_patch` input in memory. It cannot intercept every write path; the stop check and explicit CLI check cover worktree changes. Hook installation and trust belong to the user. Do not silently install or trust hooks, or expand filesystem/network permissions.

Scan output contains repository paths and dependency structure. Keep private repo output local unless the user explicitly clears it for sharing.
