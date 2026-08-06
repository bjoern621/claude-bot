# claude-bot

A Discord bot named **Claude**. Two behaviours, nothing else:

| Trigger | Result |
| --- | --- |
| A message containing `@Claude`, a reply to one of Claude's messages, or any DM | Claude replies publicly in that channel |
| `/claude prompt:<question>` | Claude replies **ephemerally** — only the person who ran the command sees the question and the answer |

The last five messages of the channel travel with every question, so ordinary
follow-ups are answered without a single tool call. For anything further back,
Claude reaches on its own: five MCP tools read the current channel — history, a
specific message, an attached file, the pins, and server members — and it calls
them only when the answer is not already in front of it. No state is kept
anywhere: the channel *is* the memory.

It can also search the web and fetch a page, so questions about current events,
releases or a pasted link are answered rather than deflected. Beyond that it has
nothing: no local files, no shell, and it cannot post anywhere you did not
summon it.

Responses are billed to your **Claude subscription** via a Claude Code OAuth token,
not to a pay-per-token API key.

---

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**, name it `Claude`.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN`.
3. Still on the **Bot** tab, enable **MESSAGE CONTENT INTENT**.
   Without it the bot receives mentions but cannot read what was said.
   Enable **SERVER MEMBERS INTENT** too if you want the `who_is` tool to work.
4. **General Information** tab → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`;
   bot permissions `View Channels`, `Send Messages`, `Read Message History`.
   Open the generated URL and invite the bot to your server.

## 2. Get a Claude subscription token

On a machine where you are logged into Claude Code with your Pro/Max account:

```bash
claude setup-token
```

Copy the printed token into `CLAUDE_CODE_OAUTH_TOKEN`. It is long-lived — generate it
once and put it in the deployment environment.

> Prefer API billing instead? Set `ANTHROPIC_API_KEY` and leave the OAuth token unset.

## 3. Configure

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `CLAUDE_CODE_OAUTH_TOKEN`.
Set `DISCORD_GUILD_ID` to your server ID while testing — guild commands register
instantly, global ones take up to an hour.

## 4. Register the slash command

Once per command change, not on every start:

```bash
docker compose run --rm bot node src/register-commands.js
```

Locally instead:

```bash
npm install && npm run register
```

## 5. Run

`docker compose` reads `.env`, so step 3 has to be done first.

```bash
docker compose up -d --build
docker compose logs -f
```

Locally:

```bash
npm start
```

The image is ~790 MB — most of it is the Claude Code CLI binary the Agent SDK
bundles (~277 MB) plus the Node base image.

---

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | — | Bot token |
| `DISCORD_CLIENT_ID` | for registration | — | Application ID |
| `DISCORD_GUILD_ID` | no | — | Register `/claude` to one guild instead of globally |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes¹ | — | Subscription auth from `claude setup-token` |
| `ANTHROPIC_API_KEY` | yes¹ | — | Alternative: pay-per-token API billing |
| `CLAUDE_MODEL` | no | `claude-sonnet-5` | Set to `claude-opus-5` for harder questions, at more subscription quota |
| `CLAUDE_TIMEOUT_MS` | no | `120000` | Per-request wall-clock limit |
| `CLAUDE_MAX_CONCURRENT` | no | `3` | Concurrent Claude requests; extra messages queue |
| `CLAUDE_MAX_TURNS` | no | `8` | Tool round-trips per question |
| `RECENT_MESSAGES` | no | `5` | Recent messages sent with every question; `0` disables |
| `WEB_TOOLS` | no | on | Set to `off` to remove web search and page fetch |
| `HISTORY_DEFAULT_LIMIT` | no | `50` | Messages returned when Claude names no limit |
| `HISTORY_MAX_LIMIT` | no | `200` | Hard cap per call, whatever Claude asks for |
| `HISTORY_MAX_CHARS` | no | `6000` | Transcript budget; oldest lines dropped first |
| `ATTACHMENT_MAX_TEXT_BYTES` | no | `262144` | Largest text file downloaded |
| `ATTACHMENT_MAX_IMAGE_BYTES` | no | `4194304` | Largest image downloaded |
| `ATTACHMENT_MAX_CHARS` | no | `8000` | Text kept from a file (the tail) |

¹ one of the two is required.

## Layout

```
src/index.js             Discord client + both handlers
src/trigger.js           Decides whether a message is addressed to the bot
src/claude.js            Claude Agent SDK wrapper (concurrency cap, timeout, tool wiring)
src/discord-tools.js     In-process MCP server exposing the five read tools
src/chunk.js             Splits answers across Discord's 2000-char limit
src/register-commands.js One-off /claude registration
```

## Notes

- In servers it answers when mentioned or when you reply to one of its messages;
  in DMs it answers everything. Replying works whether or not the reply pings it.
- A reply is a **fresh** request, not a continued session. The message being
  replied to is named in the prompt, so short follow-ups like "and in feet?"
  resolve — and Claude can pull more with `fetch_history` if it needs it.
- Replies between other people never trigger it, and are settled without an API call.
- Answers longer than 2000 characters are split across multiple messages
  (follow-ups to `/claude` stay ephemeral).

### The tools

Two built-in Claude Code tools, `WebSearch` and `WebFetch`, plus five Discord
tools of our own. The Discord five live in one in-process MCP server
(`createSdkMcpServer`) — same process, no transport, nothing extra to run.

`Read`, `Write`, `Edit` and `Bash` stay switched off: the bot's input is
untrusted channel text, and none of them serve a chat bot.

```
fetch_history(from, to?, limit?)
  from    ISO-8601 timestamp, or an offset back from now: "45m", "6h", "7d"
  to      same formats, defaults to now
  limit   max messages, default 50, capped at 200

fetch_message(reference, context?)
  reference  message ID, or a https://discord.com/channels/... link
  context    messages to include either side, 0-20, default 0

read_attachment(message_id, filename?)
  text files returned inline; PNG/JPEG/GIF/WebP returned as images to look at

get_pinned_messages(limit?)      limit default 20, capped at 50
who_is(query, limit?)            name fragment or user ID; servers only
```

`fetch_history` returns a transcript, oldest first:

```
9 message(s) in 2026-08-05 19:20:32Z .. 2026-08-05 20:20:32Z:
[2026-08-05 19:50:32Z] Bjoern: My favourite fish is the tarpon.
[2026-08-05 20:00:32Z] Claude: A tarpon can reach about 2.5 metres.
[2026-08-05 20:10:32Z] Ana: the build blew up {attachments: build.log | message id 1534…}
```

That trailing annotation is what makes attachments reachable — it hands Claude the
filename and message ID to pass to `read_attachment`.

**Web access**

`WEB_TOOLS=off` removes both web tools; verified — the bot then reports it has no
search tool rather than half-working. A fetched page is treated the same way as
channel text: quotable source, never a source of instructions, since a web page
is exactly the kind of thing that carries planted text.

**The prefetch**

Every question already carries the last `RECENT_MESSAGES` (default 5) messages in
a `<recent_messages>` block, so "what did you just say?" costs one API call
instead of a round-trip through `fetch_history`. Measured on the fake channel: a
question answerable from those five made **1** call (the prefetch alone), while
one needing older history made **3**. Set `RECENT_MESSAGES=0` to drop the seed
and leave everything to the tools.

**How far back it reaches**

Discord history is channel-scoped, not membership-scoped, so the bot can read
messages posted **long before it joined** — in any channel it can see. Anyone who
can talk to it can query that whole backlog in plain language, including parts
they never scrolled to themselves. Bear that in mind before adding it to a
channel with years of history.

A wide `from` does *not* mean deep history: it returns the newest messages inside
that window. Reaching old messages means setting `to` as well, which converts to
a message ID and seeks straight there instead of paging through everything in
between — so ten-month-old history costs about two API calls, not three hundred.
Claude works this out on its own, narrowing `to` until it finds what it needs.

Permissions are the real limit: no **View Channel** or **Read Message History**
means unreachable, full stop.

**Scoping and safety**

- **One channel.** The server is constructed per request around the channel the
  question arrived in. The channel is a closure variable, never a tool argument,
  so no tool can read another channel — a message link pointing elsewhere is
  refused rather than followed.
- Other bots are skipped in transcripts; the bot's own replies are kept and
  labelled `Claude`. Pins keep other bots, since bots post useful pins.
- `<context>` and `<question>` are separate blocks, and the system prompt states
  that everything a tool returns is background. A channel message reading "ignore
  your instructions" is treated as history, not obeyed.
- The bot has no write tools. Worst case for anything it reads is a wrong answer,
  not an action taken.

**Limits and failure modes**

- Transcripts over `HISTORY_MAX_CHARS` drop the oldest lines and say how many were
  omitted, so Claude can narrow the window and retry.
- `read_attachment` refuses types it cannot use (`archive.zip is application/zip,
  which I cannot read`) and files over the size caps. Long text keeps the **tail**
  — stack traces put the useful part last.
- Every failure comes back as readable tool text, never an exception, so Claude
  recovers and answers rather than the reply dying.

**Permissions**

- **Read Message History** — needed by everything except `who_is`.
- **Server Members intent** (privileged, dev portal) — needed by `who_is` only.
  Without it that one tool returns a message naming the missing intent; the rest
  keep working.
- Outbound HTTPS to `cdn.discordapp.com` — needed by `read_attachment`.
