# Itamos MCP Tools

> **Built in Greece, for the world.**
> Free and open source under AGPL-3.0. Commercial licences for closed-source use.

---

## The problem

Every LLM coding assistant faces the same wall: codebases are too large to fit in context. The standard response is to dump files — grep for something promising, cat it, hope for the best. At 50k files this breaks. At 240k files it never worked.

We built four tools that give an LLM structured perception of a codebase instead of raw file access, plus a sandboxed git to bring code in. The result is a model that navigates code the way a senior engineer does — starting from the architecture, narrowing to the module, reading only the segment it needs. One call takes it from the project straight to the lines it needs, and every save is checked before it lands.


**Read the full paper:** [docs/PAPER.md](docs/PAPER.md): how each tool works, why it was designed that way, and how the hosted sandbox runs, with diagrams.

---

## Tools

| Tool | What it does |
|------|-------------|
| read_file | The single entry point. With no path it lists your projects; a project name shows its structure with coordinates (no code); a coordinate opens a file map or one segment in a single call. Edits one segment at a time, and every save is verified automatically. |
| master_architect | The engine behind read_file. Indexes the codebase into a graph (files, imports, databases, servers) and keeps it in step with every save. In the sandbox it is not called directly: read_file does it. |
| write_file | Creates new files only and never overwrites; edits go through read_file. Every new file belongs to a project the agent names: an existing one, or a new name to start one. Nothing is placed automatically. |
| git | The original Itamos git tool, sandboxed for security: clone (remote URLs only, depth=1), status, commit. A clone is scanned into a project as soon as it finishes. Everything stays inside the session workspace; push is not available. |
| web_skeleton | LLM-first web perception. 97% token reduction vs raw HTML. Actions: search, skeleton, read, click. |

**At least 97% fewer tokens** than the usual shell workflow (grep, cat, run_cmd), measured against the best case where the model fixes the bug in one attempt. Real sessions save more, because the failed attempts common with raw shell access aren't counted.

---

## How it works

### Session model

Every client gets an isolated workspace. No shared state, no cross-session leakage. Workspaces are wiped after 10 minutes of inactivity.

### Navigation: project → file → segment

```
read_file()                                            → your projects
read_file(path="itsdangerous")                         → the structure: folders and files with coordinates, no code
read_file(path="itsdangerous", segment="d.a.f")        → the map of signer.py, one line per segment
read_file(path="itsdangerous", segment="d.a.f.31.17")  → the code of verify_signature, nothing else
```

**Coordinates**: letters are location (folders and files share one sequence per folder), numbers are what is inside a file. `d.a.f.31.17` reads as src → itsdangerous → signer.py → segment 31.17. A folder that has never been scanned is scanned on first read; a cloned repository is scanned as soon as the clone finishes.

**Nothing is dumped**: a structure or file map over ~3,000 tokens returns an overview and asks for a search term instead. `search` works on both: file and folder names in a project, segment names in a file. `trace=true` shows what a file connects to, or a project's data flow.

### Segments

Files are parsed into named segments. A 5000-line file might have 40 segments; its map is one line per segment, with classes listing their methods. The model reads the map, picks the segment it needs, reads that segment. Total context used is roughly 120 lines instead of 5000.

### Editing and verification

One edit at a time, and only on segments the model has read since the last change, so it can never change code it has not looked at. Saving verifies the file first:

| Level | Checks | On failure |
|---|---|---|
| L1 | Syntax: tree-sitter plus the language's own checker (py_compile, node --check, php -l, bash -n, gofmt, C/C++ in project context, config parsers) | Not saved; the error names the line |
| L2 | Config files through their service's checker (nginx -t, sshd -t, visudo, systemd-analyze). Linters run too | Config failure: not saved. Linter findings are only reported |
| L3 | Connections: every local import resolves to a project file (Python and JavaScript/TypeScript: any other import must be an installed package, for Python in the project's venv when it has one); SQL is checked against the live database schema | Saved, with what is incomplete and how to see it, so a project's first files can import files that don't exist yet |

L3 checks the content being saved, not an older index, and every save re-indexes the file in every supported language, so the map never lags behind the disk.

### web_skeleton token reduction

Raw HTML of a modern web page runs 50,000 to 200,000 tokens. web_skeleton output is 500 to 3,000 tokens. The model reads the skeleton, picks the section id it needs, reads that section only.

---

## Benchmarks

Verified in live use with **Claude Opus 5.5** and **Claude Sonnet**. Any MCP-capable model can use the tools.

Don't take our word for it. Test the tools free in the hosted sandbox with your own model and your own repository, then post your results in [Discussions → Benchmarks](https://github.com/Itamos-technologia/itamos-mcp-tools/discussions): model, task, tokens, time.

**Found a bug?** [Open an issue](https://github.com/Itamos-technologia/itamos-mcp-tools/issues) with the steps to reproduce it. Every report makes the tools better.

---

## Connecting

The sandbox server speaks standard MCP over HTTP POST with SSE support.

Compatible with any MCP client. Used in practice through Claude.ai and through direct API integration (our benchmark harness).

Hosted sandbox (free live alpha): add `https://mcp.itamos-technologia.com/mcp` as a connector in any MCP client. A page opens where you create your sandbox with one click, no account needed. Sandboxes are deleted after 10 minutes of inactivity, so don't use them for sensitive data.

---

## Self-hosting

### Requirements

- **Linux with ZFS (required).** Every sandbox is its own ZFS dataset with a hard size limit (quota) and compression, so no user can fill the disk for everyone else. The server checks this at startup and refuses to start without it.
- **Node.js 20 or newer**, plus build tools for the native modules (Debian/Ubuntu: `apt install build-essential python3`).
- **git** for the git tool, and **Chrome or Chromium** for web_skeleton.

### Install

```sh
git clone https://github.com/itamos-technologia/itamos-mcp-tools.git
cd itamos-mcp-tools
npm install
```

One `npm install` sets up everything, including the tools folder.

**On Ubuntu 26.04** you can install the package from [Releases](https://github.com/itamos-technologia/itamos-mcp-tools/releases) instead: `sudo apt install ./itamos-mcp-tools_1.1.0_all.deb`. It sets up a service user, a systemd service, settings in `/etc/itamos-mcp-tools/env` and the command `itamos-mcp-create-slots`, then tells you the next two steps.

### Create the sandbox slots

```sh
sudo scripts/create-slots.sh tank/sandboxes 500 2G $USER
```

This creates `slot_001` to `slot_500` under the ZFS dataset `tank/sandboxes` (use your own pool name), each with a 2 GB quota and lz4 compression, owned by the user the server runs as. It is safe to run again.

### Start

```sh
SANDBOX_ROOT=/tank/sandboxes SANDBOX_TOTAL_SLOTS=500 npm start
```

From the same machine, add `http://localhost:4200/mcp` as a connector in your MCP client. Local connections are identified by IP address and need no sign-in.

### Going public

**Firewall port 4200** and put an HTTPS reverse proxy (for example nginx) in front of it that sets `X-Forwarded-For` and `X-Forwarded-Proto`. Requests that arrive through the proxy use the anonymous one-click sign-in, so users on shared addresses (such as claude.ai) each get their own sandbox. Direct connections to port 4200 skip the sign-in, which is why the port must not be reachable from outside.

### Text models (optional)

read_file and web_skeleton give untitled paragraphs and page sections a short title (5 to 10 words) from a small summarizer model, so the agent can tell parts apart without reading them. Without a summarizer everything still works; those parts are then named by their first line.

Any OpenAI-compatible chat endpoint works, set with `ITAMOS_SUMMARIZER_URL` (default `http://127.0.0.1:8090`): a single `llama-server`, Ollama, or the included router in front of several GPUs. The whole paragraph is always sent, never cut.

The hosted sandbox runs **Gemma 4 E4B** (Q4_0) as summarizer and **EmbeddingGemma 300M** as embedder on three GPUs (one 16 GB MI50 and two 8 GB V340 dies), each summarizer started like this:

```sh
llama-server -m gemma-4-E4B-it-Q4_0.gguf -ngl 99 --port 8190 \
  -np 64 -c 524288 --kv-unified -fa on --cache-type-k q4_0 --cache-type-v q4_0 -rea off
```

- `--kv-unified`: one shared KV pool, so each request uses only the tokens it needs.
- `--cache-type-k q4_0 --cache-type-v q4_0` (needs `-fa on`): a 4-bit KV cache, about 4.5 KB per token for this model.
- `-c` is the pool in tokens: 524,288 on the MI50, 262,144 on each V340 die (with 32 slots).

**The router** (`router/llm-router.js`, service `itamos-llm-router`) listens on 8090 (summarizer) and 8091 (embedder). Before sending a request it counts its tokens with the backend's own tokenizer, sends it to a GPU whose pool has room (preferring faster GPUs by weight), and makes it wait in line when none has. A GPU that fails is skipped for 15 seconds and the request is retried on another. Configure it with `ROUTES` (in the package: `/etc/itamos-mcp-tools/router.env`); `GET /router/status` shows each GPU's pool, reserved tokens and queue.

The embedder on 8091 serves other Itamos services; the tools don't use embeddings yet.

### Settings

| Variable | Default | What it does |
|---|---|---|
| `SANDBOX_ROOT` | `/fast/sandboxes` | Folder holding the slot datasets |
| `SANDBOX_TOTAL_SLOTS` | `500` | Number of slots |
| `SANDBOX_PORT` | `4200` | Port the server listens on |
| `SANDBOX_TTL_MINUTES` | `10` | Idle minutes before a sandbox is emptied |
| `SANDBOX_DATA_DIR` | `./data` | Where sign-in data is kept (hashed) |
| `PUBLIC_BASE_URL`, `PUBLIC_MCP_URL` | from the proxy headers | Public addresses, if the proxy can't supply them |
| `WEB_SKELETON_PUBLIC_ONLY` | off | Set to `1` on a public server: web_skeleton then refuses private and local addresses |
| `ITAMOS_SUMMARIZER_URL` | `http://127.0.0.1:8090` | Summarizer for titles (any OpenAI-compatible chat endpoint). Empty turns titling off |
| `ITAMOS_SUMMARIZER_MODEL` | `summarizer` | Model name sent with each request; only Ollama needs a real one |
| `SANDBOX_SMTP_CREDENTIALS` | a path on the Itamos server | JSON file (`email`, `app_password`, `smtp_server`, `smtp_port`) for the optional "your sandbox is ready" email. Without it the email is not sent and the server logs why. |
| `ITAMOS_COSTS_DB` | a path on the Itamos server | SQLite file for token-savings statistics. If it can't be written, statistics are skipped. |

---

## License

Dual licensed. Free under **AGPL-3.0**: use, modify and share, with source published for modified versions, including network use. Building it into a closed product? A **commercial licence** removes the AGPL obligations. Contact info@itamos-technologia.com.

---

## About

Designed and built by **Konstantinos Karamperis**, founder of Itamos Technologia in Trikala, Greece. A systems architect with a background in industrial engineering and infrastructure, building AI-native developer tools on AMD hardware with open-source inference stacks.

[LinkedIn](https://www.linkedin.com/in/konstantinos-karamperis-a645b654) · [itamos-technologia.com](https://itamos-technologia.com)