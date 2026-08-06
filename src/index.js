// First import on purpose: the OpenTelemetry SDK has to be running before any
// module that records to it is evaluated, and ESM evaluates in import order.
import { event, instruments, shutdownTelemetry, tracer } from "./telemetry.js";

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

/** The label a failure is counted under. Distinct causes, distinct fixes. */
function outcomeOf(error) {
  if (/^busy:/.test(error.message)) return "refused_queue";
  return /did not respond within/.test(error.message) ? "timeout" : "error";
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

/**
 * One question from admission to answer, with the telemetry around it.
 *
 * Both entry points run through here so a mention and a slash command produce
 * the same counter, told apart by `surface` rather than by which code path
 * happened to record them. The caller keeps what differs: how a refusal is
 * delivered, and how an answer is posted.
 *
 * Every question lands on `claude_bot.questions` exactly once, whatever the
 * outcome, so admitted plus refused is the total asked.
 */
async function answerQuestion({ surface, user, channel, guildId, ask, post, refuse }) {
  const where = {
    surface,
    guild_id: guildId ?? "none",
    channel_id: channel?.id ?? "none",
  };
  const labels = { ...where, user_id: user.id };

  const refusal = claim(user.id, where);
  if (refusal) {
    instruments.questions.add(1, { ...labels, outcome: `refused_${refusal.reason}` });
    await refuse(refusal);
    return;
  }

  const startedAt = Date.now();
  await tracer.startActiveSpan("question", async (span) => {
    span.setAttributes(labels);
    let outcome = "answered";
    try {
      await post(await ask());
    } catch (error) {
      outcome = outcomeOf(error);
      console.error(`${surface} handler failed:`, error);
      span.recordException(error);
      await refuse({ reason: outcome, message: userFacing(error) });
    } finally {
      const seconds = (Date.now() - startedAt) / 1000;
      instruments.duration.record(seconds, { outcome });
      instruments.questions.add(1, { ...labels, outcome });
      span.setAttribute("outcome", outcome);
      span.end();
      event(`Question ${outcome}`, { ...labels, outcome, duration_s: seconds });
    }
  });
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id})`);
});

// --- Public: an @mention or a reply to the bot ------------------------------
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

  await answerQuestion({
    surface: "mention",
    user: message.author,
    channel: message.channel,
    guildId: message.guildId,
    ask: () =>
      withTyping(message.channel, () =>
        askClaude(prompt, {
          channel: message.channel,
          botId: client.user.id,
          author: message.author.displayName || message.author.username,
          where: describeChannel(message.channel),
          replyingTo: replyTarget,
          // Seed from what came before this message — it is the question itself.
          recentBefore: message.id,
        }),
      ),
    post: async (answer) => {
      const parts = chunk(answer);
      await message.reply(parts[0]);
      for (const part of parts.slice(1)) {
        await message.channel.send(part);
      }
    },
    // A refused flood answered one refusal per message would be the same flood
    // with the bot's name on it, so rate-limit refusals are spoken once a minute.
    // A failure is not a flood and is always reported.
    refuse: async ({ reason, message: text }) => {
      const quiet = reason.startsWith("global") || reason === "user_bucket";
      if (quiet && !shouldAnnounce(message.author.id)) return;
      await message.reply(text).catch(() => {});
    },
  });
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

  await answerQuestion({
    surface: "slash",
    user: interaction.user,
    channel: interaction.channel,
    guildId: interaction.guildId,
    // The channel is already visible to whoever ran the command, so letting
    // Claude read it leaks nothing — only the question and answer stay private.
    ask: () =>
      askClaude(prompt, {
        channel: interaction.channel ?? undefined,
        botId: client.user.id,
        author: interaction.user.displayName || interaction.user.username,
        where: interaction.channel ? describeChannel(interaction.channel) : undefined,
      }),
    post: async (answer) => {
      const parts = chunk(answer);
      await interaction.editReply(parts[0]);
      for (const part of parts.slice(1)) {
        await interaction.followUp({ content: part, flags: MessageFlags.Ephemeral });
      }
    },
    // Ephemeral like the rest of the command, so it is not channel noise and
    // there is no reason to withhold it after the first one.
    refuse: async ({ message: text }) => {
      await interaction.editReply(text).catch(() => {});
    },
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    // Telemetry first: the queued spans and the last metric interval are lost
    // if the process exits before the exporters flush.
    shutdownTelemetry()
      .then(() => client.destroy())
      .finally(() => process.exit(0));
  });
}

client.login(TOKEN);
