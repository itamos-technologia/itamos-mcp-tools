#!/usr/bin/env python3
"""Build the Itamos MCP Tools paper from one source.

Outputs
  docs/PAPER.md                 GitHub version (Mermaid diagrams)
  <site>/mcp-hosting.html       website version (inline SVG diagrams). The page
                                keeps the site's own header, navigation, styles
                                and footer; only its content, title and
                                description are replaced.

Usage
  python3 docs/build_paper.py [--site /tank/projects/itamos-site]

Edit the content below, then rerun. Set REPO_URL once the GitHub repo is public.
"""
import argparse
import html
import pathlib
import re

MCP_URL = 'https://mcp.itamos-technologia.com/mcp'
HEALTH_URL = 'https://mcp.itamos-technologia.com/health'
REPO_URL = None   # e.g. 'https://github.com/Itamos-technologia/itamos-mcp-tools'
CONTACT = 'info@itamos-technologia.com'

TITLE = 'Itamos MCP Tools'
SUBTITLE = ('Structured code perception for AI agents: how the tools work, '
            'why they are built this way, and how to try them in the free hosted sandbox.')
PAGE_TITLE = 'Itamos MCP Tools: free live alpha sandbox for AI agents | Itamos Technologia'
PAGE_KEYWORDS = ('MCP, Model Context Protocol, MCP server, MCP sandbox, AI agent tools, '
                 'AI coding tools, code navigation, Claude MCP, free MCP sandbox')
PAGE_DESC = ('Structured code tools for AI agents: a project map, a segment editor and safe, '
             'verified commits. How they work, why, and a free hosted sandbox to try them.')

# ── diagrams: vertical flows. nodes = (title, detail); back = (from, to, label) ──
DIAGRAMS = {
    'architect': {
        'caption': 'master_architect turns a project into a map the agent can query.',
        'nodes': [('scan', 'parse every file once'),
                  ('project graph (SQLite)', 'files, modules, imports, databases'),
                  ('topology', 'the map: files and how they connect'),
                  ('bones / connections / missing', 'zoom into one file or one link'),
                  ('read_file', 'open the exact segment')],
    },
    'read_file': {
        'caption': 'read_file: nothing reaches disk until it passes verification.',
        'nodes': [('skeleton', 'named segments, no code yet'),
                  ('read segment', 'displaying it unlocks it for editing'),
                  ('edit in a buffer', 'replace, insert, delete, move, paste'),
                  ('verify 1 → 2 → 3', 'syntax, compiler or service check, references'),
                  ('commit', 'atomic write; undo is possible until then')],
        'back': (3, 2, 'fails: fix, verify again'),
    },
    'web': {
        'caption': 'web_skeleton: read the part of a page you need, not the whole page.',
        'nodes': [('search', 'find relevant pages'),
                  ('skeleton', 'rendered page as sections with ids'),
                  ('read a section', 'only the text you need'),
                  ('click', 'follow a link or button by id')],
    },
    'loop': {
        'caption': 'The working loop: locate, read, change, verify, commit.',
        'nodes': [('scan', 'index the project once'),
                  ('topology', 'see files and how they connect'),
                  ('bones', 'one file: imports and functions'),
                  ('read a segment', 'only the part you need'),
                  ('edit', 'in a buffer, not on disk'),
                  ('verify', 'parse, compile, check references'),
                  ('commit', 'atomic write to disk')],
        'back': (5, 4, 'fails: fix, verify again'),
    },
    'sandbox': {
        'caption': 'The hosted sandbox: every request is tied to one private sandbox.',
        'nodes': [('your MCP client', 'Claude or any MCP client'),
                  ('TLS proxy', 'HTTPS, rate limits, real client address'),
                  ('sandbox server', 'checks the sign-in token'),
                  ('your sandbox', 'own storage, index and edit history'),
                  ('the five tools', 'confined to your sandbox')],
    },
    'lifecycle': {
        'caption': 'A sandbox lives while you use it.',
        'nodes': [('add the connector', 'paste the URL into your client'),
                  ('Create my sandbox', 'one click, no account'),
                  ('work', 'every tool call keeps it alive'),
                  ('10 minutes idle', 'files and sign-in are deleted'),
                  ('connect again', 'a fresh sandbox')],
    },
}

# ── content ─────────────────────────────────────────────────────────────────
# Blocks: ('h2', id, text) ('h3', text) ('p', text) ('ul', [items])
#         ('ol', [items]) ('diagram', key) ('note', text)
# Inline: **bold**, `code`, [text](url)
CONTENT = [
    ('p', 'AI coding agents fail less from a lack of intelligence than from a lack of '
          'perception. They cannot see a codebase the way an engineer does, as a structure, '
          'so they search, open whole files and edit text they have only half read. The '
          'Itamos MCP tools give an agent that structure: a map of the project, named parts '
          'of every file, and a safe way to change them. This paper describes the five tools, '
          'the reasoning behind their design, and the free hosted sandbox where you can try them.'),

    ('h2', 'problem', 'The problem'),
    ('p', 'Codebases outgrow context windows. A mid-sized project has thousands of files, and a '
          'single file can run to thousands of lines. The usual workaround is text search plus '
          'whole-file reads, and it has four costs:'),
    ('ul', ['**Tokens:** most of what the model reads has nothing to do with the task.',
            '**Blind edits:** the model changes code by matching text it has only partly seen.',
            '**Broken files:** an edit with a syntax error lands on disk, and the next step fails in confusing ways.',
            '**No map:** nothing tells the model how files connect, so cross-file bugs are found by luck.']),

    ('h2', 'principles', 'Design principles'),
    ('ul', ['**Structure before text.** The agent sees the map first, then zooms in.',
            '**Addresses, not line numbers.** Code is referred to by structural addresses that stay valid when other parts of the file change.',
            '**Read before write.** A tool will not change code the model has not displayed since the last change.',
            '**Verify before commit.** Edits stay in a buffer until they pass checks; only then do they reach disk.',
            '**One job per tool.** Small, predictable tools are easier for a model to use correctly than one tool that does everything.',
            '**The smallest useful answer.** Every response is the least text that answers the question, with a way to ask for more.']),

    ('h2', 'master-architect', 'master_architect: the project map'),
    ('p', 'master_architect scans a project and stores it as a graph in SQLite: every file, module, '
          'function and import, plus the databases, programs and servers the code refers to. Each '
          'item gets a hierarchical address such as `13.2.4`: file 13, module 2, method 4.'),
    ('diagram', 'architect'),
    ('p', 'An agent starts with `topology`, which returns the project\'s files and how they import '
          'each other. `bones` zooms into one file: its imports and its functions, with addresses. '
          '`connections` follows the links into and out of a file, and `missing` lists imports '
          'that point at nothing.'),
    ('h3', 'Why it is built this way'),
    ('ul', ['**SQLite** keeps the graph self-contained: no database server, and it handles graphs with hundreds of thousands of items.',
            '**Hierarchical addresses** are short enough to pass between tool calls and stay valid when lines move.',
            '**Import resolution follows real project layouts:** packages, plain sibling imports in script folders, and `src/` layouts. An import that resolves to a project file is internal. One that is rooted in a project package but resolves to nothing is reported as broken, instead of being mistaken for an external library.']),
    ('h3', 'Benefits'),
    ('ul', ['Orientation in one call instead of dozens of searches.',
            'Cross-file bugs can be traced from where the error appears to where the logic went wrong.',
            'Broken imports are found before anything runs.']),

    ('h2', 'read-file', 'read_file: the segment editor'),
    ('p', 'read_file parses a file with tree-sitter into named segments: functions, classes, '
          'configuration blocks. By default it returns the skeleton, the list of segments with '
          'their names and sizes, not the code. The agent then reads only the segment it needs. '
          'For very large files, `search` narrows the skeleton to the matching segments.'),
    ('diagram', 'read_file'),
    ('p', 'Edits happen in a buffer: replace, insert, delete, move, comment out, or paste from '
          'another file. A segment must have been read since the last change before it can be '
          'modified. Verification then runs at up to three levels:'),
    ('ul', ['**Level 1, syntax:** the buffer must parse.',
            '**Level 2, compiler or service check:** the language\'s own compiler or, for configuration files, the service\'s own checker, such as `nginx -t`, `systemd-analyze verify` or `sshd -t`.',
            '**Level 3, references:** imports and external references must resolve.']),
    ('p', 'Only a verified buffer can be committed. The commit is atomic, writes through symlinks '
          'to the real file and keeps its permissions. Until then, every change can be undone.'),
    ('h3', 'Why it is built this way'),
    ('ul', ['**Segments instead of lines:** a function named `authenticate_user` stays addressable when it moves from line 214 to line 389.',
            '**Read before write** stops the most common agent mistake: editing code it never looked at.',
            '**Verify before commit** turns a broken edit into a clear error message instead of a broken file.']),
    ('h3', 'Benefits'),
    ('ul', ['In typical use the agent reads about 120 lines instead of a whole 5,000-line file.',
            'Broken edits never reach disk.',
            'Structural edits, like moving a function, keep the file valid.']),

    ('h2', 'write-file', 'write_file: creating files'),
    ('p', 'write_file creates new files and adds them to the project map. It refuses to overwrite '
          'an existing file: changes to existing files go through read_file, with its '
          'read-before-write and verification rules.'),
    ('p', '**Why:** silent overwrites are one of the most common ways agents destroy work. Making '
          'creating and editing two separate tools removes that ambiguity entirely.'),

    ('h2', 'git', 'git: getting code in'),
    ('p', 'The sandboxed git tool offers three operations: `clone` (remote URLs only, shallow), '
          '`status` and `commit`. Everything stays inside your sandbox. `push` is deliberately '
          'not available.'),
    ('p', '**Why:** a shallow clone turns minutes into seconds for large repositories, and most '
          'tasks need no history. Refusing local paths and push means the sandbox can neither '
          'read the host machine nor publish anywhere.'),

    ('h2', 'web-skeleton', 'web_skeleton: reading the web'),
    ('p', 'web_skeleton renders a page in headless Chromium, so content built by JavaScript is '
          'included, then reduces it to a skeleton: headings, sections, links and form elements, '
          'each with a stable id. The agent reads only the section it needs, or clicks an '
          'element by its id.'),
    ('diagram', 'web'),
    ('p', '**Why:** raw HTML is mostly layout, scripts and tracking. In typical use, a page that '
          'would cost 50,000 to 200,000 tokens as raw HTML becomes a skeleton of 500 to 3,000 '
          'tokens. In the public sandbox it only reaches public internet addresses, never '
          'private networks.'),

    ('h2', 'together', 'How the tools work together'),
    ('diagram', 'loop'),
    ('p', 'A typical bug fix: the agent scans the repository, uses `topology` and `bones` to find '
          'the function named in the error, reads that one segment, replaces it, verifies and '
          'commits. If verification fails, it gets the exact error and tries again; the broken '
          'version never touches disk. When the cause sits in a different file from where the '
          'error appears, `connections` leads from the symptom to the cause.'),

    ('h2', 'sandbox', 'The hosted sandbox'),
    ('diagram', 'sandbox'),
    ('p', 'The public sandbox runs the same five tools with firm limits around them:'),
    ('ul', ['**Anonymous sign-in.** Hosted MCP clients such as claude.ai call from shared, rotating server addresses, so an IP address cannot tell users apart. Instead, each user gets a private sandbox through a standard OAuth flow whose sign-in page has a single button: no account and no email.',
            '**Isolation.** Each sandbox has its own storage volume (2 GB), its own project index and its own edit history. Every path is confined to the sandbox.',
            '**One per network.** During the alpha there is one sandbox per internet connection. If a connection drops, reconnecting from the same browser resumes the same sandbox, files included.',
            '**Ten minutes.** After 10 minutes without activity, the sandbox, its files and its sign-in are deleted. The next connection starts fresh.',
            '**500 at a time.** Up to 500 sandboxes run in parallel. When all are in use, new connections get "Try again later: we are currently at full capacity."']),
    ('diagram', 'lifecycle'),
    ('note', '**This is a demonstration service.** Don\'t put anything sensitive or confidential '
             'in the sandbox. It is built for trying the tools, not for private data.'),

    ('h2', 'evidence', 'Evidence so far'),
    ('ul', ['In live use with Claude models (Opus and Sonnet), agents use the tools to navigate and change real codebases end to end.',
            'Locally run open models of 27 to 31 billion parameters showed the other side: they found the right file and function in an unfamiliar codebase, but did not complete the fix without guidance. Good tools help; model capability still matters.',
            'Benchmarks on real, open GitHub issues are in progress and will be published with full transcripts, time and token counts.']),

    ('h2', 'limits', 'Limitations and roadmap'),
    ('ul', ['**Alpha:** behavior and limits may change.',
            '**Temporary by design:** sandboxes are deleted after 10 minutes of inactivity.',
            '**No push:** results stay inside the sandbox.',
            '**Planned:** a waiting queue when all spots are taken, anonymous usage statistics, and the published benchmark set.']),

    ('h2', 'license', 'License and contact'),
    ('p', 'Free for personal use and open-source projects. Commercial use requires a licence: '
          f'contact [{CONTACT}](mailto:{CONTACT}). Built by Itamos Technologia, a one-person '
          'company in Pili, Trikala, Greece.'),
]

TRY_INTRO = ('You have read how it works. Add this URL as a custom connector in your MCP client:')
TRY_STEPS = ['Add the URL as a connector in your MCP client.',
             'A page opens: choose **Create my sandbox**. No account needed.',
             'Ask your agent to clone a repository and explore it with the tools.']


# ── inline formatting ───────────────────────────────────────────────────────
def inline_html(text):
    t = html.escape(text, quote=False)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: f'<a href="{html.escape(m.group(2))}">{m.group(1)}</a>', t)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    return t


# ── SVG diagrams for the website ────────────────────────────────────────────
def svg_diagram(key):
    d = DIAGRAMS[key]
    nodes, back = d['nodes'], d.get('back')
    W, BX, BW, BH, GAP, TOP = 400, 16, 290, 56, 30, 10
    H = TOP + len(nodes) * BH + (len(nodes) - 1) * GAP + 10
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(d["caption"])}" class="dg">',
           '<defs><marker id="ah-%s" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
           '<path d="M0,0 L10,5 L0,10 z" class="dg-head"/></marker>'
           '<marker id="ab-%s" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
           '<path d="M0,0 L10,5 L0,10 z" class="dg-head-back"/></marker></defs>' % (key, key)]
    ys = [TOP + i * (BH + GAP) for i in range(len(nodes))]
    for i, (title, detail) in enumerate(nodes):
        y = ys[i]
        out.append(f'<rect x="{BX}" y="{y}" width="{BW}" height="{BH}" rx="10" class="dg-box"/>')
        out.append(f'<text x="{BX + BW / 2}" y="{y + 23}" class="dg-title" text-anchor="middle">{html.escape(title)}</text>')
        out.append(f'<text x="{BX + BW / 2}" y="{y + 42}" class="dg-sub" text-anchor="middle">{html.escape(detail)}</text>')
        if i < len(nodes) - 1:
            out.append(f'<line x1="{BX + BW / 2}" y1="{y + BH}" x2="{BX + BW / 2}" y2="{y + BH + GAP - 2}" class="dg-arrow" marker-end="url(#ah-{key})"/>')
    if back:
        a, b, label = back
        xa, ya, yb = BX + BW, ys[a] + BH / 2, ys[b] + BH / 2
        xr = xa + 22
        out.append(f'<path d="M{xa},{ya} H{xr} V{yb} H{xa + 4}" class="dg-back" marker-end="url(#ab-{key})"/>')
        first, _, rest = label.partition(': ')
        ym = (ya + yb) / 2
        out.append(f'<text x="{xr + 6}" y="{ym - 4}" class="dg-back-label">{html.escape(first)}</text>')
        if rest:
            out.append(f'<text x="{xr + 6}" y="{ym + 11}" class="dg-back-label">{html.escape(rest)}</text>')
    out.append('</svg>')
    return (f'<figure class="dg-fig">{"".join(out)}'
            f'<figcaption>{html.escape(d["caption"])}</figcaption></figure>')


def mermaid_diagram(key):
    d = DIAGRAMS[key]
    lines = ['```mermaid', 'flowchart TD']
    for i, (title, detail) in enumerate(d['nodes']):
        lines.append(f'  n{i}["<b>{title}</b><br/>{detail}"]')
    for i in range(len(d['nodes']) - 1):
        lines.append(f'  n{i} --> n{i + 1}')
    if d.get('back'):
        a, b, label = d['back']
        lines.append(f'  n{a} -.->|{label}| n{b}')
    lines.append('```')
    lines.append(f'*{d["caption"]}*')
    return '\n'.join(lines)


# ── Markdown ────────────────────────────────────────────────────────────────
def build_markdown():
    md = [f'# {TITLE}', '', f'*{SUBTITLE}*', '',
          f'**Live alpha, free:** connect any MCP client to `{MCP_URL}` (details at the end).', '',
          '## Contents', '']
    md += [f'- [{b[2]}](#{b[1]})' for b in CONTENT if b[0] == 'h2'] + ['- [Try it](#try-it)', '']
    for b in CONTENT:
        kind = b[0]
        if kind == 'h2':
            md += [f'<a id="{b[1]}"></a>', f'## {b[2]}', '']
        elif kind == 'h3':
            md += [f'### {b[1]}', '']
        elif kind == 'p':
            md += [b[1], '']
        elif kind == 'ul':
            md += [f'- {x}' for x in b[1]] + ['']
        elif kind == 'ol':
            md += [f'{i}. {x}' for i, x in enumerate(b[1], 1)] + ['']
        elif kind == 'diagram':
            md += [mermaid_diagram(b[1]), '']
        elif kind == 'note':
            md += [f'> {b[1]}', '']
    md += ['<a id="try-it"></a>', '## Try it', '', TRY_INTRO, '', f'```\n{MCP_URL}\n```', '']
    md += [f'{i}. {x}' for i, x in enumerate(TRY_STEPS, 1)] + ['']
    if REPO_URL:
        md += [f'Source code: [{REPO_URL}]({REPO_URL})', '']
    md += ['---', '', '*This file is generated by `docs/build_paper.py`; edit the content there.*', '']
    return '\n'.join(md)


# ── website page ────────────────────────────────────────────────────────────
PAGE_CSS = """
/* ── paper (generated by itamos-mcp-tools docs/build_paper.py) ── */
.paper { max-width: 820px; margin: 0 auto; padding: 120px 22px 40px; }
.paper .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--success); }
.paper .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.paper h1 { font-family: var(--font-display); font-weight: 400; font-size: clamp(2.2rem, 6vw, 3.2rem); line-height: 1.1; margin: 10px 0 12px; }
.paper .lead { color: var(--text-muted); font-size: 1.08rem; margin-bottom: 26px; }
.paper h2 { font-family: var(--font-display); font-weight: 400; font-size: 1.8rem; margin: 46px 0 12px; scroll-margin-top: 90px; }
.paper h3 { font-size: 1.02rem; font-weight: 700; margin: 22px 0 8px; }
.paper p, .paper li { color: #cbd5e1; }
.paper p { margin: 0 0 14px; }
.paper ul, .paper ol { margin: 0 0 16px; padding-left: 22px; }
.paper li { margin-bottom: 8px; }
.paper strong { color: var(--text-primary); }
.paper a { color: var(--accent); }
.paper code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; background: rgba(56,189,248,0.08); border: 1px solid rgba(56,189,248,0.18); border-radius: 5px; padding: 1px 5px; color: #e2e8f0; }
.paper .toc { background: var(--bg-card, rgba(12,20,38,0.88)); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 10px; }
.paper .toc ol { margin: 6px 0 0; }
.paper .toc li { margin-bottom: 4px; }
.paper .note { border-left: 3px solid #f59e0b; background: rgba(245,158,11,0.08); border-radius: 8px; padding: 12px 16px; margin: 18px 0; }
.paper .note p { margin: 0; }
.dg-fig { margin: 22px auto; max-width: 440px; }
.dg { width: 100%; height: auto; display: block; }
.dg-box { fill: rgba(56,189,248,0.07); stroke: rgba(56,189,248,0.45); stroke-width: 1.2; }
.dg-title { fill: var(--text-primary); font: 600 15px var(--font-body); }
.dg-sub { fill: var(--text-muted); font: 12px var(--font-body); }
.dg-arrow { stroke: var(--accent); stroke-width: 1.6; }
.dg-head { fill: var(--accent); }
.dg-back { fill: none; stroke: #f59e0b; stroke-width: 1.4; stroke-dasharray: 5 4; }
.dg-head-back { fill: #f59e0b; }
.dg-back-label { fill: #f59e0b; font: 11px var(--font-body); }
.dg-fig figcaption { text-align: center; color: var(--text-muted); font-size: 0.85rem; margin-top: 6px; }
.try { margin-top: 50px; border: 1px solid rgba(56,189,248,0.35); background: rgba(56,189,248,0.06); border-radius: 14px; padding: 22px; }
.try h2 { margin-top: 0; }
.try .url-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: stretch; margin: 10px 0 16px; }
.try .url-row code { flex: 1 1 260px; display: block; font-size: 0.95rem; padding: 10px 12px; word-break: break-all; }
.try button { border: 0; border-radius: 10px; padding: 10px 16px; font-weight: 700; background: var(--accent); color: #04121f; cursor: pointer; }
.try .slots { color: var(--text-muted); font-size: 0.85rem; }
.try .slots b { color: var(--accent); }
"""

PAGE_JS = """
<script>
// Copy button for the connector URL, and the live spot counter from the sandbox.
(function(){
  var btn = document.getElementById('copy-url');
  var url = document.getElementById('mcp-url');
  if (btn && url) btn.addEventListener('click', function(){
    var t = url.textContent.trim();
    function done(){ btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = 'Copy'; }, 1600); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function(){});
    else { var r = document.createRange(); r.selectNodeContents(url); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  var box = document.getElementById('slots');
  function refresh(){
    fetch('%s', { cache: 'no-store' })
      .then(function(r){ if (!r.ok) throw 0; return r.json(); })
      .then(function(d){ if (!d || !d.slots) throw 0;
        document.getElementById('slots-used').textContent = d.slots.used;
        document.getElementById('slots-total').textContent = d.slots.total;
        box.hidden = false; })
      .catch(function(){ if (box) box.hidden = true; });
  }
  if (box) { refresh(); setInterval(refresh, 30000); }
})();
</script>
""" % HEALTH_URL


def build_html_body():
    h = ['<!-- PAPER:START (generated by itamos-mcp-tools docs/build_paper.py; edit there, not here) -->',
         '<main class="paper">',
         '<div class="badge">Live alpha · free</div>',
         f'<h1>{html.escape(TITLE)}</h1>',
         f'<p class="lead">{inline_html(SUBTITLE)}</p>',
         '<nav class="toc" aria-label="Contents"><strong>Contents</strong><ol>']
    h += [f'<li><a href="#{b[1]}">{html.escape(b[2])}</a></li>' for b in CONTENT if b[0] == 'h2']
    h += ['<li><a href="#try-it">Try it</a></li></ol></nav>']
    for b in CONTENT:
        kind = b[0]
        if kind == 'h2':
            h.append(f'<h2 id="{b[1]}">{html.escape(b[2])}</h2>')
        elif kind == 'h3':
            h.append(f'<h3>{html.escape(b[1])}</h3>')
        elif kind == 'p':
            h.append(f'<p>{inline_html(b[1])}</p>')
        elif kind in ('ul', 'ol'):
            h.append(f'<{kind}>' + ''.join(f'<li>{inline_html(x)}</li>' for x in b[1]) + f'</{kind}>')
        elif kind == 'diagram':
            h.append(svg_diagram(b[1]))
        elif kind == 'note':
            h.append(f'<div class="note"><p>{inline_html(b[1])}</p></div>')
    h += ['<section class="try" id="try-it">',
          '<h2>Try it</h2>',
          f'<p>{inline_html(TRY_INTRO)}</p>',
          f'<div class="url-row"><code id="mcp-url">{html.escape(MCP_URL)}</code>'
          '<button type="button" id="copy-url">Copy</button></div>',
          '<ol>' + ''.join(f'<li>{inline_html(x)}</li>' for x in TRY_STEPS) + '</ol>',
          '<p class="slots" id="slots" hidden><b id="slots-used">—</b>/<span id="slots-total">500</span> spots in use right now.</p>']
    if REPO_URL:
        h.append(f'<p>Source code: <a href="{html.escape(REPO_URL)}">{html.escape(REPO_URL)}</a></p>')
    h += ['</section>', '</main>', PAGE_JS, '<!-- PAPER:END -->', '']
    return '\n'.join(h)


def build_site_page(site_dir):
    page = pathlib.Path(site_dir) / 'mcp-hosting.html'
    src = page.read_text()
    body = build_html_body()
    if '<!-- PAPER:START' in src:
        start = src.index('<!-- PAPER:START')
        end = src.index('<!-- PAPER:END -->') + len('<!-- PAPER:END -->') + 1
    else:
        # First build: replace everything between the navigation and the footer.
        start = src.index('</nav>', src.index('<nav class="navbar"')) + len('</nav>') + 1
        end = src.index('<footer class="footer">')
    src = src[:start] + '\n' + body + '\n' + src[end:]
    src = re.sub(r'<title>.*?</title>', f'<title>{html.escape(PAGE_TITLE)}</title>', src, count=1, flags=re.S)
    src = re.sub(r'<meta name="description" content="[^"]*"',
                 f'<meta name="description" content="{html.escape(PAGE_DESC)}"', src, count=1)
    src = re.sub(r'<meta name="keywords" content="[^"]*"',
                 f'<meta name="keywords" content="{html.escape(PAGE_KEYWORDS)}"', src, count=1)
    # Social previews (WhatsApp, LinkedIn, Facebook) use the og: tags.
    src = re.sub(r'<meta property="og:title" content="[^"]*"',
                 f'<meta property="og:title" content="{html.escape(PAGE_TITLE)}"', src, count=1)
    src = re.sub(r'<meta property="og:description" content="[^"]*"',
                 f'<meta property="og:description" content="{html.escape(PAGE_DESC)}"', src, count=1)
    src = re.sub(r'<meta property="og:type" content="[^"]*"', '<meta property="og:type" content="article"', src, count=1)
    marker = '/* ── paper (generated by itamos-mcp-tools'
    if marker in src:
        cs = src.index(marker)
        src = src[:cs] + PAGE_CSS.lstrip('\n') + src[src.index('</style>', cs):]
    else:
        k = src.index('</style>')
        src = src[:k] + PAGE_CSS + src[k:]
    page.write_text(src)
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', help='website directory containing mcp-hosting.html')
    args = ap.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    (here / 'PAPER.md').write_text(build_markdown())
    print('wrote', here / 'PAPER.md')
    if args.site:
        print('wrote', build_site_page(args.site))


if __name__ == '__main__':
    main()
