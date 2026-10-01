# Architecture & Design Decisions

This document explains how each tool works and why it was built the way it was.

---

## master_architect

### What it does

master_architect builds and queries a SQLite graph of a codebase. Every file, module, function, import, and database reference becomes a node. Every import becomes a directed edge. The result is a queryable map of the entire project.

### Actions

| Action | Purpose |
|--------|---------|
| scan | Crawl a directory, parse all files, populate the graph |
| register | Seed from a single file, follow imports to build the connected component |
| topology | Return the data-flow graph: nodes with addresses, edges with import relationships |
| bones | Compact view of one file: imports, exports, and module list with addresses |
| navigate | Fetch structural or raw content at a specific address |
| connections | Incoming and outgoing imports for a given address |
| missing | Report broken local imports across a project |
| stats | Counts across all projects in the DB |
| list | All known projects |

### Why SQLite

The graph needs to survive across sessions and support fast address lookups by project, file, and segment. SQLite is zero-dependency, embedded, and handles graphs with hundreds of thousands of nodes without infrastructure. Redis or Postgres would require deployment; SQLite requires nothing.

### Why hierarchical addressing

Addresses like 13.2.4 mean file 13, module 2, method 4. They are stable across reads within a session and compact enough to pass back and forth in tool calls without token overhead. Line numbers change on every edit. Structural addresses do not.

### Why a per-session DB

In multi-tenant use, two users working on different codebases must not share a graph. The sandbox server sets MASTER_ARCHITECT_DB per session slot, giving each workspace its own isolated SQLite file. The implementation is a single env var check in db.js.

---

## read_file

### What it does

read_file parses a file into named segments using tree-sitter. It returns a skeleton by default: a list of segments with name, line range, and byte count. The model reads the skeleton, identifies the segment it needs, and fetches that segment. Edits follow a read then verify then commit transaction model.

### Why segments instead of lines

Line ranges are fragile. A segment named authenticate_user remains valid after the function moves from line 214 to line 389. The model can reference it by address and the tool resolves the current position. This also prevents the model from editing code it has not read: the tool enforces read-before-write at the protocol level.

### Why verify then commit

A two-phase write catches syntax errors before they hit disk. Level 1 validation runs tree-sitter. Level 2 runs the language compiler. Level 3 validates imports and external references. The model gets a structured error if verification fails and can fix it before committing.

### Project awareness

When a file is opened, read_file queries the master_architect DB for its project membership and attaches a project field to the response. If the file is not yet known, a link-discovery hook files it automatically. This is purely additive: if the DB is unavailable, read_file behaves exactly as before.

---

## write_file

### What it does

write_file creates new files and places them into the project graph automatically. It refuses to overwrite existing files: that path goes through read_file replace, which enforces the read-before-write contract.

### Why refuse overwrites

Silent overwrites are the most common source of data loss in agentic coding loops. By making write_file creation-only, the tool surface is unambiguous: write_file for new files, read_file for edits. The model cannot accidentally destroy existing code.

---

## git

### What it does

Provides three operations inside the session sandbox: clone, status, commit. All operations are path-jailed to the session workspace. The model cannot clone into or commit from outside its slot.

### Why shallow clone only

depth=1 cuts clone time from minutes to seconds for large repos and avoids filling the sandbox with objects that will never be read. Benchmark tasks and real-world coding tasks rarely need history.

### Why only three operations

clone, status, and commit cover the full agentic loop: pull the code, make changes, save them. Push is intentionally excluded from the public sandbox: the model should not be able to push to external repositories from a shared environment.

---

## web_skeleton

### What it does

web_skeleton uses headless Chromium via the Chrome DevTools Protocol to render a page, then reduces it to a structural skeleton: headings, sections, links, and form elements, each with a stable element id. Four actions: search, skeleton, read, click.

### Why headless Chromium

JavaScript-rendered content is invisible to HTML parsers. Most modern documentation sites, dashboards, and SPAs require JS execution to produce their real content. CDP gives us a fully rendered DOM without any npm dependencies.

### Why 97% token reduction

Raw HTML contains layout scaffolding, inline styles, tracking scripts, and ad markup. None of this carries semantic content for an LLM. The skeleton retains only the document information structure. A 150,000-token raw page becomes a 2,000-token skeleton. The model reads the skeleton and fetches only the section it needs.

### Zero npm dependencies

The entire web_skeleton implementation uses only Node.js built-ins plus the system Chromium binary. This keeps the tool portable and eliminates dependency management in the sandbox environment.
