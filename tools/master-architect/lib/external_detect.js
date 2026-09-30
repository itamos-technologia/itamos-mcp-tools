// External-dependency detector (stage 1 of the architect graph expansion).
//
// Scans raw file content for the "need-to-know to run/debug" external refs that
// aren't code-to-code imports: runtime servers/endpoints, model files, system
// services, external binaries, ports. Pure pattern detection — zero deps, runs
// at scan time while file content is still in memory. Returns a deduped list of
// { kind, name, locator, line, extra } where:
//   kind    = server | model | binary | service | port
//   locator = the IDENTITY (host:port | abs model path | binary | unit name)
//
// Conservative by design: only emit a ref when the pattern is unambiguous, so
// the architect stores signal, not noise. Misses are fine (manifest fills gaps);
// false positives are not (they'd pollute the shared graph).

import { execFile } from 'child_process';
import { promisify } from 'util';
const _execFile = promisify(execFile);

const MODEL_EXTS = ['.gguf', '.bin', '.safetensors', '.onnx', '.pt', '.pth', '.ggml'];

// host:port — http(s)://host:port  OR  bare 127.0.0.1:8091 / localhost:PORT
const RE_URL_HOSTPORT = /https?:\/\/([a-zA-Z0-9._-]+):(\d{2,5})\b/g;
const RE_BARE_HOSTPORT = /\b((?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)):(\d{2,5})\b/g;
// model file paths: any quoted/space-delimited token ending in a model ext
const RE_MODELPATH = /["'`\s(]((?:\/|\.\.?\/)[^"'`\s)]+?(?:\.gguf|\.safetensors|\.onnx|\.ggml|\.pt|\.pth))\b/g;
// systemd units: a *.service token, or systemctl <verb> <name>
const RE_SERVICE_UNIT = /\b([a-zA-Z0-9_.@-]+\.service)\b/g;
const RE_SYSTEMCTL = /systemctl\s+(?:start|stop|restart|enable|disable|status|is-active)\s+([a-zA-Z0-9_.@-]+)/g;
// known external binaries invoked (spawn/exec/execSync/string). Conservative whitelist.
const KNOWN_BINARIES = ['llama-server', 'llama-cli', 'llama.cpp', 'ollama', 'ffmpeg', 'sqlite3', 'pg_dump', 'redis-server', 'mongod', 'python3', 'node'];
const RE_BINARY = new RegExp('\\b(' + KNOWN_BINARIES.map(b => b.replace(/[.+]/g, '\\$&')).join('|') + ')\\b', 'g');

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

export function detectExternalRefs(content, language) {
  if (!content || typeof content !== 'string') return [];
  const out = [];
  const seen = new Set(); // local dedupe by kind|locator within this file

  const push = (kind, name, locator, line, extra) => {
    if (!locator) return;
    const key = kind + '|' + locator;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name, locator, line, extra: extra ? JSON.stringify(extra) : null });
  };

  let m;
  // servers (http host:port)
  RE_URL_HOSTPORT.lastIndex = 0;
  while ((m = RE_URL_HOSTPORT.exec(content)) !== null) {
    const locator = `${m[1]}:${m[2]}`;
    push('server', locator, locator, lineOf(content, m.index), { protocol: 'http', host: m[1], port: Number(m[2]) });
  }
  // servers (bare host:port) — only if not already captured as http
  RE_BARE_HOSTPORT.lastIndex = 0;
  while ((m = RE_BARE_HOSTPORT.exec(content)) !== null) {
    const locator = `${m[1]}:${m[2]}`;
    push('server', locator, locator, lineOf(content, m.index), { host: m[1], port: Number(m[2]) });
  }
  // models
  RE_MODELPATH.lastIndex = 0;
  while ((m = RE_MODELPATH.exec(content)) !== null) {
    const p = m[1];
    const name = p.split('/').pop();
    const ext = MODEL_EXTS.find(e => p.endsWith(e));
    push('model', name, p, lineOf(content, m.index), { format: ext ? ext.slice(1) : null });
  }
  // services (.service tokens)
  RE_SERVICE_UNIT.lastIndex = 0;
  while ((m = RE_SERVICE_UNIT.exec(content)) !== null) {
    push('service', m[1], m[1], lineOf(content, m.index), null);
  }
  // services (systemctl <verb> <name>) — normalize to <name>.service
  RE_SYSTEMCTL.lastIndex = 0;
  while ((m = RE_SYSTEMCTL.exec(content)) !== null) {
    const unit = m[1].endsWith('.service') ? m[1] : m[1] + '.service';
    push('service', unit, unit, lineOf(content, m.index), null);
  }
  // binaries (known whitelist)
  RE_BINARY.lastIndex = 0;
  while ((m = RE_BINARY.exec(content)) !== null) {
    push('binary', m[1], m[1], lineOf(content, m.index), null);
  }

  return out;
}


// Run a command with a hard timeout; return trimmed stdout or null. Never throws.
async function _safeCmd(bin, args, timeoutMs = 2000) {
  try {
    const { stdout } = await _execFile(bin, args, { timeout: timeoutMs, windowsHide: true });
    return (stdout || '').trim() || null;
  } catch (e) {
    // some tools print version to stderr (and exit non-zero) — salvage it
    if (e && e.stdout && String(e.stdout).trim()) return String(e.stdout).trim();
    if (e && e.stderr && String(e.stderr).trim()) return String(e.stderr).trim();
    return null;
  }
}

// Enrich detected refs with gatherable inventory facts. INVENTORY, not health:
//   binary -> resolved path (which) + version (--version). The path is the key
//            signal (catches '3 different ollama installs at different paths').
//   server -> left as-is (locator host:port already IS the fact).
//   model/service -> left as-is for stage 1.
// Returns a NEW array of { kind, name, locator, line, version, resolvedPath, extra }.
// Fail-safe: anything ungatherable stays null; never throws.
export async function gatherSpecs(refs) {
  if (!Array.isArray(refs) || !refs.length) return [];
  // cache per-binary so we run which/--version once even if referenced N times
  const binCache = new Map();
  const out = [];
  for (const r of refs) {
    const enriched = { ...r, version: r.version ?? null, resolvedPath: null };
    if (r.kind === 'binary') {
      const key = r.locator;
      if (!binCache.has(key)) {
        const which = await _safeCmd('which', [r.locator], 1500);
        // first line of --version output is almost always the identifying string
        const ver = await _safeCmd(r.locator, ['--version'], 2000);
        const verLine = ver ? ver.split('\n')[0].slice(0, 200) : null;
        binCache.set(key, { resolvedPath: which, version: verLine });
      }
      const c = binCache.get(key);
      enriched.resolvedPath = c.resolvedPath;
      enriched.version = c.version;
    }
    out.push(enriched);
  }
  return out;
}
