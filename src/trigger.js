import { MessageReferenceType } from "discord.js";

import { isPermittedChannel } from "./channels.js";

/**
 * Decide whether a message is addressed to the bot.
 *
 * Two ways in: a direct @mention, or a reply to one of the bot's own messages.
 * A reply counts whether or not it pings, since Discord users routinely turn
 * the reply ping off. Direct messages are not a way in at all.
 *
 * `referenced` carries the message replied to, whoever wrote it,
 * so a mention in reply to someone's screenshot can see that screenshot.
 */
export async function resolveTrigger(message, botUser) {
  if (message.author.bot) return { respond: false, referenced: null };

  // Checked before anything else: in a DM, or outside the allowlist, the bot is
  // deaf — no API call, and no reply for anyone to argue with.
  if (!isPermittedChannel(message.channel)) return { respond: false, referenced: null };

  // A direct @Claude only — not @everyone, and not a role the bot holds.
  // `ignoreRepliedUser` keeps the reply auto-ping out of this check; replies
  // are judged separately below so both ping styles behave the same.
  const isMention = message.mentions.has(botUser, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: true,
  });

  const referenced = await repliedMessage(message, botUser.id, isMention);
  const repliesToBot = referenced?.author?.id === botUser.id;

  return { respond: isMention || repliesToBot, referenced };
}

/**
 * The message this one replies to.
 * Without a mention it matters only when the bot wrote it,
 * so a reply that pings a different user is settled without an API call.
 */
async function repliedMessage(message, botId, isMention) {
  // A forward also sets a reference, pointing at the source channel.
  // Its content arrives on the message as a snapshot.
  if (!message.reference?.messageId) return null;
  if (message.reference.type !== undefined && message.reference.type !== MessageReferenceType.Default) {
    return null;
  }

  const pinged = message.mentions.repliedUser;
  if (!isMention && pinged && pinged.id !== botId) return null;

  const referenced = await message.fetchReference().catch(() => null);
  return referenced?.channelId === message.channelId ? referenced : null;
}
