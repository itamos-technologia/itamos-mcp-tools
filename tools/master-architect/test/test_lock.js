import { scanProject, listActiveScans } from '../lib/scan.js';

process.env.MASTER_ARCHITECT_DB = '/scratch/bncs/dev-master-architect/master-architect.db';

(async () => {
  console.log('Starting scan #1 (shopbot, ~40s) for user=alice...');
  const p1 = scanProject('/tank/projects/shopbot', 'shopbot', { userId: 'alice', expectedMs: 43000 });

  // Wait briefly so #1 has registered the lock, then fire #2 and #3
  await new Promise(r => setTimeout(r, 100));
  const active = listActiveScans();
  console.log('Active scans (should show alice):', active.map(s => `user=${s.user_id} elapsed=${s.elapsed_ms}ms`).join(', '));

  console.log('\nFiring scan #2 for user=alice (same project)...');
  const r2 = await scanProject('/tank/projects/shopbot', 'shopbot', { userId: 'alice' });
  console.log('  →', r2.ok ? 'STARTED' : 'BLOCKED');
  if (!r2.ok) console.log('     message:', r2.message);

  console.log('\nFiring scan #3 for user=alice (DIFFERENT project, should still be blocked)...');
  const r3 = await scanProject('/tank/projects/mcp-servers', 'mcp-servers', { userId: 'alice' });
  console.log('  →', r3.ok ? 'STARTED' : 'BLOCKED');
  if (!r3.ok) console.log('     message:', r3.message);

  console.log('\nLock check for user=bob (different user, no lock should be held)...');
  const bobActive = listActiveScans('bob');
  console.log('  → bob active scans:', bobActive.length, '(expected 0; bob would be allowed to scan)');

  console.log('\nWaiting for scan #1 to complete...');
  const r1 = await p1;
  console.log('\nScan #1 completed:', r1.ok ? 'OK' : 'FAIL', '— duration:', r1.duration_ms, 'ms');

  console.log('\nAfter scan #1 finished, lock should be released. Trying scan #2 for alice again...');
  const r4 = await scanProject('/tank/projects/architect-tool', 'architect-tool', { userId: 'alice' });
  console.log('  →', r4.ok ? 'STARTED ✓ (lock correctly released)' : 'BLOCKED ✗ (lock leaked)');
  if (r4.ok) console.log('     scanned:', r4.files_total, 'files in', r4.duration_ms, 'ms');
})();
