# 🖋️ Inkwell — a blog editor that shows its work

Drop a rough draft or a table of contents on the left, tell Inkwell what you want,
and it writes the blog on the right — powered by **Gemini 3.7 Flash**. Every time you
revise, Inkwell tracks **exactly which lines were added, modified, or removed**, down
to the individual words that changed.

## ✨ Features

- **Split-pane editor** — your raw material on the left, the generated blog on the right
- **Line-level change tracking** — a GitHub-style diff view with old/new line numbers,
  `+` / `~` / `−` gutters, and word-level highlights inside modified lines
- **Version history** — every generation becomes a version chip (`v1 v2 v3…`);
  click any version to read it and see what changed from the one before
- **Live streaming** — watch the blog write itself, with a blinking ink caret
- **Iterate naturally** — revise with plain instructions ("make the intro punchier"),
  or click *Make this my draft* to pull a version back into the editor
- **Micro-interactions everywhere** — springy buttons, staggered diff reveals,
  counting stat chips, confetti on your first draft, a wobbling ink-drop logo 🖋️

Versions and settings persist in `localStorage`, so your work survives a refresh.

## 🚀 Getting started

```bash
npm install
npm run dev
```

Then add your Gemini API key, either:

1. **In the app** — click the ⚙️ settings gear and paste your key (stored only in your browser), or
2. **Via env file** — `cp .env.example .env.local` and set `VITE_GEMINI_API_KEY`

Get a free key at [Google AI Studio](https://aistudio.google.com/apikey).

## 🕹️ How to use it

1. Paste a draft, notes, or a table of contents into the left pane
2. Type an instruction — e.g. *"Write a friendly 600-word blog from this outline"* —
   and hit **Generate** (or `⌘⏎` / `Ctrl+Enter`)
3. Read the blog in **📖 Blog** view
4. Ask for a revision — e.g. *"Add a section on pricing, tighten the intro"*
5. Flip to **🔍 Changes** to see exactly what the revision touched:
   - <span>🟩</span> **added** lines
   - <span>🟨</span> **modified** lines (with the changed words highlighted)
   - <span>🟥</span> **removed** lines
   - long unchanged runs collapse into a click-to-expand fold
6. Repeat. Every version stays one click away in the top rail.

## ⚙️ Configuration

In Settings you can pick the model (`gemini-3.7-flash` by default, with
`gemini-3-flash-preview` and `gemini-2.5-flash` as alternates) and the
**thinking level** for Gemini 3 models (Minimal → High). Revisions run at low
temperature and are explicitly prompted to keep untouched lines byte-identical,
which is what keeps the diffs surgical.

## 🧱 Stack

- [Vite](https://vite.dev) + vanilla JavaScript — no framework
- [`@google/genai`](https://www.npmjs.com/package/@google/genai) — official Google Gen AI SDK (streaming)
- [`diff`](https://www.npmjs.com/package/diff) — line + word diffing
- [`marked`](https://www.npmjs.com/package/marked) — Markdown rendering
