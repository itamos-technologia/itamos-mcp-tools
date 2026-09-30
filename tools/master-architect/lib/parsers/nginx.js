/**
 * nginx config parser adapter for master-architect.
 *
 * Standalone, hand-written (no tree-sitter grammar required). nginx config is a
 * simple grammar: directives terminated by ';' and blocks delimited by '{' '}'.
 * We tokenize on that structure and extract the things that matter for a
 * code-flow / architecture view:
 *
 *   modules : each `server { }` and `upstream { }` block becomes a module, named
 *             by its server_name / listen (for server) or its label (for
 *             upstream). This is what the skeleton shows as the file's contents.
 *   imports : `include <path>;` directives, with the path — these resolve to
 *             real config files (e.g. sites-enabled/*), giving real file->file
 *             edges between split-out configs.
 *   externals (returned in `external_refs`): the network endpoints — every
 *             `listen <port>` (this server ACCEPTS here) and every
 *             `proxy_pass <url>` / upstream `server <host:port>` (this config
 *             FORWARDS there). These are what link the proxy to the internet
 *             above and to the code endpoints below. Emitted as
 *             { kind:'server'|'port', name, locator, line, extra:{role} } where
 *             role = 'listen' (inbound) or 'upstream' (outbound) so the graph
 *             can draw direction.
 *
 * databases / sql_queries / dynamic_loads: always empty for nginx.
 *
 * NOTE: the architect's external_detect already catches http://host:port
 * patterns generically; this parser additionally provides the STRUCTURE
 * (which server block listens where, which location proxies where, and the
 * listen<->upstream roles) that generic text detection cannot.
 */

// ── tokenizer ────────────────────────────────────────────────────────────────
// Produces a flat token stream of: '{', '}', ';', and bare words (directive
// names + arguments). Comments (# ... EOL) and string quotes are handled.
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const pushWord = (w, ln) => { if (w.length) toks.push({ t: 'word', v: w, line: ln }); };
  let cur = '';
  let curLine = 1;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { pushWord(cur, curLine); cur = ''; line++; i++; curLine = line; continue; }
    if (c === '#') { // comment to EOL
      pushWord(cur, curLine); cur = '';
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '{' || c === '}' || c === ';') {
      pushWord(cur, curLine); cur = '';
      toks.push({ t: c, line });
      i++; continue;
    }
    if (c === '"' || c === "'") { // quoted string — keep contents as one word
      pushWord(cur, curLine); cur = '';
      const q = c; const startLine = line; i++;
      let s = '';
      while (i < n && src[i] !== q) {
        if (src[i] === '\n') line++;
        if (src[i] === '\\' && i + 1 < n) { s += src[i + 1]; i += 2; continue; }
        s += src[i]; i++;
      }
      i++; // closing quote
      toks.push({ t: 'word', v: s, line: startLine });
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(cur, curLine); cur = ''; i++; continue; }
    if (cur === '') curLine = line;
    cur += c; i++;
  }
  pushWord(cur, curLine);
  return toks;
}

// ── parser ───────────────────────────────────────────────────────────────────
// Walks the token stream into a tree of directives. A directive is
// { name, args:[...], line, block:[...]|null }.
function parseDirectives(toks) {
  let pos = 0;
  function parseBlock() {
    const out = [];
    while (pos < toks.length) {
      const tk = toks[pos];
      if (tk.t === '}') { pos++; break; }
      if (tk.t === ';') { pos++; continue; } // stray
      if (tk.t === 'word') {
        const name = tk.v;
        const line = tk.line;
        const args = [];
        pos++;
        while (pos < toks.length && toks[pos].t === 'word') { args.push(toks[pos].v); pos++; }
        if (pos < toks.length && toks[pos].t === '{') {
          pos++;
          const block = parseBlock();
          out.push({ name, args, line, block });
        } else {
          if (pos < toks.length && toks[pos].t === ';') pos++;
          out.push({ name, args, line, block: null });
        }
      } else {
        pos++; // stray { etc.
      }
    }
    return out;
  }
  return parseBlock();
}

// Normalize a proxy_pass / upstream target into a host:port locator when
// possible. Returns { locator, host, port, protocol } or null.
function targetToLocator(raw) {
  if (!raw) return null;
  let s = raw.trim();
  let protocol = null;
  const pm = s.match(/^(https?):\/\//);
  if (pm) { protocol = pm[1]; s = s.slice(pm[0].length); }
  // strip any path/query
  s = s.split('/')[0];
  if (!s) return null;
  const hp = s.match(/^([A-Za-z0-9_.\-]+):(\d+)$/);
  if (hp) return { locator: `${hp[1]}:${hp[2]}`, host: hp[1], port: Number(hp[2]), protocol };
  // bare host or upstream-name (no port) — keep as name locator
  if (/^[A-Za-z0-9_.\-]+$/.test(s)) return { locator: s, host: s, port: null, protocol };
  return null;
}

// Walk the directive tree, collecting modules / imports / external refs.
function collect(tree, analysis) {
  function walk(dirs, ctx) {
    for (const d of dirs) {
      // include -> import edge (path may be glob; keep raw)
      if (d.name === 'include' && d.args.length) {
        analysis.imports.push({ import_path: d.args[0], line: d.line });
      }
      // listen -> inbound endpoint
      if (d.name === 'listen' && d.args.length) {
        // listen forms: "443 ssl", "127.0.0.1:8080", "[::]:80", "[::1]:443",
        // "*:80", "80", "unix:/path" (ignored). Parse host + port robustly,
        // including IPv6 bracket notation where the host itself contains colons.
        let a = d.args[0];
        let host = null, port = null;
        const v6 = a.match(/^\[([0-9A-Fa-f:]+)\]:(\d+)$/);   // [::]:443 , [::1]:80
        const hp = a.match(/^([A-Za-z0-9_.\-*]+):(\d+)$/);    // host:port , *:port
        if (v6) { host = `[${v6[1]}]`; port = Number(v6[2]); }
        else if (hp) { host = hp[1] === '*' ? '0.0.0.0' : hp[1]; port = Number(hp[2]); }
        else if (/^\d+$/.test(a)) { port = Number(a); }
        const ssl = d.args.includes('ssl') || a.includes('ssl');
        const nhost = host || '0.0.0.0';
        const locator = port != null ? `${nhost}:${port}` : a;
        analysis.external_refs.push({
          kind: port != null ? 'server' : 'port',
          name: locator,
          locator,
          line: d.line,
          extra: { role: 'listen', ssl, host: nhost, port },
        });
      }
      // proxy_pass / fastcgi_pass / grpc_pass -> outbound endpoint
      if ((d.name === 'proxy_pass' || d.name === 'fastcgi_pass' || d.name === 'grpc_pass' || d.name === 'uwsgi_pass') && d.args.length) {
        const tl = targetToLocator(d.args[0]);
        if (tl) {
          analysis.external_refs.push({
            kind: 'server',
            name: tl.locator,
            locator: tl.locator,
            line: d.line,
            extra: { role: 'upstream', via: d.name, protocol: tl.protocol || null, host: tl.host, port: tl.port },
          });
        }
      }
      // upstream block -> module + its member `server host:port;` entries outbound
      if (d.name === 'upstream' && d.block) {
        const label = d.args[0] || '(upstream)';
        analysis.modules.push({ kind: 'upstream', name: `upstream ${label}`, line: d.line, line_end: d.line });
        for (const s of d.block) {
          if (s.name === 'server' && s.args.length) {
            const tl = targetToLocator(s.args[0]);
            if (tl) {
              analysis.external_refs.push({
                kind: 'server', name: tl.locator, locator: tl.locator, line: s.line,
                extra: { role: 'upstream', via: 'upstream', upstream: label, host: tl.host, port: tl.port },
              });
            }
          }
        }
      }
      // server block -> module, named by server_name or first listen
      if (d.name === 'server' && d.block) {
        let sname = null, slisten = null;
        for (const s of d.block) {
          if (s.name === 'server_name' && s.args.length && !sname) sname = s.args.join(' ');
          if (s.name === 'listen' && s.args.length && !slisten) slisten = s.args[0];
        }
        const label = sname || (slisten ? `:${slisten}` : '(server)');
        analysis.modules.push({ kind: 'server', name: `server ${label}`, line: d.line, line_end: d.line });
      }
      if (d.block) walk(d.block, ctx);
    }
  }
  walk(tree, {});
}

function parseFile(content) {
  const analysis = {
    modules: [], imports: [], databases: [], sql_queries: [],
    dynamic_loads: [], lmdb_subdbs: [], external_refs: [],
  };
  try {
    const toks = tokenize(content);
    const tree = parseDirectives(toks);
    collect(tree, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

// resolveImport: nginx `include` paths. Absolute -> as-is; relative -> resolve
// against the config file's directory (and the conventional /etc/nginx base).
// Globs (sites-enabled/*) are returned unresolved (null) — the scan keeps them
// as unresolved includes rather than guessing which files match.
function resolveImport(importPath, fromAbsFile, fs, path, projectRoot) {
  if (!importPath) return null;
  if (importPath.includes('*')) return null; // glob — not statically one file
  let p = importPath;
  if (!path.isAbsolute(p)) {
    p = path.resolve(path.dirname(fromAbsFile), importPath);
  }
  try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  return null;
}

export default { parseFile, resolveImport };
