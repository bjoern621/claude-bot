/**
 * Long-term notes on each server and the people in it.
 *
 * Every question starts a fresh Claude session, so without these notes the bot
 * meets a regular like a stranger each time. Claude writes them itself through
 * the memory tools in discord-tools.js. Each write replaces the whole note, which
 * keeps it a condensed picture instead of a log that grows with every question.
 *
 * One JSON file per server under MEMORY_DIR. Unset, memory stays off: no tools,
 * no notes in the prompt and nothing on disk.
 *
 * The file is read once and then served from the cache. This process owns it:
 * a second replica writing the same directory would lose the other's notes.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_DIR = process.env.MEMORY_DIR || "";
export const memoryEnabled = MEMORY_DIR !== "";

/** Room for a profile, small enough that a handful of them fit every prompt. */
export const PERSON_NOTES_MAX_CHARS = Number(process.env.MEMORY_PERSON_MAX_CHARS ?? 1500);
export const SERVER_NOTES_MAX_CHARS = Number(process.env.MEMORY_SERVER_MAX_CHARS ?? 4000);

/** Guild ID to `{ server: { notes, updated_at }, people: { [userId]: { name, notes, updated_at } } }`. */
const cache = new Map();
/** Guild ID to the promise of its last write. Chains writes to one file in order. */
const writes = new Map();

function fileFor(guildId) {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error(`guildId must be a snowflake, got "${guildId}"`);
  return join(MEMORY_DIR, `${guildId}.json`);
}

async function load(guildId) {
  const held = cache.get(guildId);
  if (held) return held;

  let data;
  try {
    data = JSON.parse(await readFile(fileFor(guildId), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    data = { server: { notes: "", updated_at: null }, people: {} };
  }
  // Two questions can load the same guild at once. The first to finish wins,
  // so both go on to edit one object.
  if (!cache.has(guildId)) cache.set(guildId, data);
  return cache.get(guildId);
}

/**
 * Write the cached guild to disk. A rename replaces the file in one step, so a
 * crash mid-write leaves the previous version instead of half a file.
 */
function persist(guildId) {
  const file = fileFor(guildId);
  const previous = writes.get(guildId) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(MEMORY_DIR, { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(cache.get(guildId), null, 2));
    await rename(temp, file);
  });
  // A failed write must not block the ones queued behind it.
  writes.set(guildId, next.catch(() => {}));
  return next;
}

function checkLength(notes, max) {
  if (notes.length > max) {
    throw new Error(`Notes are ${notes.length} characters, the limit is ${max}. Condense them and try again.`);
  }
}

/**
 * The server notes and the notes on each of `people`, a map of user ID to the
 * name shown in the chat. A person without notes comes back with empty notes.
 */
export async function notesFor(guildId, people) {
  const data = await load(guildId);
  return {
    server: data.server.notes,
    people: [...people].map(([id, name]) => ({ id, name, notes: data.people[id]?.notes ?? "" })),
  };
}

/** Notes on one person. Returns null when there are none. */
export async function personNotes(guildId, userId) {
  const data = await load(guildId);
  return data.people[userId] ?? null;
}

/**
 * Replace the notes on one person. Empty notes delete the entry.
 * Errors if the notes exceed PERSON_NOTES_MAX_CHARS or the write fails.
 */
export async function rememberPerson(guildId, userId, name, notes) {
  const text = notes.trim();
  checkLength(text, PERSON_NOTES_MAX_CHARS);

  const data = await load(guildId);
  if (!text) {
    if (!data.people[userId]) return;
    delete data.people[userId];
  } else {
    data.people[userId] = { name, notes: text, updated_at: new Date().toISOString() };
  }
  await persist(guildId);
}

/**
 * Replace the server notes. Errors if they exceed SERVER_NOTES_MAX_CHARS or the
 * write fails.
 */
export async function rememberServer(guildId, notes) {
  const text = notes.trim();
  checkLength(text, SERVER_NOTES_MAX_CHARS);

  const data = await load(guildId);
  data.server = { notes: text, updated_at: new Date().toISOString() };
  await persist(guildId);
}
