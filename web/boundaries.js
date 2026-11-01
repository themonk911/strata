import { escape } from './html.js';

export function openBoundaries({ api, refreshCity }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'boundary-dialog';
  dialog.setAttribute('aria-labelledby', 'boundary-title');
  dialog.innerHTML = `
    <button class="close-modal" data-close aria-label="Close boundary editor">×</button>
    <div class="eyebrow modal-eyebrow">ARCHITECTURE / WORKING TREE</div>
    <h2 id="boundary-title">Shape your boundaries.</h2>
    <p class="boundary-intro">Choose which folders are modules and which files form their public gates. Preview the imports affected before saving.</p>
    <div class="boundary-config" hidden></div>
    <div class="boundary-notice" role="status" aria-live="polite">Loading the repository’s rules…</div>
    <button type="button" class="secondary-button" data-load-retry hidden>Retry loading rules</button>
    <form hidden>
      <fieldset class="boundary-fields">
        <div class="boundary-section-heading"><h3>Declared modules <span data-module-count></span></h3><button type="button" class="text-button" data-reload>Reload saved rules</button></div>
        <p class="boundary-help">Paths are relative to the repository root. Put each public file or glob pattern on its own line. An empty gate keeps every file in that module private.</p>
        <div class="boundary-modules"></div>
        <p class="boundary-empty" hidden>No declared modules. Add a module below, or save an empty list to leave all folders open.</p>
        <button type="button" class="secondary-button boundary-add" data-add>+ Add module</button>
        <details class="boundary-suggestions" hidden><summary>Inferred suggestions <span data-suggestion-count></span></summary><p>These package entry points are hypotheses. Add only the boundaries that match your intended design.</p><div data-suggestions></div></details>
      </fieldset>
      <section class="boundary-preview" aria-labelledby="boundary-preview-title">
        <div class="boundary-section-heading"><h3 id="boundary-preview-title">Preview</h3><span class="boundary-scope">Current working tree</span></div>
        <div data-preview><p class="boundary-help">Preview to see which imports would reach past your proposed gates.</p></div>
      </section>
      <label class="boundary-import-consent" hidden><input type="checkbox" data-import><span>Import these rules into the repository for hooks</span></label>
      <p class="boundary-workspace-warning" role="status" hidden></p>
      <footer class="boundary-footer">
        <p data-save-note>Saving updates <code>strata.config.json</code>. Trusted Strata hooks read these rules on their next check. Existing shortcuts remain a baseline; the hooks block newly introduced ones.</p>
        <div class="boundary-actions"><button type="submit" class="secondary-button" data-preview-button>Preview imports</button><button type="button" class="primary" data-save disabled>Save rules</button></div>
      </footer>
    </form>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  const form = $('form'), fields = $('fieldset'), rows = $('.boundary-modules');
  const notice = $('.boundary-notice'), output = $('[data-preview]');
  const previewButton = $('[data-preview-button]'), saveButton = $('[data-save]');
  let policy, preview = null, busy = false, saved = false, saving = false, cityRefreshed = false, nextRow = 0, workspaceWarning = '';

  function message(text, kind = '') {
    notice.textContent = text;
    notice.className = 'boundary-notice' + (kind ? ' ' + kind : '');
    notice.hidden = !text;
  }
  function draft() {
    return [...rows.children].map(row => ({ path: row.querySelector('input').value.trim(), public: row.querySelector('textarea').value.split('\n').map(s => s.trim()).filter(Boolean) }));
  }
  function controls() {
    fields.disabled = busy || saved;
    previewButton.disabled = busy || saved;
    saveButton.disabled = busy || saved || !preview || Boolean(preview.warnings.length) || (policy?.importRequired && !$('[data-import]').checked);
    $('[data-import]').disabled = busy || saved;
    $('[data-load-retry]').disabled = busy;
    if ($('[data-refresh]')) $('[data-refresh]').disabled = busy;
    $('[data-close]').disabled = saving;
  }
  function changed() {
    preview = null;
    output.innerHTML = '<p class="boundary-help">Draft changed. Preview again before saving.</p>';
    message('Unsaved rules. The saved policy is still in effect.');
    $('[data-module-count]').textContent = rows.children.length;
    $('.boundary-empty').hidden = Boolean(rows.children.length);
    const paths = new Set(draft().map(m => m.path));
    for (const button of dialog.querySelectorAll('[data-suggestion]')) {
      button.disabled = paths.has(button.dataset.suggestion);
      button.textContent = button.disabled ? 'Added' : 'Add module';
    }
    controls();
  }
  function addRow(module = { path: '', public: [] }, focus = false) {
    const id = ++nextRow, row = document.createElement('div');
    row.className = 'boundary-module';
    row.innerHTML = `<div class="boundary-module-path"><label for="boundary-path-${id}">Module folder</label><input id="boundary-path-${id}" value="${escape(module.path)}" placeholder="src/billing" list="boundary-folders" required autocomplete="off" spellcheck="false"></div><div class="boundary-module-gates"><label for="boundary-gates-${id}">Public gates</label><textarea id="boundary-gates-${id}" rows="2" placeholder="src/billing/index.ts" autocomplete="off" spellcheck="false">${escape(module.public.join('\n'))}</textarea></div><button type="button" class="boundary-remove" aria-label="Remove module ${escape(module.path || 'row')}">Remove</button>`;
    row.querySelector('button').onclick = () => { row.remove(); changed(); $('[data-add]').focus(); };
    rows.append(row);
    if (focus) row.querySelector('input').focus();
  }
  function showEdges(edges, added, empty) {
    if (!edges.length) return `<p class="boundary-help">${empty}</p>`;
    const introduced = new Set(added.map(e => `${e.source}\0${e.target}`));
    return `<ol class="boundary-imports">${edges.map(e => `<li><div><code>${escape(e.source)}:${escape(e.line)}</code><span aria-hidden="true">→</span><code>${escape(e.target)}</code></div>${introduced.has(`${e.source}\0${e.target}`) ? '<span class="boundary-new">Newly flagged</span>' : ''}</li>`).join('')}</ol>`;
  }
  function showPreview(result) {
    const { counts, warnings, shortcuts, added, removed } = result;
    output.innerHTML = `<div class="boundary-counts"><div><strong>${counts.after}</strong><span>imports past gates</span></div><div><strong>${counts.added}</strong><span>newly flagged</span></div><div><strong>${counts.removed}</strong><span>no longer flagged</span></div></div>
      <p class="boundary-help">Compared with the saved policy on the same working tree (${counts.before} imports past gates). These are import relationships, not proof of defects.</p>
      ${warnings.length ? `<div class="boundary-warning"><strong>Analysis is incomplete. Rules cannot be saved yet.</strong><ul>${warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul></div>` : ''}
      <details class="boundary-evidence" open><summary>Imports that would violate these rules (${shortcuts.length})</summary>${showEdges(shortcuts, added, 'No resolved imports would cross a private gate.')}</details>
      ${removed.length ? `<details class="boundary-evidence"><summary>No longer flagged (${removed.length})</summary>${showEdges(removed, [], '')}</details>` : ''}`;
  }
  async function load() {
    busy = true; preview = null; saved = false; workspaceWarning = ''; controls();
    $('[data-load-retry]').hidden = true;
    message('Loading the repository’s rules…');
    try {
      const result = await api('boundaries');
      if (!dialog.isConnected) return;
      policy = result;
      $('.boundary-config').hidden = !policy.importRequired;
      $('.boundary-config').innerHTML = policy.importRequired ? `<strong>This city uses an external configuration.</strong><dl><dt>Read from</dt><dd><code>${escape(policy.sourceConfig)}</code></dd><dt>Save to</dt><dd><code>${escape(policy.targetConfig)}</code></dd></dl><p>${escape(policy.importNote || 'Saving imports these rules into the repository. The external file is unchanged. The city and hooks then use the repository’s saved rules.')}</p>` : '';
      $('.boundary-import-consent').hidden = !policy.importRequired;
      $('[data-import]').checked = false;
      $('.boundary-workspace-warning').hidden = true;
      rows.replaceChildren();
      for (const module of policy.modules) addRow(module);
      const folders = [...new Set(policy.files.flatMap(path => {
        const parts = path.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
      }))].sort();
      dialog.querySelector('datalist')?.remove();
      const datalist = document.createElement('datalist');
      datalist.id = 'boundary-folders';
      datalist.innerHTML = folders.map(path => `<option value="${escape(path)}"></option>`).join('');
      fields.append(datalist);
      $('.boundary-suggestions').hidden = !policy.suggestions.length;
      $('[data-suggestion-count]').textContent = policy.suggestions.length;
      $('[data-suggestions]').innerHTML = policy.suggestions.map(m => `<div class="boundary-suggestion"><div><code>${escape(m.path)}</code><span>${escape(m.public.join(', '))}</span></div><button type="button" class="secondary-button" data-suggestion="${escape(m.path)}">Add module</button></div>`).join('');
      for (const button of dialog.querySelectorAll('[data-suggestion]')) button.onclick = () => {
        addRow(policy.suggestions.find(m => m.path === button.dataset.suggestion), true); changed();
      };
      form.hidden = false;
      changed();
      output.innerHTML = '<p class="boundary-help">Preview to see which imports would reach past your proposed gates.</p>';
      message(policy.configured ? 'Editing the saved rules. Changes stay in this draft until you save.' : 'No saved boundary policy yet. Inferred suggestions stay separate until you add them.');
    } catch (error) {
      if (dialog.isConnected) { message(error.message, 'boundary-error'); $('[data-load-retry]').hidden = false; }
    } finally { busy = false; controls(); }
  }

  rows.addEventListener('input', changed);
  $('[data-import]').onchange = controls;
  $('[data-add]').onclick = () => { addRow(undefined, true); changed(); };
  $('[data-reload]').onclick = load;
  $('[data-load-retry]').onclick = load;
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || saved || !form.reportValidity()) return;
    busy = true; preview = null; controls();
    message('Reading imports from the current working tree…');
    try {
      const result = await api('boundaries/preview', { modules: draft(), revision: policy.revision });
      if (!dialog.isConnected) return;
      preview = result; showPreview(result);
      message(result.warnings.length ? 'Resolve the analysis warnings, then preview again.' : 'Preview ready. Saving will make these your declared boundaries.', result.warnings.length ? 'boundary-error' : '');
    } catch (error) {
      output.innerHTML = '<p class="boundary-help">No valid preview. Fix the draft and try again. If saved rules changed, reload them first.</p>';
      message(error.message, 'boundary-error');
    } finally { busy = false; controls(); }
  };
  async function refresh() {
    busy = true; saving = true; controls();
    message('Rules saved to strata.config.json. Refreshing the city…', 'boundary-success');
    try {
      await refreshCity(activity => message('Rules saved. ' + activity, 'boundary-success'));
      cityRefreshed = true;
      if (!workspaceWarning) location.reload();
      else {
        message('Rules saved and the city refreshed. Review the workspace note below before leaving.', 'boundary-success');
        $('[data-refresh]')?.remove();
        if (!$('[data-view-city]')) {
          const view = document.createElement('button'); view.type = 'button'; view.className = 'secondary-button'; view.dataset.viewCity = '';
          view.textContent = 'View updated city'; view.onclick = () => location.reload(); $('.boundary-actions').prepend(view);
        }
      }
    } catch (error) {
      message('Rules are saved and available to trusted hooks. The city could not refresh: ' + error.message, 'boundary-error');
      let retry = $('[data-refresh]');
      if (!retry) {
        retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary-button'; retry.dataset.refresh = '';
        retry.textContent = 'Retry city refresh'; $('.boundary-actions').prepend(retry); retry.onclick = refresh;
      }
    } finally { busy = false; saving = false; controls(); }
  }
  saveButton.onclick = async () => {
    if (busy || saved || !preview || preview.warnings.length || (policy.importRequired && !$('[data-import]').checked)) return;
    busy = true; saving = true; controls();
    message('Saving the previewed rules…');
    try {
      const result = await api('boundaries/save', { modules: draft(), revision: policy.revision, previewToken: preview.previewToken, ...(policy.importRequired ? { importConfig: true } : {}) });
      saved = true;
      workspaceWarning = [result.workspaceWarning, result.restartNote].filter(Boolean).join(' ');
      $('.boundary-workspace-warning').textContent = workspaceWarning;
      $('.boundary-workspace-warning').hidden = !workspaceWarning;
      $('[data-save-note]').textContent = 'Rules saved to strata.config.json. Trusted Strata hooks read these rules on their next check. Existing shortcuts remain a baseline; the hooks block newly introduced ones.';
      saveButton.textContent = 'Rules saved';
      await refresh();
    } catch (error) {
      preview = null;
      message(error.message + ' Preview again before saving, or reload saved rules if the policy changed.', 'boundary-error');
    } finally { busy = false; saving = false; controls(); }
  };
  $('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (saved && cityRefreshed) location.reload(); });
  dialog.showModal();
  load();
}
