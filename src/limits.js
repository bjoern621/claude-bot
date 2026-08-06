/**
 * Admission control for paid work.
 *
 * Every accepted question spends subscription quota, and nothing in Discord
 * stops one person from asking a hundred times a minute. The concurrency gate in
 * claude.js is not a defence against that: it serialises the same spend rather
 * than refusing it. These limits refuse the request outright, before any of it
 * reaches Claude.
 *
 * Two different shapes, because the two jobs differ.
 *
 * The global hour and day are sliding windows: they guard real spend, so they
 * want a hard ceiling on any 60-minute stretch and no burst allowance at all.
 *
 * The per-user limit is a token bucket. A hard hourly cap locks someone out for
 * a full hour after a normal back-and-forth, which reads as broken; a bucket
 * hands a question back every few minutes instead. Note the cost of that: a
 * bucket admits up to `burst + rate` in one hour, not `rate`, so the burst size
 * is deliberately smaller than the hourly rate rather than equal to it.
 *
 * State is in-process, so a restart forgives every window. That is the accepted
 * cost of keeping the bot stateless: the limits bound a spending rate, and a bot
 * restarting often enough to matter has a worse problem than a forgiven hour.
 */

import { event, instruments, observe } from "./telemetry.js";

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

/** Tokens added per hour, and the most a bucket can hold. */
const PER_USER_HOUR = limit("RATE_LIMIT_USER_PER_HOUR", 10);
const PER_USER_BURST = Math.min(limit("RATE_LIMIT_USER_BURST", 5), PER_USER_HOUR);
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
/** Per-user token buckets: `{ tokens, at }`, refilled lazily on read. */
const userBuckets = new Map();
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

/**
 * A user's bucket, refilled for the time since it was last touched. A bucket
 * that has refilled to capacity is indistinguishable from a new one, which is
 * what makes eviction in `sweep` safe.
 */
function bucketFor(userId, now) {
  const held = userBuckets.get(userId);
  if (!held) return { tokens: PER_USER_BURST, at: now };

  const gained = ((now - held.at) * PER_USER_HOUR) / HOUR_MS;
  return { tokens: Math.min(PER_USER_BURST, held.tokens + gained), at: now };
}

/**
 * Both maps are checked, not just one. A user refused by a *global* limit never
 * gets a bucket, so gating the sweep on bucket count alone let `lastNotice`
 * grow without bound during exactly the flood it exists to quieten.
 */
function sweep(now) {
  if (userBuckets.size <= SWEEP_AT && lastNotice.size <= SWEEP_AT) return;

  for (const id of userBuckets.keys()) {
    if (bucketFor(id, now).tokens >= PER_USER_BURST) userBuckets.delete(id);
  }
  for (const [id, at] of lastNotice) {
    if (at + NOTICE_COOLDOWN_MS <= now) lastNotice.delete(id);
  }
}

/** Two decimals is all a dashboard can show, and it keeps the gauge steady. */
function rounded(tokens) {
  return Math.round(tokens * 100) / 100;
}

/**
 * Charge one question to `userId`.
 *
 * Returns null when the question may proceed, and consumes budget in that case
 * only. Returns `{ reason, message }` when it may not: `message` is the sentence
 * to show the user, `reason` the label the caller records. Nothing is consumed
 * by a refusal, so a spammer cannot push their own window further out.
 *
 * `where` carries the guild and channel through to the emitted event. They are
 * not needed to decide anything; they are what makes the decision searchable
 * afterwards.
 */
export function claim(userId, where = {}) {
  if (EXEMPT.has(userId)) return null;

  const now = Date.now();
  prune(globalHits, DAY_MS, now);
  sweep(now);

  const refuse = (reason, wait, message) => {
    event(
      `Refused a question: ${reason}`,
      { ...where, user_id: userId, limit_reason: reason, retry_after_ms: wait },
      "WARN",
    );
    return { reason, message };
  };

  if (countWithin(globalHits, DAY_MS, now) >= GLOBAL_DAY) {
    const wait = retryIn(globalHits, GLOBAL_DAY, DAY_MS, now);
    return refuse(
      "global_day",
      wait,
      `I have used up my question budget for today. Try again ${inWords(wait)}.`,
    );
  }
  if (countWithin(globalHits, HOUR_MS, now) >= GLOBAL_HOUR) {
    const hourly = globalHits.slice(-GLOBAL_HOUR);
    const wait = retryIn(hourly, GLOBAL_HOUR, HOUR_MS, now);
    return refuse(
      "global_hour",
      wait,
      `I am answering as fast as my hourly budget allows. Try again ${inWords(wait)}.`,
    );
  }

  // "off" means no per-user bucket at all — refilling one at an infinite rate
  // would work out the same, but only by accident.
  if (PER_USER_HOUR !== Infinity) {
    const bucket = bucketFor(userId, now);
    if (bucket.tokens < 1) {
      // Time for the fraction of a token still missing, not for a whole one.
      const wait = ((1 - bucket.tokens) * HOUR_MS) / PER_USER_HOUR;
      instruments.tokensRemaining.record(rounded(bucket.tokens), { user_id: userId });
      return refuse(
        "user_bucket",
        wait,
        `You are asking faster than I can keep up. Try again ${inWords(wait)}.`,
      );
    }

    bucket.tokens -= 1;
    userBuckets.set(userId, bucket);
    instruments.tokensRemaining.record(rounded(bucket.tokens), { user_id: userId });
  }

  globalHits.push(now);
  return null;
}

// The windows are read at export time rather than pushed on change: a bucket
// refills with the clock, so a value recorded only when someone asks would
// flatline for as long as nobody does.
observe("claude_bot.global.budget_used", "Questions inside the global window.", (result) => {
  const now = Date.now();
  prune(globalHits, DAY_MS, now);
  result.observe(countWithin(globalHits, HOUR_MS, now), { window: "hour" });
  result.observe(countWithin(globalHits, DAY_MS, now), { window: "day" });
});

// Published so a dashboard reads the headroom off the same source as the bot,
// instead of hardcoding a ceiling that a ConfigMap edit would falsify. A window
// switched off has no ceiling to report.
observe("claude_bot.global.budget_limit", "Ceiling on the global window.", (result) => {
  if (GLOBAL_HOUR !== Infinity) result.observe(GLOBAL_HOUR, { window: "hour" });
  if (GLOBAL_DAY !== Infinity) result.observe(GLOBAL_DAY, { window: "day" });
});

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
