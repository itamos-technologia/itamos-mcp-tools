/**
 * MCP shim for web_skeleton.
 *
 * Web page skeletonizer — gives LLMs structured perception of web pages.
 * 97% token reduction vs raw HTML. Uses headless Chromium via CDP.
 * Zero npm dependencies.
 *
 * Implementation lives in /tank/projects/mcp-servers/tools/web-skeleton/
 * — this file just re-exports the tool definition so server-modular.js's
 * mcp_tools/ loader picks it up.
 */

import tool from '../tools/web-skeleton/web_skeleton.js';
export default tool;
