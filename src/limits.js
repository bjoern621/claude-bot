/**
 * Admission control for paid work.
 *
 * Every accepted question spends subscription quota, and nothing in Discord
 * stops one person from asking a hundred times a minute. The concurrency gate in
 * claude.js is not a defence against that: it serialises the same spend rather
 * than refusing it. These limits refuse the request outright, before any of it
 * reaches Claude.
 *
 * Three windows, all enforced together. The per-user hour keeps one person from
 * eating the budget; the global hour bounds a burst from a whole channel; the
 * global day is the backstop that a slow drip cannot walk past.
 *
 * State is in-process, so a restart forgives every window. That is the accepted
 * cost of keeping the bot stateless: the limits bound a spending rate, and a bot
 * restarting often enough to matter has a worse problem than a forgiven hour.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long a refused user is left alone before being told again. */
const NOTICE_COOLDOWN_MS = 60_000;

/** Above this many tracked users, drop the ones whose windows have emptied. */
const SWEEP_AT = 500;

function limit(name, fallback) {
  const raw = process.env[name];
  if (raw === "off") return Infinity;
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer or "off", got "${raw}".`);
    process.exit(1);
  }
  return value;
}

const PER_USER_HOUR = limit("RATE_LIMIT_USER_PER_HOUR", 10);
const GLOBAL_HOUR = limit("RATE_LIMIT_GLOBAL_PER_HOUR", 40);
const GLOBAL_DAY = limit("RATE_LIMIT_GLOBAL_PER_DAY", 200);

/** Discord user IDs that skip every limit. Meant for the bot's owner. */
const EXEMPT = new Set(
  (process.env.RATE_LIMIT_EXEMPT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Accepted-question timestamps, oldest first, pruned to the global day. */
const globalHits = [];
/** Per-user accepted-question timestamps, oldest first, pruned to the hour. */
const userHits = new Map();
/** Per-user timestamp of the last refusal the user was actually told about. */
const lastNotice = new Map();

/** Drop entries older than `windowMs` and return the list. */
function prune(list, windowMs, now) {
  const cutoff = now - windowMs;
  let stale = 0;
  while (stale < list.length && list[stale] <= cutoff) stale++;
  if (stale) list.splice(0, stale);
  return list;
}

/** Entries newer than `windowMs`, for a list pruned to a longer window. */
function countWithin(list, windowMs, now) {
  const cutoff = now - windowMs;
  let count = 0;
  for (let i = list.length - 1; i >= 0 && list[i] > cutoff; i--) count++;
  return count;
}

/**
 * Milliseconds until the window has room again: the moment the `limit`-th
 * newest entry ages out.
 */
function retryIn(list, max, windowMs, now) {
  const freed = list[list.length - max];
  return freed === undefined ? 0 : Math.max(0, freed + windowMs - now);
}

function inWords(ms) {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "in about a minute";
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
}

function sweep(now) {
  if (userHits.size <= SWEEP_AT) return;
  for (const [id, hits] of userHits) {
    if (prune(hits, HOUR_MS, now).length === 0) {
      userHits.delete(id);
      lastNotice.delete(id);
    }
  }
  for (const [id, at] of lastNotice) {
    if (at + NOTICE_COOLDOWN_MS <= now) lastNotice.delete(id);
  }
}

/**
 * Charge one question to `userId`.
 *
 * Returns null when the question may proceed, and consumes budget in that case
 * only. Returns the sentence to show the user when it may not; nothing is
 * consumed by a refusal, so a spammer cannot push their own window further out.
 */
export function claim(userId) {
  if (EXEMPT.has(userId)) return null;

  const now = Date.now();
  prune(globalHits, DAY_MS, now);
  sweep(now);

  if (countWithin(globalHits, DAY_MS, now) >= GLOBAL_DAY) {
    const wait = retryIn(globalHits, GLOBAL_DAY, DAY_MS, now);
    return `I have used up my question budget for today. Try again ${inWords(wait)}.`;
  }
  if (countWithin(globalHits, HOUR_MS, now) >= GLOBAL_HOUR) {
    const hourly = globalHits.slice(-GLOBAL_HOUR);
    const wait = retryIn(hourly, GLOBAL_HOUR, HOUR_MS, now);
    return `I am answering as fast as my hourly budget allows. Try again ${inWords(wait)}.`;
  }

  const hits = prune(userHits.get(userId) ?? [], HOUR_MS, now);
  if (hits.length >= PER_USER_HOUR) {
    const wait = retryIn(hits, PER_USER_HOUR, HOUR_MS, now);
    return `That is your ${PER_USER_HOUR} questions for the hour. Try again ${inWords(wait)}.`;
  }

  hits.push(now);
  userHits.set(userId, hits);
  globalHits.push(now);
  return null;
}

/**
 * Whether a refusal should be spoken aloud in a channel.
 *
 * Someone hammering the bot would otherwise get a refusal per message, which is
 * the same flood with the bot's name on it. One notice per user per minute is
 * enough to explain the silence.
 */
export function shouldAnnounce(userId) {
  const now = Date.now();
  const last = lastNotice.get(userId);
  if (last !== undefined && now - last < NOTICE_COOLDOWN_MS) return false;
  lastNotice.set(userId, now);
  return true;
}
