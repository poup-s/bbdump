# Database Chat

Ask a database a question in plain words and get the answer as key figures, charts and tables. The chat uses the AI tool already on your computer, with your own account, or a local model; the AI only reads, through bbdump.

![Chat with a database](../captures/chat.webp)

## Opening the chat

Click **AI chat** on a database card. The panel opens on the right; it can be widened by dragging its left edge (arrow keys work too, a double-click widens it fully) or with the widen button, and bbdump remembers its width.

An empty chat offers a few questions to start with. Type yours and press Enter (Shift+Enter for a new line). **Stop** interrupts the AI; **+** starts a new conversation. A follow-up question keeps the conversation: the AI remembers what it already read.

## The AI tools

| Tool | What it needs | Where the data goes |
|------|---------------|---------------------|
| **Claude Code** | the `claude` command, signed in to your account | Anthropic |
| **Codex** | the `codex` command, signed in to your account | OpenAI |
| **OpenCode** | the `opencode` command, with a model configured | the provider of the chosen model |
| **Ollama** | the Ollama server running (`127.0.0.1:11434`, or `OLLAMA_HOST`) | stays on this computer |
| **LM Studio** | its local server on (Developer tab, `127.0.0.1:1234`) | stays on this computer |

The **✦** button in the chat opens the **AI settings**: the tool that answers and its model. Tools not found on the computer offer a link to install them.

- **Claude Code:** `sonnet`, `opus` or `haiku` follow the latest version; any full model id works too.
- **Codex:** any model your account offers (as with `codex -m`).
- **OpenCode:** the models it knows (`opencode models`).
- **Ollama, LM Studio:** the models of the running server. Pick one that can call tools (qwen3, llama3.1, gpt-oss…).

Changing the tool starts a new chat; a new model applies from the next message.

## Read only, limited to this database

Every tool reads the database through bbdump's [MCP server](mcp-server.md), started for this chat only:

- it is limited to **this database**: other saved databases are not even listed;
- it only offers the **reading tools** (schema, rows, queries in read-only transactions, statistics, plans…); the tools that change data are not offered;
- the AI tool gets **none of its own tools**: no shell, no files, no web. Claude Code also runs without your settings, hooks or memory; Codex runs in its read-only sandbox; OpenCode runs a dedicated agent with bbdump's tools only.

With **Ollama** or **LM Studio**, which are model servers and not agents, bbdump runs the conversation itself: it gives the model a short list of reading tools (schema overview, tables, queries, rows, counts, search, profiles, sizes), runs the ones it asks for and sends back their results.

## What the AI gets

The badges under the title stay in sight:

- **Read only**;
- **N column(s) anonymized** (or **Real data**): the columns chosen in [Anonymize for AI](mcp-server.md#personal-data-anonymized-for-ai). Click the badge to change them; the same rules apply to every tool, local models included;
- **Sent to …** or **Stays on this computer**: where what the AI reads goes.

Each step the AI took is listed (**Read the schema**, **Ran a query**…) and can be unfolded to see what it asked and what it got; a step shows the columns anonymized in its result.

### When a result could hide personal data

A computed result (a computed column, a view, free SQL) can carry personal data that bbdump cannot trace to a column. When it could come from an anonymized column, the chat asks you first, in a card: **Check what the AI will get**.

- Each column shows a few of its values and **The AI sees:** what the AI would get once anonymized (partly starred, or the fake chosen for that column).
- Choose **Anonymized** or **As is** column by column, or **Anonymize all**.
- **Send · N anonymized** (or **Send without anonymizing**) sends the result; **Block** keeps it from the AI.

The real values shown in the card stay on your computer. The card waits 60 seconds; without an answer, the result is sent as chosen in the card.

There is no question when the result cannot hold anything from an anonymized column: values written in the query itself (`select 'events' as t, count(*)…`), or a query that reads no table holding an anonymized column (views included).

## Answers

Answers show their data as blocks drawn by bbdump ([OpenUI](https://github.com/thesysdev/openui)): headings, key figures, tables (up to 50 rows), bar charts, line charts over time, notes, and the main SQL query, folded under **See the SQL query**. Text around them is plain.

The AI only shows values the tools returned; anonymized values stay as they came.

## History

Conversations are kept per database, encrypted on the computer (`ai-chat-history/<database id>/` in the [data folder](configuration.md#data-folder)), for 30 days after their last message. The clock button opens the history:

- click a conversation to reopen it and continue: the AI picks up its own context;
- **pin** one to keep it for good, unpin it to keep it 30 days again;
- **Delete** one, or **Delete all** for this database.

**Back to the conversation**, Escape, a new chat or a new question close the history.

In the AI settings, **Keep the conversations** turns the history off (new conversations are not kept), and **Delete the history of every database…** clears it all. Removing a database from bbdump deletes its history. The AI tool may keep its own copy of a conversation, as it does for any session.
