# Strata checking Strata

During development, Strata found that `scripts/probe-codex.mjs` imported `server/codex.mjs` directly, past the declared server gate.

The repair created the narrow public surface `server/api.mjs` and changed the probe’s import to that path. The analyzer reported one incoming shortcut before the repair and zero afterward. The probe still verified the same Codex account and image-generation capability.

The pre-edit hook was also tested directly with a proposed new consumer:

```js
import { CodexClient } from '../server/codex.mjs';
```

It returned `permissionDecision: "deny"`, naming the source and target. The equivalent import from `../server/api.mjs` was allowed. Neither hook invocation wrote the proposed file.

The repair predates the initial commit. Reproduce the before/after hook behavior from the current checkout with this read-only preview:

```sh
python3 - <<'PY'
import json
from pathlib import Path
import subprocess

for target in ('codex', 'api'):
    patch = ('*** Begin Patch\n*** Add File: scripts/strata-example.mjs\n'
             '+import { CodexClient } from "../server/' + target + '.mjs";\n'
             '*** End Patch')
    payload = {'cwd': str(Path.cwd()), 'hook_event_name': 'PreToolUse',
               'tool_name': 'apply_patch', 'tool_input': {'command': patch}}
    result = subprocess.run(['python3', 'hooks/check.py'],
                            input=json.dumps(payload), text=True,
                            capture_output=True, check=True)
    print(target + ': ' + result.stdout.strip())
PY
```

The `codex` import is denied; the `api` import returns `{}` with no objection. Both previews leave the working tree unchanged.

This is a verified checker/hook test, not a claim that an installed live Codex session had already loaded and trusted the plugin. Live installation has a separate user trust step.

Codex also implemented the scanner, wrote behavioral tests for imports and hooks, and integrated its app-server. A local test verified that the signed-in ChatGPT account exposes image generation and successfully produced a city portrait without an image API key.
