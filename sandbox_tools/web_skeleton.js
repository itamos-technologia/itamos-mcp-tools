/**
 * MCP shim for web_skeleton (sandbox).
 *
 * Re-exports the tool and flags its error results (blocked URLs, unreachable
 * pages) as MCP errors, so models treat them as failures instead of content.
 */

import tool from '../tools/web-skeleton/web_skeleton.js';

export default {
  ...tool,
  async handler(args, ctx) {
    const r = await tool.handler.call(tool, args, ctx);
    const text = r?.content?.[0]?.text || '';
    return /^\[WebSkeleton Error\]/.test(text) ? { ...r, isError: true } : r;
  },
};
