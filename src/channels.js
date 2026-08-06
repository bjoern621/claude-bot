/**
 * Where the bot is allowed to operate, and the check that keeps every read
 * inside the channel a question arrived in.
 *
 * Both rules are enforced here in code. Nothing about them is left to the
 * system prompt: a model that ignored the instruction, or was talked out of it
 * by channel text, would still be unable to reach another channel.
 */

/** Empty means every channel the bot can see. */
const ALLOWED = new Set(
  (process.env.ALLOWED_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

export const hasChannelAllowlist = ALLOWED.size > 0;

/**
 * With no allowlist configured, every visible channel is fair game. With one,
 * only the listed IDs are — including DMs, whose channel IDs are per-user and
 * therefore never on a hand-written list. Setting the allowlist switches DMs
 * off, which is the point of setting it.
 */
export function isAllowedChannel(channelId) {
  if (!hasChannelAllowlist) return true;
  return ALLOWED.has(String(channelId));
}

/**
 * Direct messages are off, always.
 *
 * A DM is a private room with no moderator: nobody else sees what is asked, and
 * the channel-scoped reads that make the bot's behaviour auditable in a server
 * lose that property entirely. The bot is a guild participant, so it declines
 * to exist outside one.
 */
export function isDirectMessage(channel) {
  if (!channel) return false;
  if (typeof channel.isDMBased === "function") return channel.isDMBased();
  return channel.type === 1 || channel.type === 3; // DM, GroupDM
}

/** The single question every entry point asks: may the bot work here at all? */
export function isPermittedChannel(channel) {
  if (isDirectMessage(channel)) return false;
  return isAllowedChannel(channel?.id);
}

/** Thrown by the tools; the text reaches Claude as a tool error. */
export class ChannelScopeError extends Error {}

/**
 * Assert that something fetched really belongs to the channel in scope.
 *
 * discord.js routes `messages.fetch(id)` through `/channels/{id}/messages`, so
 * a foreign ID already 404s. This is the belt to that braces: it holds even if
 * a cache lookup, a library change, or a future tool were to hand back
 * something from elsewhere, and it makes the guarantee testable.
 */
export function assertInChannel(entity, channel, what = "message") {
  const owner = entity?.channelId ?? entity?.channel?.id;
  if (owner && String(owner) !== String(channel.id)) {
    throw new ChannelScopeError(
      `That ${what} belongs to a different channel. I can only read this one.`,
    );
  }
  return entity;
}
