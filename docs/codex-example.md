# Strata checking Strata

During development, Strata found that `scripts/probe-codex.mjs` imported `server/codex.mjs` directly, past the declared server gate.

The repair created the narrow public surface `server/api.mjs` and changed the probe’s import to that path. The analyzer reported one incoming shortcut before the repair and zero afterward. The probe still verified the same Codex account and image-generation capability.

The pre-edit hook was also tested directly with a proposed new consumer:

```js
import { CodexClient } from '../server/codex.mjs';
```

It returned `permissionDecision: "deny"`, naming the source and target. The equivalent import from `../server/api.mjs` was allowed. Neither hook invocation wrote the proposed file.

This is a verified checker/hook test, not a claim that an installed live Codex session had already loaded and trusted the plugin. Live installation has a separate user trust step.

Codex also implemented the scanner, wrote behavioral tests for imports and hooks, and integrated its app-server. A local test verified that the signed-in ChatGPT account exposes image generation and successfully produced a city portrait without an image API key.
