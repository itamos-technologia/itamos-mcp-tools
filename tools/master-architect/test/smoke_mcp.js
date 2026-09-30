/**
 * Smoke test for the MCP wrapper. Calls the handler directly (no MCP server
 * needed) to exercise every action and verify response shapes.
 */

import tool from '../master_architect.js';

process.env.MASTER_ARCHITECT_DB = '/scratch/bncs/dev-master-architect/master-architect.db';

const ctx = { userId: 'smoke_test_user' };

async function call(args, label) {
  console.log(`\n── ${label || args.action} ─────────────────────`);
  const r = await tool.handler(args, ctx);
  // Response is { content: [{ type: 'text', text: '...' }] }
  const parsed = JSON.parse(r.content[0].text);
  // Print a one-line summary, full JSON only if small
  const jsonStr = JSON.stringify(parsed);
  if (jsonStr.length < 300) {
    console.log(jsonStr);
  } else {
    // Show top-level keys + count of any arrays
    const summary = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) summary[k] = `[${v.length} items]`;
      else if (typeof v === 'object' && v !== null) summary[k] = `{${Object.keys(v).join(',')}}`;
      else summary[k] = v;
    }
    console.log(JSON.stringify(summary));
  }
  return parsed;
}

(async () => {
  // 1. languages — should list 37+ languages with categories
  await call({ action: 'languages' });

  // 2. stats — should show projects already in DB from prior tests
  await call({ action: 'stats' });

  // 3. list — should show mcp-servers project
  await call({ action: 'list' });

  // 4. estimate — fast pre-scan
  await call({ action: 'estimate', path: '/tank/projects/mcp-servers' }, 'estimate mcp-servers');

  // 5. project_for — exact match
  await call({ action: 'project_for', path: '/tank/projects/mcp-servers/server-modular.js' },
              'project_for known file');

  // 6. project_for — no match
  await call({ action: 'project_for', path: '/tmp/random.js' }, 'project_for unknown');

  // 7. navigate to a file
  await call({ action: 'navigate', project_id: 1, address: '11' }, 'navigate to file 11');

  // 8. navigate to a module
  await call({ action: 'navigate', project_id: 1, address: '11.1' }, 'navigate to module 11.1');

  // 9. connections for a file
  await call({ action: 'connections', project_id: 1, address: '11' }, 'connections for 11');

  // 10. context for a file by abs_path
  await call({ action: 'context', path: '/tank/projects/mcp-servers/server-modular.js' });

  // 11. missing imports
  await call({ action: 'missing', project_id: 1 });

  // 12. discover from a file with internal imports
  await call({ action: 'discover', path: '/tank/development/architect-tool/demo-navigation.js' },
              'discover from demo-navigation');

  // 13. error case: missing arg
  await call({ action: 'navigate', project_id: 1 }, 'navigate without address (should fail)');

  // 14. error case: unknown action
  await call({ action: 'bogus' }, 'unknown action (should fail)');

  console.log('\n✓ All actions smoke-tested.');
})();
