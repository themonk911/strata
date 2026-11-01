import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = `
import json, sys
sys.path.insert(0, sys.argv[1])
from core import read_boundaries, preview_boundaries, save_boundaries
try:
    request = json.load(sys.stdin)
    repo = request['repo']
    config = request.get('config')
    action = request['action']
    if action == 'read':
        result = read_boundaries(repo, config=config)
    elif action == 'preview':
        result = preview_boundaries(repo, request['modules'], request['revision'], config=config)
    else:
        result = save_boundaries(repo, request['modules'], request['revision'], request['previewToken'], config=config, import_config=request.get('importConfig', False))
    print(json.dumps(result))
except (ValueError, OSError, TypeError, KeyError) as error:
    print(json.dumps({'error': str(error)}))
    sys.exit(2)
`;

// Own the local scanner protocol and lifecycle. The browser supplies rules,
// never a repository path or an executable command.
export class BoundaryEditor {
  #workspace;
  #busy;
  #python;
  #workspaceFile;
  #externalConfigOverride;
  #override;
  #active = false;
  #closed = false;
  #cancel;

  constructor({ workspace, workspaceFile, busy = () => false, python = process.env.PYTHON || 'python3', externalConfigOverride = false }) {
    this.#workspace = workspace;
    this.#busy = busy;
    this.#python = python;
    this.#workspaceFile = workspaceFile;
    this.#externalConfigOverride = externalConfigOverride;
  }

  async workspace() {
    const target = await this.#workspace();
    return target?.repo && this.#override?.repo === resolve(target.repo) ? this.#override : target;
  }

  async #target() {
    const target = await this.workspace();
    if (!target?.repo) throw new Error('Set STRATA_REPO to a local repository before editing boundaries.');
    return { repo: resolve(target.repo), config: target.config ? resolve(target.config) : undefined };
  }

  async available() {
    try { await this.#target(); return true; }
    catch { return false; }
  }

  read() { return this.#run('read'); }
  preview(input) { return this.#run('preview', input); }
  save(input) { return this.#run('save', input); }
  close() { this.#closed = true; this.#cancel?.('Boundary operation interrupted. Reload the rules to verify their saved state.'); }
  get active() { return this.#active; }

  async #run(action, input) {
    if (this.#closed) throw new Error('Boundary editor is closed.');
    if (action !== 'read') {
      const allowed = action === 'save' ? ['modules', 'revision', 'previewToken', 'importConfig'] : ['modules', 'revision'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
        throw new Error('Expected boundary rules and the current revision only.');
      }
      if (!Array.isArray(input.modules) || typeof input.revision !== 'string' || !input.revision) {
        throw new Error('Reload the rules, then preview a list of modules.');
      }
      if (action === 'save' && (typeof input.previewToken !== 'string' || !input.previewToken)) {
        throw new Error('Preview these rules before saving.');
      }
      if ('importConfig' in input && typeof input.importConfig !== 'boolean') throw new Error('Import confirmation must be true or false.');
    }
    if (this.#active) throw new Error('A boundary operation is already running. Let it finish first.');
    if (action === 'save' && this.#busy()) throw new Error('Let the current Codex or scan request finish before saving boundaries.');
    this.#active = true;
    try {
      const target = await this.#target();
      if (this.#closed) throw new Error('Boundary editor is closed.');
      const result = await this.#execute({ action, ...target, ...input });
      if (action === 'save') {
        if (result.saved !== true) throw new Error('Boundary scanner did not confirm that the rules were saved. Reload them before retrying.');
        await this.#useSavedConfig(target, result);
      }
      return result;
    } finally { this.#active = false; }
  }

  async #useSavedConfig(target, result) {
    const config = result.targetConfig || join(target.repo, 'strata.config.json');
    this.#override = { repo: target.repo, config };
    const warnings = [];
    if (this.#workspaceFile) {
      const temporary = this.#workspaceFile + '.' + randomUUID() + '.tmp';
      try {
        let saved = {};
        try { saved = JSON.parse(await readFile(this.#workspaceFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // A temporary STRATA_REPO override must not replace another saved
        // workspace. Only remember this workspace's new config selection.
        if (!saved.repo || resolve(saved.repo) === target.repo) {
          await writeFile(temporary, JSON.stringify({ ...saved, ...this.#override }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await rename(temporary, this.#workspaceFile);
        }
      } catch {
        warnings.push('Rules are saved, but the workspace selection could not be remembered. Select the repository’s strata.config.json after restarting Strata.');
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    const previousConfig = target.config && await realpath(target.config).catch(() => target.config);
    if (this.#externalConfigOverride && previousConfig !== config) {
      warnings.push('Rules are saved and active here. Remove the external STRATA_CONFIG override before restarting Strata so future scans use the saved repository rules.');
    }
    if (warnings.length) result.workspaceWarning = warnings.join(' ');
  }

  #execute(request) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.#python, ['-I', '-c', adapter, root], {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let output = '', diagnostics = '', size = 0, failure, killTimer, stopping = false;
      const signal = name => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, name); }
        catch { child.kill(name); }
      };
      const stop = message => {
        if (stopping) return;
        stopping = true;
        failure ||= new Error(message);
        // SIGINT lets Python release its save lock in finally. Retire parser
        // children as well, with a bounded fallback if the process is stuck.
        signal('SIGINT');
        killTimer = setTimeout(() => signal('SIGKILL'), 1000);
      };
      this.#cancel = stop;
      const timer = setTimeout(() => stop('Boundary analysis timed out. Reload the rules to verify their saved state before retrying.'), 60_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 8_000_000) stop('Boundary analysis exceeded the local response limit.');
        else output += chunk;
      });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
      child.stdin.on('error', error => stop('Could not send rules to the scanner: ' + error.message));
      child.on('error', error => { failure = new Error('Could not start the boundary scanner. Check Python installation. ' + error.message); });
      child.on('close', code => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (this.#cancel === stop) this.#cancel = undefined;
        if (failure) return reject(failure);
        let result;
        try { result = JSON.parse(output); }
        catch { return reject(new Error('Boundary scanner returned an invalid response.' + (diagnostics ? ' ' + diagnostics : ''))); }
        if (code !== 0 || result?.error) return reject(new Error(result?.error || 'Boundary analysis failed.'));
        if (!result || typeof result !== 'object' || typeof result.revision !== 'string') {
          return reject(new Error('Boundary scanner returned an incomplete response.'));
        }
        resolveResult(result);
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
