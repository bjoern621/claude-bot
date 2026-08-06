import "dotenv/config";
import {
  ApplicationCommandOptionType,
  InteractionContextType,
  REST,
  Routes,
} from "discord.js";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set.");
  process.exit(1);
}

const commands = [
  {
    name: "claude",
    description: "Ask Claude privately — only you see the question and the answer.",
    // Server channels only. Discord itself then hides the command in DMs, so a
    // DM interaction never reaches the bot to be refused.
    contexts: [InteractionContextType.Guild],
    options: [
      {
        name: "prompt",
        description: "What do you want to ask?",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

// Guild-scoped commands appear instantly; global ones can take up to an hour.
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

await rest.put(route, { body: commands });
console.log(
  DISCORD_GUILD_ID
    ? `Registered /claude in guild ${DISCORD_GUILD_ID}.`
    : "Registered /claude globally (may take up to an hour to appear).",
);
