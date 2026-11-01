#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../core/scan.py', import.meta.url));
const result = spawnSync(process.env.PYTHON || 'python3', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) { console.error('Strata requires Python 3.9+ and git. ' + result.error.message); process.exit(2); }
process.exit(result.status ?? 2);
