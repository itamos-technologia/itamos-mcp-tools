/**
 * Config validators — run the service's own checker on the EDITED text
 * before it is committed (read_file verify, level 2).
 *
 *   nginx      nginx -t           full /etc/nginx context (copy + swap the edited file), as root
 *   systemd    systemd-analyze verify
 *   sshd       sshd -t            full context (sshd_config + sshd_config.d copy), as root
 *   ssh        ssh -G             client config
 *   logrotate  logrotate -d       dry run
 *   sudoers    visudo -c          (a broken sudoers file locks admins out)
 *   fstab      findmnt --verify
 *   compose    docker compose config -q
 *   apache     apachectl -t       when installed
 *
 * Nothing is reloaded or written: every check runs against a temp copy.
 *
 * Authority: on the private live server the checks run with full context and
 * a failure BLOCKS the commit. In the public sandbox there is no root and no
 * view of the host's real config, so checks run without sudo inside a
 * bubblewrap jail and their findings are ADVISORY (reported, not blocking).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BIN = {
  nginx: '/usr/sbin/nginx', systemdAnalyze: '/usr/bin/systemd-analyze', sshd: '/usr/sbin/sshd', ssh: '/usr/bin/ssh',
  logrotate: '/usr/sbin/logrotate', visudo: '/usr/sbin/visudo', findmnt: '/usr/bin/findmnt', docker: '/usr/bin/docker',
  apachectl: '/usr/sbin/apachectl', sudo: '/usr/bin/sudo',
};
const has = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
const sandboxSlot = () => globalThis.__sandboxCtx?.getStore?.()?.slotDir || null;
const inSandbox = () => Boolean(globalThis.__sandboxCtx);

function run(bin, args, { timeout = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// In the sandbox: no network, read-only system, only the temp dir visible.
function jailed(bin, args, tmp) {
  return run('/usr/bin/bwrap', ['--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/sbin', '/sbin', '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', tmp, tmp, bin, ...args]);
}

let _sudo = null;
async function canSudo() {
  if (inSandbox()) return false;
  if (_sudo === null) _sudo = has(BIN.sudo) && (await run(BIN.sudo, ['-n', 'true'], { timeout: 5000 })).code === 0;
  return _sudo;
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfgcheck-'));
const clean = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
const tail = (s, n = 6) => String(s).trim().split('\n').filter(Boolean).slice(-n).join(' | ');

function result(label, r, { authoritative, okText, errorText }) {
  if (r.ok) return { ok: true, messages: [`L2 ${label}: ${okText || 'OK'}`] };
  if (authoritative) return { ok: false, messages: [`L2 ${label}: FAILED: ${errorText}`] };
  return { ok: true, messages: [`L2 ${label} (advisory, limited context): ${errorText}`] };
}

// ── nginx ───────────────────────────────────────────────────────────────────
// Copy a tree, dereferencing symlinks, so sites-enabled links become files.
function copyTree(src, dst) {
  // Skip anything we can't read (e.g. private keys): those paths are left
  // pointing at the real files, which nginx -t reads as root.
  const readable = (f) => { try { fs.accessSync(f, fs.constants.R_OK); return true; } catch { return false; } };
  fs.cpSync(src, dst, { recursive: true, dereference: true, errorOnExist: false, filter: readable });
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

async function checkNginx(filePath, content) {
  if (!has(BIN.nginx)) return { ok: true, messages: ['L2 nginx -t: nginx not installed, skipped'] };
  const sudo = await canSudo();
  const tmp = tmpDir();
  try {
    // Full context: the edited file inside a copy of the real /etc/nginx.
    if (!inSandbox() && filePath.startsWith('/etc/nginx/') && sudo) {
      const root = path.join(tmp, 'nginx');
      copyTree('/etc/nginx', root);
      const target = fs.realpathSync.native ? safeReal(filePath) : filePath;
      // every copied file whose original resolves to the edited file gets the new text
      for (const orig of walkFiles('/etc/nginx').concat(listLinks('/etc/nginx'))) {
        if (safeReal(orig) === target) fs.writeFileSync(path.join(root, path.relative('/etc/nginx', orig)), content);
      }
      if (!fs.existsSync(path.join(root, path.relative('/etc/nginx', filePath)))) {
        fs.writeFileSync(path.join(root, path.relative('/etc/nginx', filePath)), content);   // new file
      }
      // Point include directives at the copy; everything else (certificates,
      // dhparams, snippets read by path) keeps its real path.
      for (const f of walkFiles(root)) {
        const t = fs.readFileSync(f, 'utf8');
        const u = t.replace(/^(\s*include\s+)\/etc\/nginx\//gm, `$1${root}/`);
        if (u !== t) fs.writeFileSync(f, u);
      }
      fs.chmodSync(tmp, 0o755);
      const r = await run(BIN.sudo, ['-n', BIN.nginx, '-t', '-c', path.join(root, 'nginx.conf')]);
      const text = (r.err + r.out).split(root + '/').join('/etc/nginx/');
      return result('nginx -t (full /etc/nginx context)', { ok: r.code === 0 }, { authoritative: true, okText: 'configuration test is successful', errorText: tail(text.split('\n').filter((l) => !/test failed$/.test(l)).join('\n')) });
    }
    // Standalone: the file on its own (wrapped in a minimal main config if it
    // is a site file). Other nginx files aren't visible, so this is advisory.
    const isMain = /^\s*(events|http)\s*\{/m.test(content);
    const neutral = (t) => t.replace(/^(\s*)pid\s+[^;]+;/gm, `$1pid ${tmp}/nginx.pid;`)
                            .replace(/^(\s*)(error_log|access_log)\s+[^;\s]+/gm, '$1$2 /dev/null');
    if (isMain) {
      let t = neutral(content);
      if (!/^\s*pid\s/m.test(t)) t = `pid ${tmp}/nginx.pid;\n` + t;
      fs.writeFileSync(path.join(tmp, 'nginx.conf'), t);
    } else {
      fs.writeFileSync(path.join(tmp, 'site.conf'), neutral(content));
      fs.writeFileSync(path.join(tmp, 'nginx.conf'), `pid ${tmp}/nginx.pid;\nerror_log /dev/null;\nevents {}\nhttp {\n    access_log off;\n    include ${tmp}/site.conf;\n}\n`);
    }
    const args = ['-t', '-c', path.join(tmp, 'nginx.conf'), '-e', '/dev/null'];
    const r = inSandbox() ? await jailed(BIN.nginx, args, tmp)
            : sudo ? await run(BIN.sudo, ['-n', BIN.nginx, ...args]) : await run(BIN.nginx, args);
    const text = (r.err + r.out).split(path.join(tmp, 'site.conf')).join(filePath).split(tmp + '/').join('');
    return result('nginx -t (standalone)', { ok: r.code === 0 }, { authoritative: false, okText: 'configuration test is successful', errorText: tail(text.split('\n').filter((l) => !/test failed$/.test(l)).join('\n')) });
  } finally { clean(tmp); }
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return p; } }
function listLinks(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) out.push(p); else if (e.isDirectory()) listLinks(p, out);
  }
  return out;
}

// ── systemd ─────────────────────────────────────────────────────────────────
async function checkSystemd(filePath, content) {
  if (!has(BIN.systemdAnalyze)) return { ok: true, messages: ['L2 systemd-analyze: not installed, skipped'] };
  const tmp = tmpDir();
  try {
    const f = path.join(tmp, path.basename(filePath));
    fs.writeFileSync(f, content);
    const args = ['verify', f];
    const r = inSandbox() ? await jailed(BIN.systemdAnalyze, args, tmp) : await run(BIN.systemdAnalyze, args);
    // only lines about THIS unit (verify also chatters about unrelated system units)
    const mine = (r.err + r.out).split('\n').filter((l) => l.includes(f) || l.includes(path.basename(filePath)))
      .map((l) => l.split(f).join(filePath));
    const warnings = mine.length ? ` (${mine.slice(0, 4).join(' | ')})` : '';
    // systemd only warns about an unknown key and ignores the line, which is how
    // a typo like "ExecStrat=" silently leaves a service without its command.
    const fatal = mine.filter((l) => /Unknown key|Unknown section|Invalid|Failed to parse|Missing '='|bad unit file/i.test(l));
    return result('systemd-analyze verify', { ok: r.code === 0 && fatal.length === 0 }, { authoritative: !inSandbox(), okText: 'OK' + warnings, errorText: (fatal.length ? fatal : mine).slice(0, 4).join(' | ') || tail(r.err) });
  } finally { clean(tmp); }
}

// ── sshd / ssh ──────────────────────────────────────────────────────────────
async function checkSshd(filePath, content) {
  if (!has(BIN.sshd)) return { ok: true, messages: ['L2 sshd -t: sshd not installed, skipped'] };
  if (inSandbox() || !(await canSudo())) return { ok: true, messages: ['L2 sshd -t: needs root (host keys), skipped here'] };
  const tmp = tmpDir();
  try {
    const isFragment = /\/sshd_config\.d\//.test(filePath);
    const dDir = path.join(tmp, 'sshd_config.d');
    fs.mkdirSync(dDir);
    if (fs.existsSync('/etc/ssh/sshd_config.d')) for (const e of fs.readdirSync('/etc/ssh/sshd_config.d')) {
      try { fs.copyFileSync(path.join('/etc/ssh/sshd_config.d', e), path.join(dDir, e)); } catch {}
    }
    let main = isFragment ? fs.readFileSync('/etc/ssh/sshd_config', 'utf8') : content;
    if (isFragment) fs.writeFileSync(path.join(dDir, path.basename(filePath)), content);
    main = main.split('/etc/ssh/sshd_config.d/').join(dDir + '/');
    fs.writeFileSync(path.join(tmp, 'sshd_config'), main);
    fs.chmodSync(tmp, 0o755);
    const r = await run(BIN.sudo, ['-n', BIN.sshd, '-t', '-f', path.join(tmp, 'sshd_config')]);
    const text = (r.err + r.out).split(path.join(tmp, 'sshd_config')).join(isFragment ? '/etc/ssh/sshd_config' : filePath).split(dDir + '/').join('/etc/ssh/sshd_config.d/');
    return result('sshd -t', { ok: r.code === 0 }, { authoritative: true, okText: 'OK', errorText: tail(text) });
  } finally { clean(tmp); }
}

async function checkSshClient(filePath, content) {
  if (!has(BIN.ssh)) return { ok: true, messages: ['L2 ssh -G: ssh not installed, skipped'] };
  const tmp = tmpDir();
  try {
    const f = path.join(tmp, 'config');
    fs.writeFileSync(f, content, { mode: 0o600 });
    const args = ['-G', '-F', f, 'config-check.invalid'];
    const r = inSandbox() ? await jailed(BIN.ssh, args, tmp) : await run(BIN.ssh, args);
    return result('ssh -G', { ok: r.code === 0 }, { authoritative: !inSandbox(), okText: 'OK', errorText: tail((r.err).split(f).join(filePath)) });
  } finally { clean(tmp); }
}

// ── logrotate / sudoers / fstab / compose / apache ──────────────────────────
async function checkLogrotate(filePath, content) {
  if (!has(BIN.logrotate)) return { ok: true, messages: ['L2 logrotate -d: not installed, skipped'] };
  const tmp = tmpDir();
  try {
    const f = path.join(tmp, path.basename(filePath));
    fs.writeFileSync(f, content, { mode: 0o644 });
    const args = ['-d', '-s', path.join(tmp, 'state'), f];
    const r = inSandbox() ? await jailed(BIN.logrotate, args, tmp) : await run(BIN.logrotate, args);
    // logrotate only WARNS on an unknown option and ignores the line (a typo in
    // "rotate" silently disables log retention), so those block too.
    const errs = (r.err + r.out).split('\n')
      .filter((l) => /^error:/.test(l) || (l.includes(f) && /unknown option|bad |invalid|missing|unexpected/i.test(l)))
      .map((l) => l.split(f).join(filePath));
    return result('logrotate -d', { ok: errs.length === 0 }, { authoritative: !inSandbox(), okText: 'OK', errorText: errs.slice(0, 4).join(' | ') });
  } finally { clean(tmp); }
}

async function checkSudoers(filePath, content) {
  if (!has(BIN.visudo)) return { ok: true, messages: ['L2 visudo -c: not installed, skipped'] };
  const tmp = tmpDir();
  try {
    const f = path.join(tmp, 'sudoers');
    fs.writeFileSync(f, content, { mode: 0o440 });
    const args = ['-c', '-f', f];
    const r = inSandbox() ? await jailed(BIN.visudo, args, tmp) : await run(BIN.visudo, args);
    return result('visudo -c', { ok: r.code === 0 }, { authoritative: true, okText: 'parsed OK', errorText: tail((r.err + r.out).split(f).join(filePath)) });
  } finally { clean(tmp); }
}

async function checkFstab(filePath, content) {
  if (!has(BIN.findmnt)) return { ok: true, messages: ['L2 findmnt --verify: not installed, skipped'] };
  const tmp = tmpDir();
  try {
    const f = path.join(tmp, 'fstab');
    fs.writeFileSync(f, content);
    const args = ['--verify', '--tab-file', f];
    const r = inSandbox() ? await jailed(BIN.findmnt, args, tmp) : await run(BIN.findmnt, args);
    const lines = (r.out + r.err).split('\n').filter((l) => /\[E\]|error/i.test(l)).map((l) => l.split(f).join(filePath));
    return result('findmnt --verify', { ok: r.code === 0 }, { authoritative: !inSandbox(), okText: 'OK', errorText: lines.slice(0, 4).join(' | ') || tail(r.out + r.err) });
  } finally { clean(tmp); }
}

async function checkCompose(filePath, content) {
  if (inSandbox() || !has(BIN.docker)) return { ok: true, messages: ['L2 docker compose config: not available here, skipped'] };
  const tmp = tmpDir();
  try {
    const f = path.join(tmp, path.basename(filePath));
    fs.writeFileSync(f, content);
    const r = await run(BIN.docker, ['compose', '--project-directory', path.dirname(filePath), '-f', f, 'config', '-q']);
    return result('docker compose config', { ok: r.code === 0 }, { authoritative: true, okText: 'OK', errorText: tail((r.err + r.out).split(f).join(filePath)) });
  } finally { clean(tmp); }
}

async function checkApache(filePath, content) {
  if (!has(BIN.apachectl)) return { ok: true, messages: ['L2 apachectl -t: Apache not installed, skipped'] };
  return { ok: true, messages: ['L2 apachectl -t: not wired yet for edited copies, skipped'] };
}

// ── dispatch ────────────────────────────────────────────────────────────────
const UNIT_EXTS = new Set(['.service', '.timer', '.socket', '.mount', '.automount', '.target', '.path', '.slice']);

export async function validateConfigWithTool(filePath, content, flavor) {
  const p = String(filePath || '');
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base);
  try {
    if (flavor === 'blocks' && (/\/nginx\//.test(p) || /^\s*(server|location|upstream|http|events)\b/m.test(content))) return await checkNginx(p, content);
    if (flavor === 'braces' && (/\/logrotate\.d\//.test(p) || base === 'logrotate.conf')) return await checkLogrotate(p, content);
    if (flavor === 'ini' && UNIT_EXTS.has(ext)) return await checkSystemd(p, content);
    if (flavor === 'ssh' && (/^sshd_config$/.test(base) || /\/sshd_config\.d\//.test(p))) return await checkSshd(p, content);
    if (flavor === 'ssh') return await checkSshClient(p, content);
    if (base === 'sudoers' || /\/sudoers\.d\//.test(p)) return await checkSudoers(p, content);
    if (base === 'fstab') return await checkFstab(p, content);
    if (flavor === 'yaml' && /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) return await checkCompose(p, content);
    if (flavor === 'tags') return await checkApache(p, content);
  } catch (e) {
    return { ok: true, messages: [`L2 config validator error (not blocking): ${e.message}`] };
  }
  return { ok: true, messages: ['L2 (no service validator for this config type)'] };
}
