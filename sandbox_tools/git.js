import { z } from 'zod';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Background clone jobs ───────────────────────────────────────────────────────
// One job per sandbox: the clone (reporting git's own progress), then an
// automatic master_architect scan through ctx.scanRepo. Small repos finish
// within QUICK_WAIT_MS and get the final result straight away; bigger ones
// reply at once and the AI checks progress with action "job".
const jobs = new Map();          // sandboxDir → job
const QUICK_WAIT_MS = 5000;
const CLONE_TIMEOUT_MS = 120000;
const forgetHooks = globalThis.__sandboxForgetHooks;
const forgetJob = (dir) => jobs.delete(dir);
if (forgetHooks?.add) forgetHooks.add(forgetJob); else if (forgetHooks?.push) forgetHooks.push(forgetJob);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Never show internal server paths to users.
const hidePaths = (text, sandboxDir) => String(text).split(sandboxDir).join('.');

function startCloneJob(sandboxDir, url, dest, label, scanLabel, ctx) {
  const job = { phase: 'cloning', step: 'Starting', pct: null, started: Date.now(), label, result: null, error: null };
  const keepAlive = setInterval(() => { try { ctx.touch?.(); } catch {} }, 30000);
  job.done = (async () => {
    try {
      // core.symlinks=false: symlinks in the repo are checked out as plain
      // text files holding the link target, so a cloned repo can never plant
      // a link that points out of the sandbox.
      await new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.symlinks=false', 'clone', '--progress', '--depth=1', '--', url, dest],
                            { stdio: ['ignore', 'ignore', 'pipe'] });
        let tail = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), CLONE_TIMEOUT_MS);
        child.stderr.on('data', (d) => {
          tail = (tail + d.toString()).slice(-2000);
          const m = [...tail.matchAll(/(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files)[^:\r\n]*:\s+(\d+)%/g)].pop();
          if (m) { job.step = m[1]; job.pct = Number(m[2]); }
        });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) return resolve();
          const last = tail.split(/[\r\n]+/).filter(Boolean).pop();
          reject(new Error(signal ? `clone stopped after ${CLONE_TIMEOUT_MS / 1000}s` : (last || `git exited with code ${code}`)));
        });
      });
      job.phase = 'scanning';
      job.scanStarted = Date.now();
      let scanNote = '';
      if (ctx.scanRepo) {
        try {
          const info = await ctx.scanRepo(dest);
          if (info.ok) {
            scanNote = `Scanned into project '${info.project_name}' (${info.files_total} files). `
              + `Next: read_file(path="${scanLabel}") shows its structure.`;
            // The scan linked the files; now validate them in the background,
            // one file at a time (levels L1/L2/L3 stored in the architect).
            import('../tools/master-architect/read_file.js')
              .then((m) => m.runValidationQueue && m.runValidationQueue())
              .catch((e) => console.error(`[validate] could not start: ${e.message}`));
          } else {
            scanNote = `The scan did not finish; read_file(path="${scanLabel}") scans it.`;
          }
        } catch (e) {
          scanNote = `The scan failed (${e.message}); read_file(path="${scanLabel}") scans it.`;
        }
      }
      job.result = `Cloned into ${label}.\n${scanNote}`.trim();
      job.phase = 'done';
    } catch (e) {
      job.error = e.message;
      job.phase = 'failed';
    } finally {
      clearInterval(keepAlive);
      try { ctx.touch?.(); } catch {}
    }
  })();
  jobs.set(sandboxDir, job);
  return job;
}

// Turn git's cryptic failures into a plain explanation the AI can pass on.
function explainCloneError(raw) {
  const msg = String(raw || '');
  if (/could not read Username|Authentication failed|Repository not found|terminal prompts disabled/i.test(msg)) {
    return 'Repository not found, or it is private. Check the URL; only public repositories can be cloned here.';
  }
  if (/Could not resolve host|unable to access|Connection (timed out|refused)|Failed to connect/i.test(msg)) {
    return 'Could not reach the git server. Check the URL, or try again in a moment.';
  }
  if (/clone stopped after/i.test(msg)) {
    return `${msg}. The repository is probably too large for the sandbox; try a smaller one.`;
  }
  if (/already exists and is not an empty directory/i.test(msg)) {
    return 'That folder already exists and is not empty. Pass a different dir.';
  }
  if (/No space left|Disk quota exceeded/i.test(msg)) {
    return 'The repository does not fit in the sandbox (2 GB limit). Try a smaller one.';
  }
  return msg;
}

function jobReport(job, sandboxDir) {
  const since = (t) => Math.round((Date.now() - t) / 1000);
  let text;
  let isError = false;
  if (job.phase === 'done') text = job.result;
  else if (job.phase === 'failed') { text = `Clone failed: ${explainCloneError(job.error)}`; isError = true; }
  else if (job.phase === 'cloning') {
    text = `Cloning into ${job.label}: ${job.step}${job.pct !== null ? ` ${job.pct}%` : ''} (${since(job.started)}s so far). `
      + 'Still working, not stuck. Check again with git action "job" in a few seconds; do not start the clone again.';
  } else {
    text = `Clone finished; now mapping the repository (${since(job.scanStarted)}s so far). `
      + 'Still working, not stuck. Check again with git action "job" in a few seconds.';
  }
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: hidePaths(text, sandboxDir) }] };
}


export default {
  name: 'git',
  description: 'Git operations inside your sandbox. Use clone to pull a repo: when it finishes, the folder is scanned into a project and read_file(path="<folder>") shows its structure. '
    + 'Small repos return the finished result directly; for bigger ones clone replies at once and keeps working in the background, so check it with action "job" every few seconds (never start the clone again). '
    + 'Use status to see changes and commit to save your work. clone defaults to the sandbox root when dir is omitted; pass the same dir to status/commit afterwards.',
  schema: {
    action:  z.enum(['clone', 'job', 'status', 'commit']).describe('Git action. job = progress of the running clone'),
    url:     z.string().optional().describe('Repository URL (for clone) — must be a remote git/http(s)/ssh URL, not a local path'),
    message: z.string().optional().describe('Commit message (for commit)'),
    dir:     z.string().optional().describe('Target directory for clone (relative to the sandbox, default: sandbox root), and for status/commit when the repo is not in the sandbox root'),
  },
  async handler(args, ctx) {
    const { sandboxDir } = ctx;
    const fail = (text) => ({ isError: true, content: [{ type: 'text', text: hidePaths(text, sandboxDir) }] });
    try {
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

      if (args.action === 'job') {
        const job = jobs.get(sandboxDir);
        if (!job) return { content: [{ type: 'text', text: 'No clone has been started in this sandbox yet.' }] };
        return jobReport(job, sandboxDir);
      }

      if (args.action === 'clone') {
        const running = jobs.get(sandboxDir);
        if (running && (running.phase === 'cloning' || running.phase === 'scanning')) {
          return jobReport(running, sandboxDir);
        }
        if (!args.url) return fail('url is required for clone');

        // Only allow fetching from a remote git service, never a path on this host.
        const url = args.url.trim();
        const isRemote = /^(https?|git|ssh):\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url); // scp-like git@host:path
        if (!isRemote) return fail('clone url must be a remote git/http(s)/ssh URL, not a local path');

        // No dir given -> clone straight into the slot root (matches the default status/commit target).
        const dest = await resolveInSandbox(args.dir || '.');
        if (!dest) return fail('dir must stay inside the sandbox');
        if (!args.dir) {
          const existing = await fsp.readdir(dest).catch(() => []);
          if (existing.length) return fail('sandbox root is not empty — pass dir to clone into a subfolder');
        }

        const label = args.dir || '. (sandbox root)';
        const job = startCloneJob(sandboxDir, url, dest, label, args.dir || '.', ctx);
        await Promise.race([job.done, sleep(QUICK_WAIT_MS)]);
        if (job.phase === 'done' || job.phase === 'failed') return jobReport(job, sandboxDir);
        const report = jobReport(job, sandboxDir);
        return { content: [{ type: 'text', text: `Clone started and running in the background. ${report.content[0].text}` }] };
      }

      if (args.action === 'status') {
        const cwd = await resolveInSandbox(args.dir);
        if (!cwd) return fail('dir must stay inside the sandbox');
        const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--short'], { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout || 'No changes' }] };
      }

      if (args.action === 'commit') {
        if (!args.message) return fail('message is required for commit');
        const cwd = await resolveInSandbox(args.dir);
        if (!cwd) return fail('dir must stay inside the sandbox');
        await execFileAsync('git', ['-C', cwd, '-c', 'user.email=sandbox@itamos.local', '-c', 'user.name=sandbox',
                                     'add', '-A'], { timeout: 10000 });
        const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.email=sandbox@itamos.local', '-c', 'user.name=sandbox',
                                                        'commit', '-m', args.message], { timeout: 10000 });
        return { content: [{ type: 'text', text: stdout }] };
      }
      return fail(`unknown action: ${args.action}`);
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
};
