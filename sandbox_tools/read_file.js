/**
 * MCP shim for read_file.
 *
 * Segment-addressed file editor with master-architect project awareness.
 *
 * On file open, queries master-architect's DB to detect project membership
 * and attaches a `project` field to the response (skeleton, address, etc.).
 * If the opened file is not yet placed in a project, a link-discovery hook
 * files it (auto-absorbing unknown_N clusters into a real project when a
 * link resolves) — never prompts, never breaks the read.
 *
 * Implementation lives in ../tools/master-architect/read_file.js (post-merger
 * location). This file just re-exports the tool definition so
 * server-modular.js's mcp_tools/ loader picks it up.
 *
 * If the master-architect DB is missing or unavailable, project-info lookup
 * and link-discovery degrade gracefully and read_file behaves exactly like
 * before. The architect linkage is purely additive.
 */

import tool from '../tools/master-architect/read_file.js';
export default tool;
