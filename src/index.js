import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";

import { askClaude } from "./claude.js";
import { chunk } from "./chunk.js";

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

/**
 * What to show in the channel when a request fails. Failure detail can name the
 * model, the auth state, or internals, so it stays in the logs.
 */
function userFacing(error) {
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

// --- Public: any message that @mentions the bot (and any DM) ---------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = message.channel.isDMBased();
  // Only a direct @Claude counts — not @everyone, not a role the bot happens
  // to hold, and not the auto-ping from replying to one of its messages.
  const isMention = message.mentions.has(client.user, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: true,
  });
  if (!isDM && !isMention) return;

  const prompt = message.content
    .replaceAll(`<@${client.user.id}>`, "")
    .replaceAll(`<@!${client.user.id}>`, "")
    .trim();

  if (!prompt) {
    await message.reply("Mention me with a question, or use `/claude` to ask privately.");
    return;
  }

  try {
    const answer = await withTyping(message.channel, () =>
      askClaude(prompt, {
        channel: message.channel,
        botId: client.user.id,
        author: message.author.displayName || message.author.username,
        where: describeChannel(message.channel),
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
