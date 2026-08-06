import "dotenv/config";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

import { askClaude } from "./claude.js";
import { isPermittedChannel } from "./channels.js";
import { chunk } from "./chunk.js";
import { claim, shouldAnnounce } from "./limits.js";
import { resolveTrigger } from "./trigger.js";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set.");
  process.exit(1);
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "No Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) " +
      "to bill your Claude subscription, or ANTHROPIC_API_KEY for pay-per-token.",
  );
  process.exit(1);
}

// No DirectMessages intent: Discord never delivers a DM to this process, so
// the bot cannot answer one even if every check further in were removed. The
// Channel partial went with it — it exists to hydrate DM channels.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/**
 * What to show in the channel when a request fails. Failure detail can name the
 * model, the auth state, or internals, so it stays in the logs.
 */
function userFacing(error) {
  if (/^busy:/.test(error.message)) {
    return "Too many questions in flight right now. Try again in a minute.";
  }
  return /did not respond within/.test(error.message)
    ? "That took too long. Try again, or ask for something smaller."
    : "Something went wrong — the details are in the bot's logs.";
}

/** Human-readable channel label for the prompt context block. */
function describeChannel(channel) {
  if (channel.isDMBased()) return "a direct message";
  const guild = channel.guild?.name ? ` in server "${channel.guild.name}"` : "";
  return `#${channel.name}${guild}`;
}

/** Show "Claude is typing…" until the promise settles. */
async function withTyping(channel, work) {
  let timer;
  try {
    await channel.sendTyping().catch(() => {});
    timer = setInterval(() => channel.sendTyping().catch(() => {}), 8_000);
    return await work();
  } finally {
    clearInterval(timer);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id})`);
});

// --- Public: @mention, a reply to the bot, or any DM ------------------------
client.on(Events.MessageCreate, async (message) => {
  const { respond, replyTarget } = await resolveTrigger(message, client.user);
  if (!respond) return;

  const prompt = message.content
    .replaceAll(`<@${client.user.id}>`, "")
    .replaceAll(`<@!${client.user.id}>`, "")
    .trim();

  if (!prompt) {
    await message.reply("Mention me with a question, or use `/claude` to ask privately.");
    return;
  }

  // Charged before any work starts, so a flood costs Discord API calls and
  // nothing else. A refused user is told once, then answered with silence.
  const refusal = claim(message.author.id);
  if (refusal) {
    if (shouldAnnounce(message.author.id)) await message.reply(refusal).catch(() => {});
    return;
  }

  try {
    const answer = await withTyping(message.channel, () =>
      askClaude(prompt, {
        channel: message.channel,
        botId: client.user.id,
        author: message.author.displayName || message.author.username,
        where: describeChannel(message.channel),
        replyingTo: replyTarget,
        // Seed from what came before this message — it is the question itself.
        recentBefore: message.id,
      }),
    );
    const parts = chunk(answer);
    await message.reply(parts[0]);
    for (const part of parts.slice(1)) {
      await message.channel.send(part);
    }
  } catch (error) {
    console.error("mention handler failed:", error);
    await message.reply(userFacing(error)).catch(() => {});
  }
});

// --- Private: /claude ------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "claude") return;

  const prompt = interaction.options.getString("prompt", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Discord already hides this command outside a server (see register-commands),
  // and resolveTrigger never sees an interaction — so both rules are re-checked
  // here rather than assumed.
  if (!interaction.inGuild() || !isPermittedChannel(interaction.channel)) {
    await interaction
      .editReply("I only work in a server channel I have been enabled for.")
      .catch(() => {});
    return;
  }

  // The refusal is ephemeral like the rest of the command, so it is not channel
  // noise and there is no reason to withhold it after the first one.
  const refusal = claim(interaction.user.id);
  if (refusal) {
    await interaction.editReply(refusal).catch(() => {});
    return;
  }

  try {
    // The channel is already visible to whoever ran the command, so letting
    // Claude read it leaks nothing — only the question and answer stay private.
    const answer = await askClaude(prompt, {
      channel: interaction.channel ?? undefined,
      botId: client.user.id,
      author: interaction.user.displayName || interaction.user.username,
      where: interaction.channel ? describeChannel(interaction.channel) : undefined,
    });
    const parts = chunk(answer);
    await interaction.editReply(parts[0]);
    for (const part of parts.slice(1)) {
      await interaction.followUp({ content: part, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error("/claude failed:", error);
    await interaction.editReply(userFacing(error)).catch(() => {});
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    client.destroy().finally(() => process.exit(0));
  });
}

client.login(TOKEN);
