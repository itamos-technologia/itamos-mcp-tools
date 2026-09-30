import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export default {
  name: 'git',
  description: 'Git operations inside your sandbox. Use clone to pull a repo, status to see changes, commit to save your work.',
  schema: {
    action:  z.enum(['clone', 'status', 'commit']).describe('Git action'),
    url:     z.string().optional().describe('Repository URL (for clone)'),
    message: z.string().optional().describe('Commit message (for commit)'),
    dir:     z.string().optional().describe('Target directory name for clone'),
  },
  async handler(args, ctx) {
    try {
      const { sandboxDir } = ctx;

      if (args.action === 'clone') {
        if (!args.url) return { content: [{ type: 'text', text: 'url is required for clone' }] };
        const name = args.dir || args.url.split('/').pop().replace(/\.git$/, '');
        const dest = `${sandboxDir}/${name}`;
        const { stdout, stderr } = await execFileAsync('git', ['clone', '--depth=1', args.url, dest], { timeout: 120000 });
        return { content: [{ type: 'text', text: `Cloned into ${name}\n${stdout || stderr}` }] };
      }

      if (args.action === 'status') {
        const { stdout } = await execFileAsync('git', ['-C', sandboxDir, 'status', '--short'], { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout || 'No changes' }] };
      }

      if (args.action === 'commit') {
        if (!args.message) return { content: [{ type: 'text', text: 'message is required for commit' }] };
        await execFileAsync('git', ['-C', sandboxDir, 'add', '-A'], { timeout: 10000 });
        const { stdout } = await execFileAsync('git', ['-C', sandboxDir, 'commit', '-m', args.message], { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout }] };
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  },
};
