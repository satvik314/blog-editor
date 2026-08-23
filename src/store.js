import { createClient } from '@supabase/supabase-js';

/**
 * Where Inkwell keeps its version history.
 *
 * With VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY set, versions live in
 * Postgres and follow you across browsers. Without them, Inkwell falls back to
 * localStorage exactly as it always did — the app still runs with no backend.
 *
 * localStorage is kept as a write-through mirror even in cloud mode, so a
 * network blip shows you the last known rail instead of a blank page.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const MIRROR_KEY = 'inkwell.versions.v1';

/** True when this build is pointed at a Supabase project. */
export const isCloud = Boolean(SUPABASE_URL && SUPABASE_KEY);

const db = isCloud ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/* ------------------------------------------------------------------ */
/* localStorage mirror                                                */
/* ------------------------------------------------------------------ */

function readMirror() {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeMirror(versions) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(versions));
  } catch {
    /* quota or private mode — the cloud copy is the one that matters */
  }
}

/* ------------------------------------------------------------------ */
/* Row <-> version                                                    */
/* ------------------------------------------------------------------ */

const toVersion = (row) => ({
  id: row.id,
  ts: Date.parse(row.created_at),
  instruction: row.instruction,
  content: row.content,
});

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

/**
 * Every version, oldest first.
 * Returns { versions, degraded } — degraded means the cloud read failed and
 * these came from the local mirror instead.
 */
export async function loadVersions() {
  if (!db) return { versions: readMirror(), degraded: false };

  const { data, error } = await db
    .from('versions')
    .select('id, instruction, content, created_at')
    .order('seq', { ascending: true });

  if (error) return { versions: readMirror(), degraded: true, error };

  const versions = data.map(toVersion);
  writeMirror(versions);
  return { versions, degraded: false };
}

/**
 * Append one version. The mirror is written first so the UI never loses a
 * generation the model already paid for, even if the insert fails.
 */
export async function saveVersion(version, allVersions) {
  writeMirror(allVersions);
  if (!db) return { synced: true };

  const { error } = await db.from('versions').insert({
    id: version.id,
    instruction: version.instruction,
    content: version.content,
    created_at: new Date(version.ts).toISOString(),
  });

  return error ? { synced: false, error } : { synced: true };
}

/** Drop the whole history. */
export async function clearVersions() {
  writeMirror([]);
  if (!db) return { synced: true };

  const { error } = await db.from('versions').delete().gte('seq', 0);
  return error ? { synced: false, error } : { synced: true };
}
