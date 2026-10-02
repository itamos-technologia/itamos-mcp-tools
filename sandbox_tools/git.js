import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export default {
  name: 'git',
  description: 'Git operations inside your sandbox. Use clone to pull a repo, status to see changes, commit to save your work. clone defaults to the sandbox root when dir is omitted; pass the same dir to status/commit afterwards.',
  schema: {
    action:  z.enum(['clone', 'status', 'commit']).describe('Git action'),
    url:     z.string().optional().describe('Repository URL (for clone) — must be a remote git/http(s)/ssh URL, not a local path'),
    message: z.string().optional().describe('Commit message (for commit)'),
    dir:     z.string().optional().describe('Target directory for clone (relative to the sandbox, default: sandbox root), and for status/commit when the repo is not in the sandbox root'),
  },
  async handler(args, ctx) {
    try {
      const { sandboxDir } = ctx;
      const path = await import('path');
      const fsp  = await import('fs/promises');

      // Resolve dir against sandboxDir and refuse anything that escapes it
      // (absolute path, ../ traversal, or a symlink pointing outside).
      async function resolveInSandbox(rawDir) {
        const joined   = path.resolve(sandboxDir, rawDir || '.');
        const rootReal = await fsp.realpath(sandboxDir);
        const real     = await fsp.realpath(joined).catch(() => joined); // ok if it doesn't exist yet (clone dest)
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
        return joined;
      }

      if (args.action === 'clone') {
        if (!args.url) return { content: [{ type: 'text', text: 'url is required for clone' }] };

        // Only allow fetching from a remote git service, never a path on this host.
        const url = args.url.trim();
        const isRemote = /^(https?|git|ssh):\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url); // scp-like git@host:path
        if (!isRemote) {
          return { content: [{ type: 'text', text: 'clone url must be a remote git/http(s)/ssh URL, not a local path' }] };
        }

        // No dir given -> clone straight into the slot root (matches the default status/commit target).
        const dest = await resolveInSandbox(args.dir || '.');
        if (!dest) return { content: [{ type: 'text', text: 'dir must stay inside the sandbox' }] };
        if (!args.dir) {
          const existing = await fsp.readdir(dest).catch(() => []);
          if (existing.length) {
            return { content: [{ type: 'text', text: 'sandbox root is not empty — pass dir to clone into a subfolder' }] };
          }
        }

        const { stdout, stderr } = await execFileAsync('git', ['clone', '--depth=1', '--', url, dest], { timeout: 120000 });
        const label = args.dir || '. (sandbox root)';
        return { content: [{ type: 'text', text: `Cloned into ${label}\n${stdout || stderr}` }] };
      }

      if (args.action === 'status') {
        const cwd = await resolveInSandbox(args.dir);
        if (!cwd) return { content: [{ type: 'text', text: 'dir must stay inside the sandbox' }] };
        const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--short'], { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout || 'No changes' }] };
      }

      if (args.action === 'commit') {
        if (!args.message) return { content: [{ type: 'text', text: 'message is required for commit' }] };
        const cwd = await resolveInSandbox(args.dir);
        if (!cwd) return { content: [{ type: 'text', text: 'dir must stay inside the sandbox' }] };
        await execFileAsync('git', ['-C', cwd, '-c', 'user.email=sandbox@itamos.local', '-c', 'user.name=sandbox',
                                     'add', '-A'], { timeout: 10000 });
        const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.email=sandbox@itamos.local', '-c', 'user.name=sandbox',
                                                        'commit', '-m', args.message], { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout }] };
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  },
};
