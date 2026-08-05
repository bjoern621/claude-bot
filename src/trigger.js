/**
 * Decide whether a message is addressed to the bot.
 *
 * Three ways in: a direct @mention, a reply to one of the bot's own messages,
 * or any direct message. A reply counts whether or not it pings, since Discord
 * users routinely turn the reply ping off.
 */
export async function resolveTrigger(message, botUser) {
  if (message.author.bot) return { respond: false, replyTarget: null };

  const isDM = message.channel.isDMBased();

  // A direct @Claude only — not @everyone, and not a role the bot holds.
  // `ignoreRepliedUser` keeps the reply auto-ping out of this check; replies
  // are judged separately below so both ping styles behave the same.
  const isMention = message.mentions.has(botUser, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: true,
  });

  // Resolved even when already mentioned, so the target reaches the prompt.
  const replyTarget = await repliedBotMessage(message, botUser.id);

  return { respond: isDM || isMention || Boolean(replyTarget), replyTarget };
}

/**
 * The message this one replies to, but only when the bot wrote it. A reply that
 * pings a different user is settled without an API call.
 */
async function repliedBotMessage(message, botId) {
  if (!message.reference?.messageId) return null;

  const pinged = message.mentions.repliedUser;
  if (pinged && pinged.id !== botId) return null;

  const referenced = await message.fetchReference().catch(() => null);
  return referenced?.author?.id === botId ? referenced : null;
}
