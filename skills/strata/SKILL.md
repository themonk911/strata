---
name: strata
description: Infer and review module boundaries using Strata's local import graph and repository code, investigate cross-module imports, and check edits against accepted gates. Applies to repositories with strata.config.json or when explicitly asked to use Strata.
---

# Strata

Strata measures static imports. The current coding agent interprets the code and proposes boundaries; accepted declarations drive deterministic checks. Graph structure is evidence, not proof of intended ownership or bugs.

Resolve `../../bin/strata.mjs` from this skill's directory and invoke it with Node, or use an installed `strata` command. `python3 core/scan.py` is equivalent in the Strata checkout.

## Review boundaries

Read repository guidance and `strata.config.json`, if present. Respect existing declarations and configured aliases. A supplied `--config PATH` can hold a local policy without adding private architecture details to tracked files.

Run `strata gates --repo <repo>` to locate observed entry points, then narrow with `--module <module-path>`. Use `strata explain --repo <repo> --module <module-path>` for crossing imports. Graph output gives caller counts, directed reachability, mutually reachable groups (SCCs), dominance, and alternate entries. These measurements depend on the proposed module grouping. Type-only imports participate; an SCC does not prove a runtime cycle. Commands and runtime protocols may have no incoming imports.

Follow file references locally. Read exports, actual imported symbols, implementations, callers, tests, and architecture documentation. An import of an error or type does not make the target file's whole implementation public. Separate application operations, shared contracts, adapters, executable entry points, and internal state. Consider who owns validation, lifecycle, and side effects. Do not use popularity or a low graph cut alone to declare an API.

Present a concrete proposal: module ownership, public entry points, supporting code references, and unresolved questions. Distinguish the architecture already supported by the code from repairs needed to establish the proposed boundary. `public` lists importable paths; a CLI contract does not require making its executable importable. A folder with an unknown API is not a private module; saving `public: []` explicitly declares it private. Do not mark every existing import target public or add broad exceptions to make a check pass.

Review uncertain design choices with the user. Apply declarations within the user's authorized scope; an audit alone does not authorize changing policy. When a cleanup is requested, preserve callers' behavior and side-effect ordering while routing them through the owning API. Keep hypotheses out of enforcement until accepted.

## Check changes

Run `strata check --repo <repo> --base HEAD` and relevant behavioral tests. Existing shortcuts do not fail a change; newly added ones do. For committed changes, use their actual pre-change base. Use `--staged` in a Git pre-commit hook to check index contents independently of unstaged edits. Exit 1 means new shortcuts; exit 2 means analysis failed or coverage is unavailable. Report coverage gaps rather than calling them a clean check.

Python and JS/TS imports use AST parsing; computed runtime resolution remains outside coverage. Swift gate checks are unavailable. An explicitly scoped `--languages python javascript typescript` check reports excluded Swift files. Tests and configured adapters are exempt. Use `strata scan --repo <repo> --working` when a refreshed city is useful.

The bundled pre-edit hook previews `apply_patch`, `Edit`, and `Write` input in memory, resolving relative paths from the tool's working directory. It cannot intercept every write path; the stop check and explicit CLI check cover worktree changes. Hook installation and trust belong to the user. Do not silently install or trust hooks, or expand filesystem/network permissions.

Graph and scan output contain repository paths and dependency structure, even without source text. Keep private evidence in ignored local storage and out of commits, fixtures, documentation, and public exports. Read source in the current session; no separate model API is needed for boundary review. Do not upload repository evidence unless explicitly authorized for that destination and scope.
