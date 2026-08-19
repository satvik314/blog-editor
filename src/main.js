import './style.css';
import { marked } from 'marked';
import { streamBlog, cleanOutput } from './gemini.js';
import { computeLineDiff, diffStats, collapseContext } from './diff-engine.js';

marked.setOptions({ gfm: true, breaks: false });

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'inkwell.settings.v1';
const VERSIONS_KEY = 'inkwell.versions.v1';

const state = {
  settings: loadJSON(SETTINGS_KEY, {
    apiKey: '',
    model: 'gemini-3.7-flash',
    thinkingLevel: 'LOW',
  }),
  versions: loadJSON(VERSIONS_KEY, []), // [{ id, ts, instruction, content }]
  selected: -1, // index into versions; -1 = none
  view: 'blog', // 'blog' | 'diff'
  generating: false,
};
state.selected = state.versions.length - 1;

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
const saveVersions = () => localStorage.setItem(VERSIONS_KEY, JSON.stringify(state.versions));

function apiKey() {
  return state.settings.apiKey || import.meta.env.VITE_GEMINI_API_KEY || '';
}

/* ------------------------------------------------------------------ */
/* Elements                                                           */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const els = {
  draft: $('draftInput'),
  instruction: $('instructionInput'),
  generateBtn: $('generateBtn'),
  wordCount: $('wordCount'),
  versionRail: $('versionRail'),
  viewToggle: $('viewToggle'),
  changesBadge: $('changesBadge'),
  statsBar: $('statsBar'),
  statAdd: $('statAdd'),
  statMod: $('statMod'),
  statDel: $('statDel'),
  copyBtn: $('copyBtn'),
  adoptBtn: $('adoptBtn'),
  emptyState: $('emptyState'),
  blogView: $('blogView'),
  diffView: $('diffView'),
  diffTable: $('diffTable'),
  diffCompareLabel: $('diffCompareLabel'),
  outputBody: $('outputBody'),
  streamNote: $('streamNote'),
  settingsModal: $('settingsModal'),
  settingsBtn: $('settingsBtn'),
  settingsClose: $('settingsClose'),
  settingsSave: $('settingsSave'),
  apiKeyInput: $('apiKeyInput'),
  modelSelect: $('modelSelect'),
  thinkingSelect: $('thinkingSelect'),
  clearHistoryBtn: $('clearHistoryBtn'),
  toastHost: $('toastHost'),
  confettiHost: $('confettiHost'),
  brand: $('brand'),
  dividerOrb: $('dividerOrb'),
};

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

function currentVersion() {
  return state.versions[state.selected] ?? null;
}
function previousVersion() {
  return state.versions[state.selected - 1] ?? null;
}

function render() {
  renderVersionRail();
  renderOutput();
}

function renderVersionRail() {
  els.versionRail.innerHTML = '';
  state.versions.forEach((v, i) => {
    const chip = document.createElement('button');
    chip.className = 'version-chip' + (i === state.selected ? ' is-current' : '');
    chip.textContent = `v${i + 1}`;
    chip.title = v.instruction
      ? `v${i + 1} — “${v.instruction}”`
      : `v${i + 1}`;
    chip.addEventListener('click', () => {
      state.selected = i;
      render();
    });
    els.versionRail.appendChild(chip);
  });
}

function renderOutput({ animateDiff = false } = {}) {
  const version = currentVersion();
  const hasVersion = Boolean(version);

  els.emptyState.hidden = hasVersion || state.generating;
  els.copyBtn.hidden = !hasVersion;
  els.adoptBtn.hidden = !hasVersion;

  if (!hasVersion) {
    els.blogView.hidden = true;
    els.diffView.hidden = true;
    els.statsBar.hidden = true;
    els.changesBadge.hidden = true;
    return;
  }

  // Diff vs the version right before the selected one.
  const prev = previousVersion();
  const rows = computeLineDiff(prev ? prev.content : '', version.content);
  const stats = diffStats(rows);

  animateCount(els.statAdd, stats.add);
  animateCount(els.statMod, stats.mod);
  animateCount(els.statDel, stats.del);
  els.statsBar.hidden = false;

  els.changesBadge.textContent = stats.total;
  els.changesBadge.hidden = stats.total === 0;

  els.diffCompareLabel.textContent = prev
    ? `v${state.selected} → v${state.selected + 1}`
    : `blank page → v${state.selected + 1}`;

  if (state.view === 'blog') {
    els.blogView.hidden = false;
    els.diffView.hidden = true;
    els.blogView.innerHTML = marked.parse(version.content);
  } else {
    els.blogView.hidden = true;
    els.diffView.hidden = false;
    renderDiffTable(rows, { animate: animateDiff });
  }
}

function renderDiffTable(rows, { animate = false } = {}) {
  els.diffTable.innerHTML = '';
  const items = collapseContext(rows);
  let revealIndex = 0;

  for (const item of items) {
    if (item.kind === 'collapsed') {
      els.diffTable.appendChild(makeCollapsedRow(item.rows));
    } else {
      for (const row of item.rows) {
        const el = makeDiffRow(row);
        if (animate && row.type !== 'context') {
          el.classList.add('diff-reveal');
          el.style.animationDelay = `${Math.min(revealIndex * 45, 900)}ms`;
          revealIndex += 1;
        }
        els.diffTable.appendChild(el);
      }
    }
  }
}

function makeCollapsedRow(rows) {
  const btn = document.createElement('button');
  btn.className = 'diff-collapsed';
  btn.innerHTML = `<span class="collapsed-dots">⋯</span> ${rows.length} unchanged lines <span class="collapsed-hint">click to expand</span>`;
  btn.addEventListener('click', () => {
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(makeDiffRow(row));
    btn.replaceWith(frag);
  });
  return btn;
}

const TYPE_SIGN = { context: '', add: '+', del: '−', mod: '~' };

function makeDiffRow(row) {
  const el = document.createElement('div');
  el.className = `diff-row diff-${row.type}`;

  const oldNo = document.createElement('span');
  oldNo.className = 'diff-no';
  oldNo.textContent = row.oldNo ?? '';

  const newNo = document.createElement('span');
  newNo.className = 'diff-no';
  newNo.textContent = row.newNo ?? '';

  const sign = document.createElement('span');
  sign.className = 'diff-sign';
  sign.textContent = TYPE_SIGN[row.type];

  const content = document.createElement('span');
  content.className = 'diff-content';

  if (row.type === 'mod') {
    // old line with removed words struck out, then new line with added words lit up
    const oldLine = document.createElement('span');
    oldLine.className = 'mod-old';
    const newLine = document.createElement('span');
    newLine.className = 'mod-new';
    for (const seg of row.segments) {
      if (seg.removed) oldLine.appendChild(mark(seg.value, 'word-del'));
      else if (seg.added) newLine.appendChild(mark(seg.value, 'word-add'));
      else {
        oldLine.appendChild(document.createTextNode(seg.value));
        newLine.appendChild(document.createTextNode(seg.value));
      }
    }
    content.append(oldLine, newLine);
  } else {
    content.textContent = row.content === '' ? ' ' : row.content;
  }

  el.append(oldNo, newNo, sign, content);
  return el;
}

function mark(text, cls) {
  const m = document.createElement('mark');
  m.className = cls;
  m.textContent = text;
  return m;
}

/* ------------------------------------------------------------------ */
/* Generation flow                                                    */
/* ------------------------------------------------------------------ */

async function generate() {
  if (state.generating) return;

  const draft = els.draft.value;
  const instruction = els.instruction.value.trim();
  const latest = state.versions[state.versions.length - 1] ?? null;

  if (!latest && !draft.trim()) {
    shake(els.draft.closest('.draft-wrap'));
    toast('Give me something to work with — a draft, notes, or an outline ✍️');
    els.draft.focus();
    return;
  }
  if (latest && !instruction && !draft.trim()) {
    shake(els.instruction.closest('.instruction-field'));
    toast('Tell me how to revise this version 🔧');
    els.instruction.focus();
    return;
  }
  if (!apiKey()) {
    toast('Add your Gemini API key first 🔑');
    openSettings(true);
    return;
  }

  setGenerating(true);

  // Streaming preview: show live markdown in the blog view.
  state.view = 'blog';
  syncViewToggle();
  els.emptyState.hidden = true;
  els.diffView.hidden = true;
  els.blogView.hidden = false;
  els.blogView.innerHTML = '';
  els.blogView.classList.add('is-streaming');
  els.streamNote.hidden = false;

  let text = '';
  let renderQueued = false;
  const paintStream = () => {
    renderQueued = false;
    els.blogView.innerHTML = marked.parse(text) + '<span class="stream-caret"></span>';
    els.outputBody.scrollTop = els.outputBody.scrollHeight;
  };

  try {
    const stream = streamBlog({
      apiKey: apiKey(),
      model: state.settings.model,
      thinkingLevel: state.settings.thinkingLevel,
      draft,
      instruction,
      previous: latest?.content ?? null,
    });

    for await (const chunk of stream) {
      text += chunk;
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(paintStream);
      }
    }

    const content = cleanOutput(text);
    if (!content) throw new Error('The model returned an empty response.');

    const isFirst = state.versions.length === 0;
    state.versions.push({
      id: crypto.randomUUID(),
      ts: Date.now(),
      instruction: instruction || (isFirst ? 'First draft' : 'Revision'),
      content,
    });
    saveVersions();
    state.selected = state.versions.length - 1;

    els.instruction.value = '';
    state.view = isFirst ? 'blog' : 'diff';
    syncViewToggle();
    render();
    renderOutput({ animateDiff: true });

    if (isFirst) {
      confetti();
      toast('First draft, poured. ✨ Revise it and watch the changes light up.');
    } else {
      const stats = diffStats(computeLineDiff(latest.content, content));
      toast(`v${state.versions.length} ready — +${stats.add} ~${stats.mod} −${stats.del} lines`);
    }
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), 'error');
    render(); // restore whatever we had
  } finally {
    els.blogView.classList.remove('is-streaming');
    els.streamNote.hidden = true;
    setGenerating(false);
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/API key|API_KEY|401|403|PERMISSION/i.test(msg)) return 'That API key was rejected — double-check it in Settings 🔑';
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(msg)) return 'Rate limit hit — give it a breath and try again 🫁';
  if (/not found|404/i.test(msg)) return `Model “${state.settings.model}” not available on this key — try another in Settings`;
  if (/fetch|network|Failed to fetch/i.test(msg)) return 'Network hiccup — check your connection and retry 🌐';
  return `Generation failed: ${msg.slice(0, 140)}`;
}

function setGenerating(on) {
  state.generating = on;
  els.generateBtn.classList.toggle('is-loading', on);
  els.generateBtn.disabled = on;
  document.body.classList.toggle('is-generating', on);
}

/* ------------------------------------------------------------------ */
/* Micro-interactions                                                 */
/* ------------------------------------------------------------------ */

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  els.toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => {
    el.classList.remove('is-in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600); // safety
  }, 3600);
}

function shake(el) {
  if (!el) return;
  el.classList.remove('do-shake');
  void el.offsetWidth;
  el.classList.add('do-shake');
}

function animateCount(el, target) {
  const start = Number(el.textContent) || 0;
  if (start === target) {
    el.textContent = target;
    return;
  }
  const t0 = performance.now();
  const dur = 500;
  const step = (t) => {
    const p = Math.min((t - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const CONFETTI_COLORS = ['#6C5CE7', '#FF5C7C', '#FFB86B', '#3EC98E', '#4EA8DE', '#1C1A17'];

function confetti() {
  const host = els.confettiHost;
  for (let i = 0; i < 36; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti-bit';
    const size = 6 + Math.random() * 8;
    bit.style.cssText = `
      left:${8 + Math.random() * 84}vw;
      width:${size}px; height:${size * (Math.random() > 0.5 ? 1 : 0.4)}px;
      background:${CONFETTI_COLORS[i % CONFETTI_COLORS.length]};
      animation-duration:${1400 + Math.random() * 1400}ms;
      animation-delay:${Math.random() * 300}ms;
      --drift:${(Math.random() - 0.5) * 40}vw;
      --spin:${Math.round((Math.random() - 0.5) * 900)}deg;
    `;
    host.appendChild(bit);
    bit.addEventListener('animationend', () => bit.remove(), { once: true });
  }
}

/* ------------------------------------------------------------------ */
/* Settings modal                                                     */
/* ------------------------------------------------------------------ */

function openSettings(highlightKey = false) {
  els.apiKeyInput.value = state.settings.apiKey;
  els.modelSelect.value = state.settings.model;
  els.thinkingSelect.value = state.settings.thinkingLevel;
  els.settingsModal.hidden = false;
  requestAnimationFrame(() => els.settingsModal.classList.add('is-open'));
  if (highlightKey) {
    els.apiKeyInput.focus();
    shake(els.apiKeyInput.closest('.field'));
  }
}

function closeSettings() {
  els.settingsModal.classList.remove('is-open');
  setTimeout(() => (els.settingsModal.hidden = true), 220);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

function syncViewToggle() {
  els.viewToggle.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === state.view);
  });
}

els.viewToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || state.generating) return;
  state.view = btn.dataset.view;
  syncViewToggle();
  renderOutput({ animateDiff: state.view === 'diff' });
});

els.generateBtn.addEventListener('click', generate);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    generate();
  }
  if (e.key === 'Escape' && !els.settingsModal.hidden) closeSettings();
});

els.instruction.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    generate();
  }
});

const updateWordCount = () => {
  const words = els.draft.value.trim() ? els.draft.value.trim().split(/\s+/).length : 0;
  els.wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
};
els.draft.addEventListener('input', updateWordCount);

els.copyBtn.addEventListener('click', async () => {
  const version = currentVersion();
  if (!version) return;
  try {
    await navigator.clipboard.writeText(version.content);
    els.copyBtn.classList.add('is-copied');
    toast('Markdown copied 📋');
    setTimeout(() => els.copyBtn.classList.remove('is-copied'), 1600);
  } catch {
    toast('Could not reach the clipboard', 'error');
  }
});

els.adoptBtn.addEventListener('click', () => {
  const version = currentVersion();
  if (!version) return;
  els.draft.value = version.content;
  updateWordCount();
  shake(els.adoptBtn);
  toast(`v${state.selected + 1} is now your draft — edit away, then regenerate`);
});

els.settingsBtn.addEventListener('click', () => openSettings());
els.settingsClose.addEventListener('click', closeSettings);
els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) closeSettings();
});

els.settingsSave.addEventListener('click', () => {
  state.settings.apiKey = els.apiKeyInput.value.trim();
  state.settings.model = els.modelSelect.value;
  state.settings.thinkingLevel = els.thinkingSelect.value;
  saveSettings();
  closeSettings();
  toast('Settings saved ✓');
});

els.clearHistoryBtn.addEventListener('click', () => {
  if (state.versions.length && !confirm('Clear all versions? This cannot be undone.')) return;
  state.versions = [];
  state.selected = -1;
  saveVersions();
  closeSettings();
  render();
  toast('Fresh inkwell — history cleared 🫙');
});

// A tiny hello: wobble the ink drop when you poke the brand.
els.brand.addEventListener('click', () => {
  els.brand.classList.remove('do-wobble');
  void els.brand.offsetWidth;
  els.brand.classList.add('do-wobble');
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

updateWordCount();
syncViewToggle();
render();

if (!apiKey()) {
  setTimeout(() => toast('Welcome to Inkwell 🖋️ Add your Gemini API key in Settings to begin.'), 700);
}
