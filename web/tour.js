import { defaultStory } from './film-data.js';
import { entropyCard } from './entropy.js';

const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ''; if (text) node.textContent = text; return node; };
export function openTour(data, { showSnapshot, focus, overview, setMode, replay, exploreHistory, close: onClose }) {
  const story = defaultStory(data), panel = el('aside', 'tour-panel'); panel.ariaLabel = 'Codebase walkthrough';
  const header = el('div', 'tour-header'), counter = el('span', 'eyebrow'), close = el('button', 'icon-button', '×'); close.ariaLabel = 'Close walkthrough'; header.append(counter, close);
  const title = el('h2'), caption = el('p', 'tour-caption'), content = el('div', 'tour-content');
  const nav = el('div', 'tour-nav'), prev = el('button', 'secondary-button', '← Back'), next = el('button', 'primary', 'Next →'); nav.append(prev, next);
  const steps = el('nav', 'tour-steps'); steps.ariaLabel = 'Walkthrough chapters';
  const names = ['The city today', 'Module boundaries', 'Watch it grow', 'Entropy & shortcuts', 'Read the changes', 'One example', 'Explore freely'];
  const buttons = names.map((name, i) => { const button = el('button', '', String(i + 1).padStart(2, '0') + '  ' + name); button.onclick = () => go(i); steps.append(button); return button; });
  panel.append(header, title, caption, content, nav, el('p', 'tour-hint', 'The city is live. Click a building, rotate the view, or scrub the timeline at any point.'), steps);
  document.querySelector('main').append(panel); document.body.classList.add('touring'); let index = 0;
  function go(i) {
    index = Math.max(0, Math.min(story.chapters.length - 1, i)); const chapter = story.chapters[index], snapshotIndex = index < 2 ? data.snapshots.length - 1 : chapter.snapshot, snapshot = data.snapshots[snapshotIndex];
    showSnapshot(snapshotIndex); setMode(['pressure', 'findings', 'focus'].includes(chapter.id) ? 'shortcuts' : 'city');
    if (chapter.id === 'focus' && chapter.district) focus(chapter.district); else overview();
    counter.textContent = `GUIDED TOUR / ${String(index + 1).padStart(2, '0')}`; title.textContent = index ? chapter.title : 'What changed?'; caption.textContent = index ? chapter.caption : `${data.meta.name} now has ${Object.keys(snapshot.files).length.toLocaleString()} source files. Rewind its history, then look at the dependencies worth reviewing.`;
    prev.disabled = index === 0; next.textContent = index === story.chapters.length - 1 ? 'Keep exploring ↗' : 'Next →';
    buttons.forEach((button, j) => { button.classList.toggle('active', j === index); button.ariaCurrent = j === index ? 'step' : 'false'; });
    content.replaceChildren();
    if (chapter.id === 'boundaries') {
      for (const [word, meaning] of [['Building', 'A source file. Height follows line count.'], ['Wall', 'A module boundary. Related code belongs inside.'], ['Gate', 'The public API other modules should use.'], ['Violet arc', 'An import that bypasses a gate.']]) { const row = el('p'); row.append(el('strong', '', word + ' '), document.createTextNode(meaning)); content.append(row); }
      const district = snapshot.districts.find(d => d.walled); if (district) { const inspect = el('button', 'secondary-button', 'Show a boundary ↗'); inspect.onclick = () => focus(district.id); content.append(inspect); }
    }
    if (chapter.id === 'growth') {
      const play = el('button', 'secondary-button', '▶ Replay the growth'); play.onclick = () => replay(); content.append(play);
    }
    if (chapter.id === 'pressure') {
      const card = el('section', 'entropy-card'); card.innerHTML = entropyCard(snapshot.entropy); card.querySelector('details').open = true;
      content.append(card);
    }
    if (chapter.id === 'findings' || chapter.id === 'outlook') {
      if (exploreHistory) {
        if (chapter.id === 'findings') {
          title.textContent = 'What changed—and why?';
          caption.textContent = 'Decisions reads commit diffs to identify repairs, reversals and features. Inspect the evidence, then compare the city views.';
        }
        const changes = el('button', 'primary', 'Read the changes · Decisions ↗');
        changes.onclick = exploreHistory; content.append(changes);
      }
      for (const d of [...snapshot.districts].filter(d => d.walled && d.incoming).sort((a, b) => b.incoming - a.incoming).slice(0, 3)) { const button = el('button', 'tour-finding'); button.append(el('span', '', d.name.replaceAll('_', ' ')), el('b', '', d.incoming + ' ↗')); button.onclick = () => focus(d.id); content.append(button); }
    }
    panel.scrollTop = 0;
  }
  const dispose = () => { document.body.classList.remove('touring'); panel.remove(); onClose?.(); };
  close.onclick = dispose; prev.onclick = () => go(index - 1); next.onclick = () => index === story.chapters.length - 1 ? dispose() : go(index + 1);
  go(0); return dispose;
}
