import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { SnowflakeUtil } from "discord.js";
import { z } from "zod";

import { assertInChannel, isPermittedChannel } from "./channels.js";

const SERVER = "discord";
const names = [
  "fetch_history",
  "fetch_message",
  "read_attachment",
  "get_pinned_messages",
  "who_is",
];
export const TOOL_NAMES = names.map((n) => `mcp__${SERVER}__${n}`);

const DEFAULT_LIMIT = Number(process.env.HISTORY_DEFAULT_LIMIT ?? 50);
const MAX_LIMIT = Number(process.env.HISTORY_MAX_LIMIT ?? 200);
const MAX_CHARS = Number(process.env.HISTORY_MAX_CHARS ?? 6000);
const TEXT_BYTES = Number(process.env.ATTACHMENT_MAX_TEXT_BYTES ?? 262_144); // 256 KiB
const IMAGE_BYTES = Number(process.env.ATTACHMENT_MAX_IMAGE_BYTES ?? 4_194_304); // 4 MiB
const TEXT_CHARS = Number(process.env.ATTACHMENT_MAX_CHARS ?? 8000);

const PAGE = 100; // Discord's per-request maximum

/**
 * In-process MCP server for reading one Discord channel.
 *
 * `channel` is captured here and is never a tool argument, so the channel is
 * not something the model can name, guess or be argued into changing. Every
 * fetch below then re-checks what came back with `assertInChannel`.
 */
export function createDiscordServer(channel, botId) {
  // Refuse outright rather than hand back a server whose tools all fail; the
  // caller decides what to do with a channel the bot may not touch.
  if (!isPermittedChannel(channel)) {
    throw new Error(`Channel ${channel.id} is a DM or outside ALLOWED_CHANNEL_IDS.`);
  }

  return createSdkMcpServer({
    name: SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "fetch_history",
        "Read earlier messages from the current Discord channel within a time window. " +
          "Use it when the question refers to something said before ('that', 'what you " +
          "mentioned', 'earlier'), when you need to catch up on a discussion, or to " +
          "summarise activity. Returns a transcript, oldest message first.",
        {
          from: z
            .string()
            .describe(
              "Start of the window. Either an ISO-8601 timestamp " +
                "('2026-08-05T09:00:00Z') or an offset back from now: '45m', '6h', '7d'.",
            ),
          to: z.string().optional().describe("End of the window, same formats. Defaults to now."),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              `Maximum messages to return, newest kept first. Default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}.`,
            ),
        },
        wrap((args) => fetchTranscript(channel, botId, args)),
      ),

      tool(
        "fetch_message",
        "Read one specific message in this channel, optionally with the messages around " +
          "it. Use it when someone pastes a Discord message link, refers to a message ID, " +
          "or replies to something you need to see. Returns a transcript.",
        {
          reference: z
            .string()
            .describe(
              "A message ID, or a Discord message link " +
                "('https://discord.com/channels/<server>/<channel>/<message>').",
            ),
          context: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe("How many messages to include either side of it. Default 0."),
        },
        wrap((args) => fetchMessage(channel, botId, args)),
      ),

      tool(
        "read_attachment",
        "Read a file attached to a message in this channel — logs, stack traces, code, " +
          "CSV, JSON, or an image. Transcript lines show the attachment names and the " +
          "message ID to pass here. Text is returned inline; images are returned so you " +
          "can look at them directly.",
        {
          message_id: z.string().describe("ID of the message carrying the attachment."),
          filename: z
            .string()
            .optional()
            .describe("Which attachment, when the message has several. Defaults to the first."),
        },
        async (args) => {
          try {
            return await readAttachment(channel, args);
          } catch (error) {
            return errorResult(error);
          }
        },
      ),

      tool(
        "get_pinned_messages",
        "List this channel's pinned messages. Pins are usually the channel's curated " +
          "reference material — rules, links, decisions — so check them for questions " +
          "about how things work here before searching the history.",
        {
          limit: z
            .number()
            .int()
            .positive()
            .max(50)
            .optional()
            .describe("Maximum pins to return, newest first. Default 20."),
        },
        wrap((args) => getPinned(channel, botId, args)),
      ),

      tool(
        "who_is",
        "Look up members of this server by name or user ID: display name, roles, and when " +
          "they joined. Use it to answer who someone is or who holds a role. Server only — " +
          "not available in direct messages.",
        {
          query: z.string().describe("Part of a name or nickname, or an exact user ID."),
          limit: z
            .number()
            .int()
            .positive()
            .max(25)
            .optional()
            .describe("Maximum matches to return. Default 5."),
        },
        wrap((args) => whoIs(channel, args)),
      ),
    ],
  });
}

// --- fetch_history ---------------------------------------------------------

/** The tool's body, exported so it can be exercised without a model in the loop. */
export async function fetchTranscript(channel, botId, { from, to, limit }) {
  const now = Date.now();
  const toMs = to ? parseTime(to, now) : now;
  const fromMs = parseTime(from, now);
  if (fromMs > toMs) throw new Error("`from` is after `to`.");

  const cap = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const collected = await collect(channel, botId, fromMs, toMs, cap);

  const window = `${iso(fromMs)} .. ${iso(toMs)}`;
  if (!collected.length) return `No messages in ${window}.`;

  // collect() walks newest -> oldest; present oldest first.
  return render(collected.reverse(), (kept, dropped) =>
    `${kept} message(s) in ${window}` +
    (dropped ? `, ${dropped} older one(s) omitted to fit the size limit` : "") +
    ":",
  );
}

async function collect(channel, botId, fromMs, toMs, cap) {
  const out = [];
  // Snowflakes encode their timestamp, so `to` converts straight to a cursor.
  let cursor = SnowflakeUtil.generate({ timestamp: toMs + 1 }).toString();

  // Bounded so a sparse window can never loop over the whole channel.
  for (let page = 0; page < Math.ceil(MAX_LIMIT / PAGE) + 1 && out.length < cap; page++) {
    const batch = await channel.messages.fetch({ limit: PAGE, before: cursor });
    if (!batch.size) break;

    const ordered = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    let reachedStart = false;

    for (const msg of ordered) {
      if (msg.createdTimestamp < fromMs) {
        reachedStart = true;
        break;
      }
      if (msg.createdTimestamp > toMs) continue;

      const entry = toEntry(msg, botId, channel);
      if (entry) out.push(entry);
      if (out.length >= cap) break;
    }

    if (reachedStart) break;
    cursor = ordered.at(-1).id;
  }

  return out;
}

/**
 * The last few messages, rendered like a tool transcript. Passed with every
 * question so the common "what did you just say?" case costs no round-trip.
 *
 * A missing history permission is swallowed — the answer proceeds without the
 * seed. A channel-scope violation is not: that means an invariant broke, and
 * failing the request is better than answering from someone else's channel.
 */
export async function recentTranscript(channel, botId, { limit = 5, before } = {}) {
  if (limit <= 0) return "";

  let batch;
  try {
    // Over-fetch: other bots and empty messages are dropped below.
    batch = await channel.messages.fetch({
      limit: Math.min(limit * 3, PAGE),
      ...(before && { before }),
    });
  } catch (error) {
    console.warn("recent messages unavailable:", error.message);
    return "";
  }

  const entries = [];
  for (const msg of [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)) {
    const entry = toEntry(msg, botId, channel);
    if (entry) entries.push(entry);
    if (entries.length >= limit) break;
  }
  if (!entries.length) return "";

  const lines = entries.reverse().map((e) => `[${iso(e.at)}] ${e.who}: ${e.body}`);
  while (lines.length > 1 && lines.join("\n").length > MAX_CHARS) lines.shift();
  return lines.join("\n");
}

// --- fetch_message ---------------------------------------------------------

export async function fetchMessage(channel, botId, { reference, context = 0 }) {
  const id = resolveReference(reference, channel.id);

  let target;
  try {
    target = await channel.messages.fetch(id);
  } catch {
    throw new Error(`No message ${id} in this channel — it may be deleted or elsewhere.`);
  }
  assertInChannel(target, channel);

  const entries = [toEntry(target, botId, channel)].filter(Boolean);

  if (context > 0) {
    const [before, after] = await Promise.all([
      channel.messages.fetch({ limit: context, before: id }),
      channel.messages.fetch({ limit: context, after: id }),
    ]);
    for (const msg of [...before.values(), ...after.values()]) {
      assertInChannel(msg, channel);
      const entry = toEntry(msg, botId, channel);
      if (entry) entries.push(entry);
    }
  }

  entries.sort((a, b) => a.at - b.at);
  return render(entries, (kept) =>
    context > 0 ? `Message ${id} with ${kept - 1} surrounding message(s):` : `Message ${id}:`,
  );
}

/** Accept a bare ID or a message link, and refuse links to other channels. */
function resolveReference(reference, channelId) {
  const text = String(reference).trim();

  const link = /channels\/(?:@me|\d+)\/(\d+)\/(\d+)/.exec(text);
  if (link) {
    if (link[1] !== channelId) {
      throw new Error("That link points at a different channel. I can only read this one.");
    }
    return link[2];
  }

  if (/^\d{17,20}$/.test(text)) return text;
  throw new Error(`"${reference}" is not a message ID or a Discord message link.`);
}

// --- read_attachment -------------------------------------------------------

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|sql|x-sh))/;
const TEXT_EXTENSIONS =
  /\.(txt|log|md|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|diff|patch|sql|sh|bash|ps1|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|dockerfile|env\.example)$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

export async function readAttachment(channel, { message_id, filename }) {
  const message = await channel.messages.fetch(message_id).catch(() => null);
  if (!message) throw new Error(`No message ${message_id} in this channel.`);
  assertInChannel(message, channel);

  const files = [...message.attachments.values()];
  if (!files.length) throw new Error(`Message ${message_id} has no attachments.`);

  const file = filename
    ? files.find((f) => f.name?.toLowerCase() === String(filename).toLowerCase())
    : files[0];
  if (!file) {
    throw new Error(
      `No attachment named "${filename}". This message has: ${files.map((f) => f.name).join(", ")}.`,
    );
  }

  const type = file.contentType?.split(";")[0]?.trim() ?? "";
  const isImage = IMAGE_TYPES.test(type);
  const isText = TEXT_TYPES.test(type) || TEXT_EXTENSIONS.test(file.name ?? "");

  if (!isImage && !isText) {
    throw new Error(
      `"${file.name}" is ${type || "an unknown type"}, which I cannot read. ` +
        "I can read text-like files and PNG/JPEG/GIF/WebP images.",
    );
  }

  const cap = isImage ? IMAGE_BYTES : TEXT_BYTES;
  if (file.size > cap) {
    throw new Error(
      `"${file.name}" is ${size(file.size)}, over the ${size(cap)} limit for this kind of file.`,
    );
  }

  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());

  if (isImage) {
    return {
      content: [
        { type: "text", text: `Image "${file.name}" (${type}, ${size(file.size)}):` },
        { type: "image", data: buffer.toString("base64"), mimeType: type },
      ],
    };
  }

  let text = buffer.toString("utf8");
  let note = "";
  if (text.length > TEXT_CHARS) {
    // Keep the tail: stack traces and logs put the interesting part last.
    text = text.slice(-TEXT_CHARS);
    note = ` — showing the last ${TEXT_CHARS} characters of ${buffer.length} bytes`;
  }

  return {
    content: [{ type: "text", text: `"${file.name}"${note}:\n\n${text}` }],
  };
}

// --- get_pinned_messages ---------------------------------------------------

export async function getPinned(channel, botId, { limit } = {}) {
  const cap = Math.min(limit ?? 20, 50);

  let messages;
  if (typeof channel.messages.fetchPins === "function") {
    const { items } = await channel.messages.fetchPins({ limit: cap });
    messages = items.map((pin) => pin.message);
  } else {
    // discord.js < 14.23
    messages = [...(await channel.messages.fetchPinned()).values()].slice(0, cap);
  }

  if (!messages.length) return "This channel has no pinned messages.";

  const entries = messages
    .map((msg) => toEntry(msg, botId, channel, { keepOtherBots: true }))
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);

  return render(entries, (kept, dropped) =>
    `${kept} pinned message(s)` +
    (dropped ? `, ${dropped} older one(s) omitted to fit the size limit` : "") +
    ":",
  );
}

// --- who_is ----------------------------------------------------------------

export async function whoIs(channel, { query, limit }) {
  const guild = channel.guild;
  if (!guild) throw new Error("This is a direct message, so there is no server to look up.");

  const cap = Math.min(limit ?? 5, 25);
  const text = String(query).trim();

  // Both paths hit endpoints gated behind the privileged Server Members intent.
  let members;
  try {
    if (/^\d{17,20}$/.test(text)) {
      const member = await guild.members.fetch(text);
      members = [member];
    } else {
      members = [...(await guild.members.search({ query: text, limit: cap })).values()];
    }
  } catch (error) {
    if (error.status === 403 || error.code === 50001) {
      throw new Error(
        "I cannot look up members: this bot is missing the Server Members intent, " +
          "which an administrator has to enable.",
      );
    }
    if (error.status === 404 || error.code === 10007) {
      throw new Error(`No member matching "${text}" in this server.`);
    }
    throw new Error(`Member lookup failed: ${error.message}`);
  }

  if (!members.length) return `No members in this server match "${text}".`;

  const lines = members.map((m) => {
    const roles = [...m.roles.cache.values()]
      .filter((r) => r.name !== "@everyone")
      .map((r) => r.name);
    const bits = [
      `${m.displayName} (@${m.user.username}, id ${m.id})`,
      roles.length ? `roles: ${roles.join(", ")}` : "no roles",
      m.joinedAt ? `joined ${m.joinedAt.toISOString().slice(0, 10)}` : null,
      m.user.bot ? "is a bot" : null,
    ].filter(Boolean);
    return `- ${bits.join(" — ")}`;
  });

  return `${members.length} match(es) for "${text}":\n${lines.join("\n")}`;
}

// --- shared ----------------------------------------------------------------

/**
 * Turn a Discord message into a transcript entry, or null if it carries nothing.
 *
 * Every tool that renders a message goes through here, which makes this the one
 * place the channel check has to hold. A message from anywhere else throws
 * rather than being quietly rendered.
 */
function toEntry(msg, botId, channel, { keepOtherBots = false } = {}) {
  assertInChannel(msg, channel);
  if (msg.author.bot && msg.author.id !== botId && !keepOtherBots) return null;

  const parts = [];
  if (msg.cleanContent?.trim()) parts.push(msg.cleanContent.trim());

  // Surface names + the message ID so read_attachment has something to go on.
  if (msg.attachments.size) {
    const names = [...msg.attachments.values()].map((a) => a.name).join(", ");
    parts.push(`{attachments: ${names} | message id ${msg.id}}`);
  } else if (msg.embeds.length) {
    parts.push("[embed]");
  }

  const body = parts.join(" ");
  if (!body) return null;

  return {
    at: msg.createdTimestamp,
    who: msg.author.id === botId ? "Claude" : msg.author.displayName || msg.author.username,
    body,
  };
}

/** Render entries oldest-first, trimming the oldest to fit the char budget. */
function render(entries, header) {
  const lines = entries.map((e) => `[${iso(e.at)}] ${e.who}: ${e.body}`);
  let dropped = 0;
  while (lines.length > 1 && lines.join("\n").length > MAX_CHARS) {
    lines.shift();
    dropped++;
  }
  return `${header(lines.length, dropped)}\n${lines.join("\n")}`;
}

/** ISO-8601 timestamp, or an offset back from now: '45m', '6h', '7d'. */
function parseTime(value, now) {
  const text = String(value).trim();
  if (text.toLowerCase() === "now") return now;

  const relative = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days)$/i.exec(text);
  if (relative) {
    const unit = relative[2].toLowerCase()[0];
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return now - Number(relative[1]) * ms;
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`Cannot read "${value}" as a time. Use ISO-8601 or an offset like '6h'.`);
  }
  return parsed;
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "Z";
}

function size(bytes) {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KiB`;
}

/** Tool bodies return plain strings; failures come back as readable tool errors. */
function wrap(body) {
  return async (args) => {
    try {
      return { content: [{ type: "text", text: await body(args) }] };
    } catch (error) {
      return errorResult(error);
    }
  };
}

function errorResult(error) {
  return { content: [{ type: "text", text: error.message }], isError: true };
}
