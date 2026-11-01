// Copied unchanged into each Explainroo project. Repository values are JSON data.
import report from './data.mjs';

const C = { ink: '#23372e', muted: '#626d60', violet: '#735195', green: '#4d6a53', line: '#cdd5c8' };
const number = value => Number.isFinite(value) ? value.toLocaleString('en-GB', { maximumFractionDigits: 0 }) : 'Unavailable';
const point = id => report.history[report.chapters[id].snapshot];
function fit(s, text, width, initial = 42, role = 'body') {
  let value = String(text), size = initial;
  const family = role === 'display' ? 'Instrument Serif' : role === 'mono' ? 'JetBrains Mono' : 'Inter';
  const measure = () => { s.ctx.font = `${size}px "${family}"`; return s.ctx.measureText(value).width; };
  while (measure() > width && size > 36) size -= 1;
  if (measure() > width) { while (value.length > 1 && measure() > width - 28) value = value.slice(0, -1); value += '…'; }
  return { text: value, size };
}
function text(s, value, x, y, at, options = {}) {
  const fitted = fit(s, value, options.maxWidth || 1500, options.size || 40, options.font || 'body');
  return s.text(fitted.text, { x, y, at, size: fitted.size, align: 'left', color: 'ink', enter: 'fade', dur: .3, sfx: false, ...options, size: fitted.size });
}
function header(s, id, section) {
  s.camera([]);
  text(s, 'strata', 160, 103, -1, { size: 54, font: 'display', enter: 'none', maxWidth: 400 });
  text(s, report.privacyLabel, 1760, 105, -1, { size: 36, font: 'mono', align: 'right', color: 'muted', enter: 'none', maxWidth: 750 });
  s.line([[160, 145], [1760, 145]], { color: C.line, width: 2, at: -1, enter: 'none', sfx: false });
  text(s, `${section} / ${report.name}`, 160, 187, -1, { size: 36, font: 'mono', color: 'muted', enter: 'none', maxWidth: 1580 });
  text(s, report.chapters[id].title, 160, 265, '#start', { size: 78, font: 'display', maxWidth: 1580, enter: 'rise' });
}
function city(s, asset, at, options = {}) {
  return s.image(`assets/${asset}.png`, { x: 1280, y: 568, w: 1000, h: 562, fit: 'contain', frame: 'none', border: C.line,
    radius: 16, shadow: false, kenburns: true, at, enter: 'fade', dur: .4, sfx: false, ...options });
}
function metric(s, value, label, x, y, at, options = {}) {
  text(s, value, x, y, at, { size: 125, font: 'display', color: 'purple', align: 'center', maxWidth: 600, ...options });
  text(s, label, x, y + 105, at, { size: 38, color: 'muted', align: 'center', maxWidth: 600, out: options.out, exit: options.exit });
}
function chart(s, values, x, y, w, h, at, label, ceiling) {
  const max = ceiling ?? Math.max(1, ...values.filter(Number.isFinite));
  s.draw({ x, y, at }, (ctx, life) => {
    ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, h); ctx.stroke();
    ctx.strokeStyle = C.violet; ctx.lineWidth = 5; ctx.beginPath(); let connected = false;
    const end = Math.max(1, Math.ceil(values.length * life.p));
    values.slice(0, end).forEach((value, index) => {
      if (!Number.isFinite(value)) { connected = false; return; }
      const xx = index / Math.max(1, values.length - 1) * w, yy = h - value / max * h;
      if (connected) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); connected = true;
    }); ctx.stroke();
  });
  text(s, label, x, y + h + 54, at, { size: 36, color: 'muted', maxWidth: w });
}
function signal(s, id, label, y, at) {
  const value = point('pressure').entropy?.signals[id], available = ['available', 'partial'].includes(value?.status) && Number.isFinite(value.value);
  const partial = value?.coverage === 'partial' || value?.status === 'partial';
  const displayed = available ? id === 'scatter' ? value.value.toFixed(2) : `${(value.value * 100).toFixed(1)}%` : 'Unavailable';
  s.box('', { x: 487, y, w: 650, h: 133, fill: '#fbfaf6', stroke: C.line, radius: 16, at, sfx: false });
  text(s, `${label}${partial ? ' · partial' : ''}`, 195, y - 25, at, { size: 40, maxWidth: 570 });
  text(s, displayed, 779, y + 23, at, { size: available ? 58 : 38, font: available ? 'display' : 'body', align: 'right', color: available ? 'purple' : 'muted', maxWidth: 570 });
}

export default {
  origin(s) {
    header(s, 'origin', '01 / REPOSITORY HISTORY');
    city(s, 'origin', '#start');
    metric(s, number(point('origin').files), 'source files at the start', 445, 443, '#detail');
    text(s, point('origin').date, 445, 635, '#finish', { size: 38, align: 'center', maxWidth: 610 });
    text(s, 'Measured city · AI narration', 1280, 862, '#finish', { size: 36, color: 'muted', align: 'center', maxWidth: 1000 });
  },
  boundaries(s) {
    header(s, 'boundaries', '02 / READING THE BOUNDARIES');
    s.draw({ x: 1360, y: 557, at: '#start' }, ctx => { ctx.fillStyle = '#e4e9dd'; ctx.strokeStyle = '#9eae95'; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(-380, -215, 760, 430, 30); ctx.fill(); ctx.stroke(); });
    text(s, 'A MODULE', 1360, 392, '#start', { size: 36, font: 'mono', align: 'center', maxWidth: 650 });
    s.box('Another module', { id: 'caller', x: 420, y: 577, w: 420, h: 130, size: 42, fill: '#fbfaf6', stroke: C.line, at: '#start', sfx: false });
    s.box('Public API', { id: 'gate', x: 1010, y: 672, w: 300, h: 120, size: 42, color: 'green', at: '#detail', sfx: false });
    s.arrow('caller', 'gate', { at: '#detail', color: C.green, width: 4, bend: .15, sfx: false });
    s.box('Private file', { id: 'private', x: 1400, y: 507, w: 360, h: 125, size: 42, color: 'purple', at: '#finish', sfx: false });
    s.arrow('caller', 'private', { at: '#finish', color: C.violet, width: 4, dashed: true, bend: -.24, sfx: false });
    text(s, 'Illustrative diagram · violet bypasses the public API', 960, 846, '#finish', { size: 36, align: 'center', color: 'muted', maxWidth: 1580 });
  },
  growth(s) {
    header(s, 'growth', '03 / CODE GROWTH');
    city(s, 'origin', '#start', { x: 700, y: 580, w: 1020, out: '#detail' });
    city(s, 'growth', '#detail', { x: 700, y: 580, w: 1020 });
    metric(s, number(report.history[0].files), 'source files', 1490, 451, '#start', { out: '#detail', exit: 'none' });
    metric(s, number(point('growth').files), 'source files', 1490, 451, '#detail');
    text(s, `${report.history[0].date} → ${point('growth').date}`, 1490, 650, '#detail', { size: 36, align: 'center', maxWidth: 520 });
    text(s, `${number(point('growth').lines)} source lines`, 1490, 763, '#finish', { size: 42, align: 'center', maxWidth: 520 });
  },
  pressure(s) {
    header(s, 'pressure', '04 / LAST SNAPSHOT · EXPERIMENTAL');
    const current = point('pressure'), value = current.entropy;
    if (value) {
      signal(s, 'rework', 'Rework', 405, '#start'); signal(s, 'scatter', 'Scatter / 1', 570, '#detail'); signal(s, 'shortcuts', 'Weighted shortcuts', 735, '#finish');
      const measured = ['complete', 'partial'].includes(value.status) && Number.isFinite(value.score);
      metric(s, measured ? value.score.toFixed(2) : 'Incomplete', measured ? value.status === 'partial' ? 'index / 1 · partial coverage' : 'experimental index / 1' : 'missing signals stay missing', 1360, 429, '#start', { size: measured ? 130 : 70 });
      chart(s, report.history.map(p => p.entropy?.score ?? null), 980, 612, 760, 133, '#detail', 'Index / 1 · gaps are missing data', 1);
    } else {
      metric(s, number(current.shortcuts), 'detected shortcuts', 485, 441, '#start');
      metric(s, number(current.imports), 'resolved imports', 485, 684, '#detail');
      chart(s, report.history.map(p => p.shortcuts), 980, 435, 760, 280, '#detail', 'Shortcut count over recorded history');
      text(s, 'Entropy measurements unavailable', 1360, 835, '#finish', { size: 36, align: 'center', color: 'muted', maxWidth: 790 });
    }
    text(s, 'Experimental · not a validated maintenance-cost predictor', 960, 878, '#finish', { size: 36, align: 'center', color: 'muted', maxWidth: 1600 });
  },
  findings(s) {
    header(s, 'findings', '05 / MODULES TO REVIEW');
    if (report.ranked.length) {
      text(s, 'MODULE', 196, 344, '#start', { size: 36, font: 'mono', color: 'muted' });
      text(s, 'INCOMING SHORTCUTS', 1730, 344, '#start', { size: 36, font: 'mono', color: 'muted', align: 'right', maxWidth: 650 });
      report.ranked.forEach((district, index) => {
        const y = 438 + index * 150, at = ['#start', '#detail', '#finish'][index];
        text(s, district.name, 196, y, at, { size: 59, font: 'display', maxWidth: 1120 });
        text(s, number(district.incoming), 1695, y, at, { size: 72, font: 'display', color: 'purple', align: 'right', maxWidth: 450 });
        text(s, district.inferred ? 'Inferred gate · confirm intent' : 'Declared public gate', 196, y + 57, at, { size: 36, color: 'muted', maxWidth: 1240 });
        s.line([[196, y + 90], [1730, y + 90]], { color: C.line, width: 2, at, sfx: false });
      });
      text(s, 'Review the intended API before changing a caller', 960, 878, '#finish', { size: 36, align: 'center', color: 'muted', maxWidth: 1600 });
    } else {
      metric(s, '0', 'detected private-import shortcuts', 960, 465, '#start');
      text(s, 'Static import coverage still applies', 960, 680, '#detail', { size: 42, align: 'center', color: 'muted', maxWidth: 1500 });
      text(s, 'No code-quality verdict is implied', 960, 794, '#finish', { size: 38, align: 'center', color: 'muted', maxWidth: 1500 });
    }
  },
  focus(s) {
    header(s, 'focus', '06 / A SPECIFIC DEPENDENCY');
    city(s, 'focus', '#start');
    text(s, 'Latest city overview', 1280, 865, '#finish', { size: 36, align: 'center', color: 'muted', maxWidth: 1000 });
    const focus = report.focus;
    metric(s, focus ? number(focus.incoming) : '—', focus ? 'incoming shortcuts' : 'no selected module', 445, 431, '#start');
    text(s, focus?.name || 'Define the intended public API', 164, 620, '#detail', { size: 54, font: 'display', maxWidth: 610 });
    text(s, focus?.target?.split('/').slice(-2).join('/') || 'No repeated private target selected', 164, 700, '#detail', { size: 38, font: focus?.target ? 'mono' : 'body', maxWidth: 610 });
    if (focus?.target) text(s, `${focus.importers} importers · ${focus.callingDistricts} calling districts`, 164, 773, '#finish', { size: 36, maxWidth: 610, color: 'muted' });
    text(s, focus?.inferred ? 'Inferred gate · confirm intent' : focus?.walled ? 'Declared public gate' : 'No declared gate', 164, 846, '#finish', { size: 36, maxWidth: 610, color: 'muted' });
  },
  outlook(s) {
    header(s, 'outlook', '07 / THE NEXT CHANGE');
    city(s, 'outlook', '#start', { out: report.portrait ? '#detail' : undefined });
    if (report.portrait) city(s, 'portrait', '#detail', { border: false });
    text(s, 'strata', 164, 445, '#start', { size: 128, font: 'display', maxWidth: 610 });
    text(s, report.name, 164, 582, '#detail', { size: 46, maxWidth: 610 });
    text(s, report.privacyLabel, 164, 662, '#finish', { size: 38, color: 'muted', maxWidth: 610 });
    text(s, report.portrait ? 'Generated illustration · interpretation' : 'Measured city view', 1280, 865, '#detail', { size: 36, align: 'center', color: 'muted', maxWidth: 1000 });
    text(s, 'Explainroo · OpenAI AI narration', 164, 800, '#finish', { size: 36, maxWidth: 610, color: 'muted' });
  }
};
