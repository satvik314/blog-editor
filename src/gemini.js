import { GoogleGenAI } from '@google/genai';

const CREATE_SYSTEM = `You are Inkwell, an expert blog writer and editor.

The user gives you raw material (rough text, bullet notes, or a table of contents)
plus an instruction. Turn it into a polished blog post.

Rules:
- Output ONLY the blog post itself, in clean Markdown. No preamble, no commentary,
  no code fences around the whole post.
- Start with a single "# " H1 title.
- Use "## " section headings, short paragraphs, and Markdown formatting
  (bold, lists, quotes) where it genuinely helps.
- Keep one blank line between blocks. Never emit trailing whitespace.
- Match any tone, length or audience the instruction asks for.`;

const REVISE_SYSTEM = `You are Inkwell, an expert blog editor performing a tracked revision.

You receive the CURRENT version of a blog post plus a revision instruction.
Apply the instruction with surgical precision — your output is diffed line by line
against the current version to show the author exactly what changed.

Rules:
- Output ONLY the full revised blog post in Markdown. No preamble, no commentary,
  no code fences around the whole post.
- Change ONLY what the instruction requires. Every line the instruction does not
  touch must be reproduced EXACTLY, character for character — same wording,
  same punctuation, same blank lines.
- Do not reflow, reformat or "improve" untouched paragraphs.
- Keep one blank line between blocks. Never emit trailing whitespace.`;

const SEARCH_ADDENDUM = `

You have Google Search available. Use it to ground any facts, numbers, names or
recent events in real, current sources — but never include citation markers,
footnotes or a "Sources" section in the post itself.`;

/** Strip a wrapping ```markdown … ``` fence if the model added one anyway. */
export function cleanOutput(text) {
  let t = text.trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  return t;
}

/**
 * Stream a blog generation or revision from Gemini.
 * Yields { text } chunks as they arrive; if Google Search grounding was used,
 * a final { sources: [{ uri, title }] } event follows the text.
 */
export async function* streamBlog({ apiKey, model, thinkingLevel, draft, instruction, previous, useSearch }) {
  const ai = new GoogleGenAI({ apiKey });

  let prompt;
  if (previous) {
    prompt =
      `CURRENT BLOG POST:\n---\n${previous}\n---\n\n` +
      `REVISION INSTRUCTION: ${instruction}` +
      (draft.trim()
        ? `\n\nADDITIONAL SOURCE MATERIAL FROM THE AUTHOR (use only if relevant):\n---\n${draft}\n---`
        : '');
  } else {
    prompt =
      `SOURCE MATERIAL:\n---\n${draft}\n---\n\n` +
      `INSTRUCTION: ${instruction || 'Turn this into a polished, engaging blog post.'}`;
  }

  let systemInstruction = previous ? REVISE_SYSTEM : CREATE_SYSTEM;
  if (useSearch) systemInstruction += SEARCH_ADDENDUM;

  const config = {
    systemInstruction,
    temperature: previous ? 0.4 : 0.8,
  };

  // thinkingLevel is a Gemini 3 concept; older models would reject it.
  if (model.startsWith('gemini-3')) {
    config.thinkingConfig = { thinkingLevel };
  }

  // Google Search grounding: https://ai.google.dev/gemini-api/docs/google-search
  if (useSearch) {
    config.tools = [{ googleSearch: {} }];
  }

  const stream = await ai.models.generateContentStream({ model, contents: prompt, config });

  const sources = new Map();
  for await (const chunk of stream) {
    if (chunk.text) yield { text: chunk.text };
    const grounding = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (grounding) {
      for (const g of grounding) {
        if (g.web?.uri) sources.set(g.web.uri, { uri: g.web.uri, title: g.web.title || g.web.uri });
      }
    }
  }

  if (sources.size) yield { sources: [...sources.values()] };
}

/* ------------------------------------------------------------------ */
/* Conversation starters                                               */
/* ------------------------------------------------------------------ */

const STARTER_ANGLES = [
  'a contrarian take on popular advice',
  'a personal-story frame',
  'explaining a technical idea to a 12-year-old',
  'food, cooking or rituals around eating',
  'the future of work',
  'AI showing up in everyday life',
  'travel and a sense of place',
  'money and psychology',
  'a health or fitness myth worth busting',
  'creativity and craft',
  'the science of habits',
  'internet culture right now',
  'design, taste and why things feel good',
  'a moment in history that rhymes with today',
];

function pickAngles(n) {
  const pool = [...STARTER_ANGLES];
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/**
 * Ask Gemini for a fresh batch of conversation starters.
 * Returns [{ label, draft, instruction }]. Throws on failure — the caller
 * falls back to built-in starters.
 */
export async function fetchStarters({ apiKey, model, useSearch }) {
  const ai = new GoogleGenAI({ apiKey });

  const prompt =
    `You generate fresh writing sparks for Inkwell, a blog editor.\n\n` +
    `Return ONLY a JSON array (no markdown fences, no commentary) of exactly 4 objects with keys:\n` +
    `- "label": a short chip caption, max 6 words, starting with one fitting emoji\n` +
    `- "draft": a Markdown outline — a "# Title" line then 4–6 "- " bullets\n` +
    `- "instruction": one sentence telling the editor tone and length, ` +
    `e.g. "Write a witty 700-word post from this outline"\n\n` +
    `Make the 4 ideas genuinely diverse in topic and tone. ` +
    `Angle inspirations for this batch: ${pickAngles(3).join('; ')}.\n` +
    `Avoid clichés like "10 productivity tips".` +
    (useSearch
      ? `\nYou may use Google Search to see what is happening today and base at least one idea on current news.`
      : '');

  const config = { temperature: 1.0 };
  if (model.startsWith('gemini-3')) {
    config.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  }
  if (useSearch) config.tools = [{ googleSearch: {} }];

  const res = await ai.models.generateContent({ model, contents: prompt, config });

  let text = (res.text || '').trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  // Tolerate stray prose around the array.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in starters response.');

  const items = JSON.parse(text.slice(start, end + 1));
  const starters = items
    .filter((s) => s && typeof s.label === 'string' && typeof s.draft === 'string')
    .slice(0, 4)
    .map((s) => ({
      label: s.label.trim(),
      draft: s.draft.trim(),
      instruction: typeof s.instruction === 'string' ? s.instruction.trim() : '',
    }));

  if (!starters.length) throw new Error('Empty starters response.');
  return starters;
}
