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

/** Strip a wrapping ```markdown … ``` fence if the model added one anyway. */
export function cleanOutput(text) {
  let t = text.trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  return t;
}

/**
 * Stream a blog generation or revision from Gemini.
 * Yields text chunks as they arrive.
 */
export async function* streamBlog({ apiKey, model, thinkingLevel, draft, instruction, previous }) {
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

  const config = {
    systemInstruction: previous ? REVISE_SYSTEM : CREATE_SYSTEM,
    temperature: previous ? 0.4 : 0.8,
  };

  // thinkingLevel is a Gemini 3 concept; older models would reject it.
  if (model.startsWith('gemini-3')) {
    config.thinkingConfig = { thinkingLevel };
  }

  const stream = await ai.models.generateContentStream({ model, contents: prompt, config });

  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}
