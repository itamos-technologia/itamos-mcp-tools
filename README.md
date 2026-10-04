# Itamos MCP Tools

> **Built in Greece, for the world.**
> Free for individuals and open-source projects. Commercial licensing for organisations.

---

## The problem

Every LLM coding assistant faces the same wall: codebases are too large to fit in context. The standard response is to dump files — grep for something promising, cat it, hope for the best. At 50k files this breaks. At 240k files it never worked.

We built five tools that give an LLM structured perception of a codebase instead of raw file access. The result is a model that navigates code the way a senior engineer does — starting from the architecture, narrowing to the module, reading only the segment it needs.

---

## Tools

| Tool | What it does |
|------|-------------|
| master_architect | Project-aware code navigation. Builds a graph of your codebase, exposes topology, per-file bone structure, and segment-level addressing. The entry point for any codebase task. |
| read_file | Segment-addressed file editor. Returns a skeleton by default. Read segment N to get the code. Edit with verify then commit. Project-aware. |
| write_file | Create new files with automatic project placement. Refuses overwrites — edits go through read_file. |
| git | The original Itamos git tool, sandboxed for security: clone (remote URLs only, depth=1), status, commit. Everything stays inside the session workspace; push is not available. |
| web_skeleton | LLM-first web perception. 97% token reduction vs raw HTML. Actions: search, skeleton, read, click. |

---

## How it works

### Session model

Every client gets an isolated workspace. No shared state, no cross-session leakage. Workspaces are wiped after 10 minutes of inactivity.

### master_architect navigation flow

The model is guided through four phases: scan to index the repo, topology to see the data-flow graph, bones to inspect a file, navigate or read_file to read the specific segment. The model never reads a file it has not first located in the graph.

### read_file segment addressing

Files are parsed into named segments. A 5000-line file might have 40 segments. The model reads the skeleton, picks the segment it needs, reads that segment. Total context used is roughly 120 lines instead of 5000.

### web_skeleton token reduction

Raw HTML of a modern web page runs 50,000 to 200,000 tokens. web_skeleton output is 500 to 3,000 tokens. The model reads the skeleton, picks the section id it needs, reads that section only.

---

## Benchmarks

Verified in live use with **Claude Opus 5.5** and **Claude Sonnet**. Other frontier models, including OpenAI's, are expected to work; Claude Haiku and OpenAI benchmarks are pending.

A recorded, unedited bug-fix session on a real open GitHub issue is coming to BENCHMARKS.md, with the time and tokens it took.

---

## Connecting

The sandbox server speaks standard MCP over HTTP POST with SSE support.

Compatible with any MCP client. Used in practice through Claude.ai and through direct API integration (our benchmark harness).

Hosted sandbox: coming soon at mcp.itamos.eu

---

## License

Free for personal use and open-source projects. Commercial use requires a licence — contact tcnbinas@gmail.com.

---

## About

Built by Itamos Technologia — a one-person company in Trikala, Greece.
Part of a suite of AI-native developer tools built on AMD hardware with open-source inference stacks.