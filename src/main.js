import './style.css';
import { marked } from 'marked';
import { streamBlog, cleanOutput, fetchStarters } from './gemini.js';
import { computeLineDiff, diffStats, collapseContext } from './diff-engine.js';

marked.setOptions({ gfm: true, breaks: false });

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'inkwell.settings.v1';
const VERSIONS_KEY = 'inkwell.versions.v1';

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.7-flash',
  thinkingLevel: 'LOW',
  theme: '', // '' = follow system; or 'paper' | 'sepia' | 'midnight' | 'noir'
  webSearch: false,
};

const state = {
  settings: { ...DEFAULT_SETTINGS, ...loadJSON(SETTINGS_KEY, {}) },
  versions: loadJSON(VERSIONS_KEY, []), // [{ id, ts, instruction, content, sources? }]
  selected: -1, // index into versions; -1 = none
  view: 'blog', // 'blog' | 'diff'
  generating: false,
  starters: null, // [{ label, draft, instruction }] once loaded
  startersLoading: false,
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
  themeBtn: $('themeBtn'),
  themeMenu: $('themeMenu'),
  webSearchBtn: $('webSearchBtn'),
  startersRow: $('startersRow'),
  refreshStartersBtn: $('refreshStartersBtn'),
};

/* ------------------------------------------------------------------ */
/* Themes                                                             */
/* ------------------------------------------------------------------ */

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  return state.settings.theme || (systemDark.matches ? 'midnight' : 'paper');
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  els.themeMenu.querySelectorAll('.theme-opt').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.theme === theme);
  });
}

function toggleThemeMenu(open) {
  const show = open ?? els.themeMenu.hidden;
  els.themeMenu.hidden = !show;
  els.themeBtn.setAttribute('aria-expanded', String(show));
}

els.themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu();
});

els.themeMenu.addEventListener('click', (e) => {
  const opt = e.target.closest('.theme-opt');
  if (!opt) return;
  state.settings.theme = opt.dataset.theme;
  saveSettings();
  applyTheme();
  toggleThemeMenu(false);
});

document.addEventListener('click', (e) => {
  if (!els.themeMenu.hidden && !e.target.closest('.theme-wrap')) toggleThemeMenu(false);
});

// Follow the OS until the user picks a theme explicitly.
systemDark.addEventListener('change', () => {
  if (!state.settings.theme) applyTheme();
});

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
    ensureStarters();
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
    if (version.sources?.length) els.blogView.appendChild(makeSourcesBlock(version.sources));
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

/** Grounding sources come from the open web — build with DOM APIs, never innerHTML. */
function makeSourcesBlock(sources) {
  const wrap = document.createElement('aside');
  wrap.className = 'sources';

  const head = document.createElement('div');
  head.className = 'sources-head';
  head.textContent = '🌐 Grounded with Google Search';
  wrap.appendChild(head);

  const list = document.createElement('ul');
  list.className = 'sources-list';
  for (const s of sources) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.uri;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = s.title;
    li.appendChild(a);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
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
  let sources = null;
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
      useSearch: state.settings.webSearch,
    });

    for await (const ev of stream) {
      if (ev.sources) sources = ev.sources;
      if (!ev.text) continue;
      text += ev.text;
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
      ...(sources ? { sources } : {}),
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
/* Web search toggle                                                  */
/* ------------------------------------------------------------------ */

function syncWebSearchBtn() {
  els.webSearchBtn.classList.toggle('is-on', state.settings.webSearch);
  els.webSearchBtn.setAttribute('aria-pressed', String(state.settings.webSearch));
}

els.webSearchBtn.addEventListener('click', () => {
  state.settings.webSearch = !state.settings.webSearch;
  saveSettings();
  syncWebSearchBtn();
  toast(
    state.settings.webSearch
      ? 'Web grounding on 🌐 — Gemini will pull in live Google Search results'
      : 'Web grounding off — writing from the model alone'
  );
});

/* ------------------------------------------------------------------ */
/* Conversation starters                                              */
/* ------------------------------------------------------------------ */

const FALLBACK_STARTERS = [
  { label: '🌅 The case against 5am', draft: '# The Case Against Waking Up at 5am\n- where hustle-morning culture came from\n- what sleep research actually says\n- night owls who built empires\n- designing a morning around your chronotype', instruction: 'Write a punchy 600-word contrarian post from this outline' },
  { label: '🍜 Recipes are just algorithms', draft: '# Recipes Are Just Algorithms You Can Eat\n- what a recipe and a program have in common\n- inputs, loops and error handling in the kitchen\n- why grandmothers are great debuggers\n- an exercise: refactor your favorite dish', instruction: 'Write a playful 700-word post for curious non-programmers' },
  { label: '🤖 My week with an AI copilot', draft: '# A Week of Letting AI Draft Everything First\n- the experiment and the rules\n- where it saved hours\n- where it fell on its face\n- what I now let it own, and what I took back', instruction: 'Write a candid first-person 800-word post from this outline' },
  { label: '💸 Why budgets fail', draft: '# Budgets Fail Because Feelings Beat Spreadsheets\n- the psychology of the impulse buy\n- why tracking apps rarely change behavior\n- friction as a money strategy\n- three tiny systems that actually stick', instruction: 'Write a warm, practical 650-word post from this outline' },
  { label: '🗺️ In defense of getting lost', draft: '# In Defense of Getting Lost on Purpose\n- travel before turn-by-turn navigation\n- what wandering does to memory and mood\n- a game: the coin-flip walk\n- souvenirs you can only find off-route', instruction: 'Write an evocative 600-word essay from this outline' },
  { label: '🧠 Habits are interfaces', draft: '# Your Habits Are an Interface to Your Future Self\n- habits as buttons you press daily\n- default settings vs conscious design\n- shrinking a habit until it is laughably easy\n- reviewing your "UI" once a season', instruction: 'Write a crisp 700-word post with concrete examples' },
  { label: '🎨 Taste is a skill', draft: '# Taste Is a Skill, Not a Gift\n- what "good taste" actually is\n- collecting influences deliberately\n- the gap between your taste and your output\n- exercises to train your eye this month', instruction: 'Write an encouraging 700-word post for makers' },
  { label: '📚 History rhymes with your feed', draft: '# The Printing Press Panic, and Your Feed\n- the moral panic when print arrived\n- what critics feared then vs now\n- what actually changed for readers\n- lessons for living through the AI wave', instruction: 'Write a thoughtful 750-word post connecting past and present' },
];

function sampleFallbackStarters() {
  const pool = [...FALLBACK_STARTERS];
  const out = [];
  while (out.length < 4 && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function renderStarterSkeletons() {
  els.startersRow.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const sk = document.createElement('span');
    sk.className = 'starter-chip starter-skeleton';
    sk.style.width = `${110 + ((i * 37) % 70)}px`;
    els.startersRow.appendChild(sk);
  }
}

function renderStarters() {
  els.startersRow.innerHTML = '';
  for (const s of state.starters ?? []) {
    const chip = document.createElement('button');
    chip.className = 'starter-chip';
    chip.textContent = s.label;
    chip.title = s.instruction || 'Load this idea into the draft pane';
    chip.addEventListener('click', () => {
      els.draft.value = s.draft;
      els.instruction.value = s.instruction || '';
      updateWordCount();
      els.draft.focus();
      toast('Starter loaded — tweak it, then hit Generate ✦');
    });
    els.startersRow.appendChild(chip);
  }
}

async function loadStarters() {
  if (state.startersLoading) return;
  state.startersLoading = true;
  renderStarterSkeletons();

  try {
    if (!apiKey()) throw new Error('no key');
    state.starters = await fetchStarters({
      apiKey: apiKey(),
      model: state.settings.model,
      useSearch: state.settings.webSearch,
    });
  } catch (err) {
    // Offline / no key / bad JSON: shuffle the built-in deck instead.
    console.warn('Starters fell back to built-ins:', err);
    state.starters = sampleFallbackStarters();
  } finally {
    state.startersLoading = false;
    renderStarters();
  }
}

/** Fetch once per app load, the first time the empty state is shown. */
function ensureStarters() {
  if (state.starters || state.startersLoading) return;
  loadStarters();
}

els.refreshStartersBtn.addEventListener('click', () => {
  if (state.startersLoading) return;
  state.starters = null;
  loadStarters();
});

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
  if (e.key === 'Escape') {
    if (!els.settingsModal.hidden) closeSettings();
    if (!els.themeMenu.hidden) toggleThemeMenu(false);
  }
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

applyTheme();
syncWebSearchBtn();
updateWordCount();
syncViewToggle();
render();

if (!apiKey()) {
  setTimeout(() => toast('Welcome to Inkwell 🖋️ Add your Gemini API key in Settings to begin.'), 700);
}
