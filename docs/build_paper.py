#!/usr/bin/env python3
"""Build the Itamos MCP Tools pages from one source.

Outputs
  docs/PAPER.md                       GitHub version (all pages in one file, Mermaid diagrams)
  <site>/mcp-hosting.html             website hub: big picture + clickable server diagram
  <site>/mcp-server.html, mcp-sandbox.html, mcp-tool-*.html
                                      one detail page per part of the diagram

Every website page keeps the site's own header, navigation, styles and footer
(taken from mcp-hosting.html); only the content, title and description change.

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
ISSUES_URL = 'https://github.com/Itamos-technologia/itamos-mcp-tools/issues'
DISCUSSIONS_URL = 'https://github.com/Itamos-technologia/itamos-mcp-tools/discussions'
LINKEDIN_URL = 'https://www.linkedin.com/in/konstantinos-karamperis-a645b654'

PAGE_KEYWORDS = ('MCP, Model Context Protocol, MCP server, MCP sandbox, AI agent tools, '
                 'AI coding tools, code navigation, Claude MCP, free MCP sandbox')

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
    'write_file': {
        'caption': 'write_file: new files only, filed into the project map.',
        'nodes': [('path', 'where the new file goes'),
                  ('jail check', 'must stay inside your sandbox'),
                  ('exists?', 'refused: edit it with read_file'),
                  ('write', 'missing folders are created'),
                  ('file into the map', 'master_architect knows it at once')],
    },
    'git': {
        'caption': 'git: code comes in, nothing goes out.',
        'nodes': [('clone', 'remote URL, shallow, symlinks off'),
                  ('work', 'with the other tools'),
                  ('status', 'what changed'),
                  ('commit', 'saved in your sandbox, no push')],
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
    'request': {
        'caption': 'One tool call, from your client to your sandbox.',
        'nodes': [('your MCP client', 'Claude or any MCP client'),
                  ('TLS proxy', 'HTTPS and the real client address'),
                  ('token check', 'anonymous sign-in, no account'),
                  ('slot pool', 'your sandbox, or a place in the queue'),
                  ('path jail', 'every path checked'),
                  ('the tool runs', 'inside your sandbox only')],
    },
    'lifecycle': {
        'caption': 'A sandbox lives while you use it.',
        'nodes': [('add the connector', 'paste the URL into your client'),
                  ('Create my sandbox', 'one click, no account'),
                  ('work', 'every tool call keeps it alive'),
                  ('10 minutes idle', 'files deleted, login kept'),
                  ('next tool call', 'a fresh, empty sandbox')],
    },
}

# ── component diagrams: root + what it needs. items = (name, role, external?) ──
DEPS = {
    'server': {
        'caption': 'Sandbox server components. Dashed: third-party software.',
        'root': ('server-sandbox.js', 'the sandbox server'),
        'items': [('oauth.js', 'anonymous OAuth 2.1 sign-in', False),
                  ('slot pool', '500 pre-made ZFS sandboxes', False),
                  ('waiting queue', 'arrival order, live position', False),
                  ('notify_email.py', 'optional "ready" email', False),
                  ('path jail', 'confines every path', False),
                  ('watchdog', 'wipes idle sandboxes', False),
                  ('MCP SDK', 'streamable HTTP transport', True),
                  ('Express', 'HTTP server', True)],
    },
    'sandbox': {
        'caption': 'What a sandbox holds. Dashed: provided by the host.',
        'root': ('your sandbox', 'one private slot'),
        'items': [('your files', 'cloned repos and new files', False),
                  ('.architect.db', 'your project map', False),
                  ('.read_file_state', 'edit buffers and undo history', False),
                  ('ZFS dataset', '2 GB storage quota', True),
                  ('path jail', 'nothing outside is reachable', False)],
    },
    'master_architect': {
        'caption': 'master_architect components. Dashed: third-party software.',
        'root': ('master_architect', 'project map tool'),
        'items': [('scan.js', 'walks and indexes the project', False),
                  ('parsers', '16 languages, incl. nginx and SQL', False),
                  ('db.js', 'graph storage', False),
                  ('query.js', 'topology, bones, connections, ping', False),
                  ('registry.js', 'languages and file types', False),
                  ('estimate.js', 'size check before a scan', False),
                  ('architect-link.js', 'follows links between files', False),
                  ('tree-sitter', 'source parsing', True),
                  ('better-sqlite3', 'SQLite engine', True)],
    },
    'read_file': {
        'caption': 'read_file components. Dashed: third-party software.',
        'root': ('read_file', 'segment editor'),
        'items': [('segmenter.js', 'files into named segments', False),
                  ('config_segmenter.js', 'nginx, systemd, INI and more', False),
                  ('config_validators.js', 'service checks such as nginx -t', False),
                  ('external_detect.js', 'binaries and servers in code', False),
                  ('database adapters', 'SQLite, Postgres, MySQL and more', False),
                  ('architect-link.js', 'keeps the project map in sync', False),
                  ('tree-sitter', '16 language grammars', True),
                  ('better-sqlite3', 'edit state storage', True)],
    },
    'write_file': {
        'caption': 'write_file components.',
        'root': ('write_file', 'creates new files'),
        'items': [('path jail', 'confines the target path', False),
                  ('architect-link.js', 'files it into the project map', False)],
    },
    'git': {
        'caption': 'git components. Dashed: third-party software.',
        'root': ('git tool', 'sandboxed git'),
        'items': [('URL check', 'remote URLs only', False),
                  ('path jail', 'every folder checked', False),
                  ('git', 'the standard git program', True)],
    },
    'web': {
        'caption': 'web_skeleton components. Dashed: third-party software.',
        'root': ('web_skeleton', 'web perception'),
        'items': [('egress guard', 'blocks private addresses', False),
                  ('skeletonizer', 'page into sections with ids', False),
                  ('search', 'results with one-line summaries', False),
                  ('Chromium (CDP)', 'renders pages headless', True),
                  ('DuckDuckGo', 'search results', True)],
    },
}

# ── the clickable hub diagram on mcp-hosting.html ──
HUB_LINKS = {
    'server': 'mcp-server.html',
    'sandbox': 'mcp-sandbox.html',
    'master_architect': 'mcp-tool-master-architect.html',
    'read_file': 'mcp-tool-read-file.html',
    'write_file': 'mcp-tool-write-file.html',
    'git': 'mcp-tool-git.html',
    'web_skeleton': 'mcp-tool-web-skeleton.html',
}

EVIDENCE = [
    '**Token savings:** at least 97% fewer tokens than the usual shell workflow (grep, cat, '
    'run_cmd), measured against the best case where the model fixes the bug in one attempt. '
    'Real sessions save more, because the failed attempts common with raw shell access are '
    'not counted.',
    f'**Test it yourself:** try the tools free in the hosted sandbox with your own model and '
    f'repository, then post your results in [Discussions]({DISCUSSIONS_URL}): model, task, '
    f'tokens, time.',
    f'**Found a bug?** [Open an issue]({ISSUES_URL}) with the steps to reproduce it. '
    f'Every report makes the tools better.',
]

LICENSE_ABOUT = [
    ('h2', 'license', 'License and contact'),
    ('p', 'Dual licensed. Free under **AGPL-3.0**: use, modify and share, with source published '
          'for modified versions, including network use. Building it into a closed product? A '
          f'**commercial licence** removes the AGPL obligations. Contact [{CONTACT}](mailto:{CONTACT}).'),
    ('p', 'Designed and built by **Konstantinos Karamperis**, founder of Itamos Technologia in '
          'Pili, Trikala, Greece: a systems architect with a background in industrial engineering '
          'and infrastructure, building AI-native developer tools on AMD hardware with open-source '
          f'inference stacks. [LinkedIn]({LINKEDIN_URL})'),
]

# ── pages ───────────────────────────────────────────────────────────────────
# Blocks: ('h2', id, text) ('h3', text) ('p', text) ('ul', [items]) ('ol', [items])
#         ('diagram', key) ('deps', key) ('hub',) ('note', text)
# Inline: **bold**, `code`, [text](url)
PAGES = [
    {
        'file': 'mcp-hosting.html', 'hub': True,
        'title': 'Itamos MCP Tools',
        'page_title': 'Itamos MCP Tools: free live alpha sandbox for AI agents | Itamos Technologia',
        'desc': ('Structured code tools for AI agents: a project map, a segment editor and safe, '
                 'verified commits. How they work, why, and a free hosted sandbox to try them.'),
        'lead': ('Five tools that let an AI agent see and change code the way an engineer does: a '
                 'map of the project, named parts of every file, and checks before anything is '
                 'saved. Try them free in a private sandbox, with no account and nothing to install.'),
        'blocks': [
            ('hub',),
            ('p', 'Select any part of the diagram for its own page: how it works, which components '
                  'it depends on and everything it can do.'),
            ('h2', 'problem', 'The problem'),
            ('p', 'AI coding agents fail less from a lack of intelligence than from a lack of '
                  'perception. Codebases outgrow context windows, so agents search, open whole '
                  'files and edit text they have only half read. That costs tokens, causes blind '
                  'edits and broken files, and leaves the agent without a map of how files connect.'),
            ('h2', 'principles', 'Design principles'),
            ('ul', ['**Structure before text.** The agent sees the map first, then zooms in.',
                    '**Addresses, not line numbers.** Code is referred to by structural addresses that stay valid when other parts of the file change.',
                    '**Read before write.** A tool will not change code the model has not displayed since the last change.',
                    '**Verify before commit.** Edits stay in a buffer until they pass checks; only then do they reach disk.',
                    '**One job per tool.** Small, predictable tools are easier for a model to use correctly than one tool that does everything.',
                    '**The smallest useful answer.** Every response is the least text that answers the question, with a way to ask for more.']),
            ('h2', 'together', 'How the tools work together'),
            ('diagram', 'loop'),
            ('p', 'A typical bug fix: the agent scans the repository, uses `topology` and `bones` to '
                  'find the function named in the error, reads that one segment, replaces it, '
                  'verifies and commits. If verification fails, it gets the exact error and tries '
                  'again; the broken version never touches disk.'),
            ('h2', 'evidence', 'Evidence so far'),
            ('ul', ['In live use with Claude models (Opus and Sonnet), agents use the tools to navigate and change real codebases end to end.',
                    'Locally run open models of 27 to 31 billion parameters found the right file and function in an unfamiliar codebase, but did not complete the fix without guidance. Good tools help; model capability still matters.']
                   + EVIDENCE),
            ('h2', 'limits', 'Limitations and roadmap'),
            ('ul', ['**Alpha:** behavior and limits may change.',
                    '**Temporary by design:** sandboxes are emptied after 10 minutes of inactivity.',
                    '**No push:** results stay inside the sandbox.',
                    '**Planned:** anonymous usage statistics.']),
        ] + LICENSE_ABOUT,
    },
    {
        'file': 'mcp-server.html',
        'title': 'Sandbox server',
        'desc': 'How the Itamos MCP sandbox server signs users in without an account, assigns private sandboxes, queues and cleans up.',
        'lead': ('The front door. It signs users in without an account, gives each one a private '
                 'sandbox, queues them when every spot is taken and cleans up after them.'),
        'blocks': [
            ('diagram', 'request'),
            ('h2', 'components', 'Components'),
            ('deps', 'server'),
            ('h2', 'sign-in', 'Anonymous sign-in'),
            ('p', 'Hosted MCP clients such as claude.ai call from shared, rotating server addresses, '
                  'so an IP address cannot tell users apart. The server therefore uses a standard '
                  'OAuth 2.1 flow whose sign-in page has a single button, **Create my sandbox**: '
                  'no account and no email.'),
            ('ul', ['**Discovery:** the client finds the sign-in endpoints by itself (RFC 9728 and RFC 8414).',
                    '**Registration:** the client registers itself automatically (RFC 7591).',
                    '**Authorization:** one-time code with PKCE (S256), so an intercepted code is useless.',
                    '**Tokens:** an access token lasts 1 hour; the refresh token lasts 30 days and is replaced on every use.',
                    '**Storage:** clients and tokens are stored hashed. Codes and pending sign-ins live in memory only.',
                    'Each token maps to a random sandbox key. That key, not the IP address, decides which sandbox you get.']),
            ('h2', 'slots', 'The slot pool'),
            ('p', '500 sandboxes are created in advance as separate ZFS datasets, so the server never '
                  'needs administrator rights while it runs. Connecting and listing the tools never '
                  'takes a slot; a slot is taken on your first tool call.'),
            ('h2', 'queue', 'The waiting queue'),
            ('ul', ['When all 500 are in use, your tool call joins a queue in arrival order and tells you your position and an estimated wait.',
                    'A freed slot goes straight to the front of the queue: the sandbox is created at once and a one-time note says it is ready.',
                    'Optionally, the sign-in page asks for an email address for a single "your sandbox is ready" message. It is kept in memory only, never written to disk, and deleted once sent or after 24 hours. The server sends at most 60 such emails an hour.']),
            ('h2', 'cleanup', 'Cleanup'),
            ('p', 'Every tool call refreshes the sandbox. A watchdog checks regularly, and a sandbox '
                  'that has been idle for 10 minutes is emptied and its slot freed. Your login '
                  'stays valid, so your next tool call simply gets a new, empty sandbox, with a '
                  'short note saying so.'),
            ('h2', 'isolation', 'Isolation'),
            ('ul', ['**Path jail:** every path a tool receives is resolved against your sandbox and refused if it leads outside it.',
                    '**Symlink check:** a link inside the sandbox, for example from a cloned repository, could point anywhere. The jail finds the deepest part of the path that exists, resolves where it really lives and refuses it if that is outside the sandbox. A link that cannot be resolved is refused too.',
                    '**Per-call context:** each tool call runs with its own context naming your sandbox, your project map and your edit state, so tools can never mix up two users.']),
            ('h2', 'endpoints', 'Endpoints'),
            ('ul', ['`POST /mcp`: the MCP endpoint.',
                    '`GET /health`: pool status and queue length (it drives the live spot counter on these pages).',
                    '`/.well-known/*`, `/register`, `/authorize`, `/token`: the sign-in flow.']),
        ],
    },
    {
        'file': 'mcp-sandbox.html',
        'title': 'Your private sandbox',
        'desc': 'What is inside an Itamos MCP sandbox, how long it lives and what it cannot reach.',
        'lead': ('A private, temporary workspace: your files, your project map and your edit '
                 'history, invisible to every other user.'),
        'blocks': [
            ('diagram', 'lifecycle'),
            ('h2', 'contents', 'What is inside'),
            ('deps', 'sandbox'),
            ('ul', ['**Your files:** repositories you clone and files you create.',
                    '**Your project map:** master_architect keeps its index of your code inside your sandbox, not in a shared database.',
                    '**Your edit state:** read_file buffers, verification results and undo history live here too.',
                    '**2 GB of storage:** each sandbox is its own ZFS dataset with its own quota.']),
            ('h2', 'lifetime', 'How long it lives'),
            ('ul', ['It starts on your first tool call, not when you connect.',
                    'Every tool call keeps it alive.',
                    'After 10 minutes without activity, its files, project map and edit history are deleted.',
                    'Your login stays valid for up to 30 days, so the next tool call gets a fresh, empty sandbox without signing in again.']),
            ('h2', 'reach', 'What it cannot reach'),
            ('ul', ['Anything outside the sandbox folder, including through symlinks.',
                    'Private networks and this machine\'s own services: web_skeleton reaches public internet addresses only.',
                    'Remote repositories for writing: git has no push.']),
            ('note', '**This is a demonstration service.** Don\'t put anything sensitive or confidential '
                     'in the sandbox. It is built for trying the tools, not for private data.'),
            ('h2', 'why', 'Why temporary'),
            ('p', 'A sandbox that empties itself needs no account, no storage plan and no cleanup '
                  'policy, and it keeps 500 spots available for everyone who wants to try the tools.'),
        ],
    },
    {
        'file': 'mcp-tool-master-architect.html',
        'title': 'master_architect',
        'desc': 'master_architect: a project map for AI agents. How it indexes a codebase and what it can do.',
        'lead': ('The project map. It indexes a codebase once and lets the agent see files, '
                 'functions and how they connect, before reading a single line.'),
        'blocks': [
            ('diagram', 'architect'),
            ('h2', 'components', 'Components'),
            ('deps', 'master_architect'),
            ('h2', 'how', 'How it works'),
            ('p', 'master_architect scans a project and stores it as a graph in SQLite: every file, '
                  'module, function and import, plus the databases, programs and servers the code '
                  'refers to. Each item gets a hierarchical address such as `13.2.4`: file 13, '
                  'module 2, method 4. Files it cannot parse still get an address (with letters), '
                  'so they can be linked to.'),
            ('h2', 'capabilities', 'Capabilities'),
            ('ul', ['**topology:** the starting point. The project\'s files and how they import each other, plus databases and external programs.',
                    '**bones:** one file\'s structure: its imports and its functions, with addresses.',
                    '**navigate:** open a file, module or method by its address.',
                    '**connections:** follow the links into and out of a file.',
            '**ping:** traces where a file leads, hop by hop through its imports (see below).',
            '**context:** a cross-reference summary for a file, by its path.',
                    '**missing:** imports that point at nothing, found before anything runs.',
                    '**estimate** and **scan:** check a project\'s size, then index it.',
                    '**crawl:** follow links outward from a file to discover related files.',
                    '**languages** and **stats:** supported languages and index statistics.']),
            ('h2', 'trace', 'Tracing: where does a file lead?'),
            ('p', '`ping` works like a network trace-route, over the import graph. Starting from one file, '
                  'it follows every internal import hop by hop, numbering the hops, until each branch ends. '
                  'Each route is labelled by how it ends:'),
            ('ul', ['**external:** an import of an outside library.',
                    '**blocked:** an internal import that resolves to nothing: a broken link.',
                    '**cycle:** an import of a file the trace has already reached.',
                    '**leaf:** a file that imports nothing.',
                    '**endpoint:** a server, program, model or port the code refers to.']),
            ('p', 'Routes come back longest first, the best place to start looking for a bug that '
                  'surfaces far from its cause. The walk stops after 25 hops unless told otherwise. Tracing '
                  'is per file today; tracing individual function calls is planned.'),
            ('h2', 'why', 'Why it is built this way'),
            ('ul', ['**SQLite** keeps the graph self-contained: no database server, and it handles graphs with hundreds of thousands of items.',
                    '**Hierarchical addresses** are short enough to pass between tool calls and stay valid when lines move.',
                    '**Import resolution follows real project layouts:** packages, plain sibling imports in script folders, and `src/` layouts. An import rooted in the project that resolves to nothing is reported as broken, instead of being mistaken for an external library.']),
            ('h2', 'sandbox-notes', 'In the sandbox'),
            ('p', 'Scanning is limited to your sandbox, and your project map is stored inside it, so '
                  'it disappears with the sandbox.'),
        ],
    },
    {
        'file': 'mcp-tool-read-file.html',
        'title': 'read_file',
        'desc': 'read_file: a segment-addressed editor for AI agents with read-before-write and three-level verification.',
        'lead': ('The segment editor. It shows a file as named parts, lets the agent change exactly '
                 'one of them and refuses to save anything that does not pass verification.'),
        'blocks': [
            ('diagram', 'read_file'),
            ('h2', 'components', 'Components'),
            ('deps', 'read_file'),
            ('h2', 'how', 'How it works'),
            ('p', 'read_file parses a file into named segments: functions, classes, configuration '
                  'blocks, paragraphs. By default it returns the skeleton, the list of segments '
                  'with their names and sizes, not the code. The agent reads only the segment it '
                  'needs. Every byte of the file belongs to exactly one segment, including blank '
                  'lines, so joining the segments always gives back the original file.'),
            ('h2', 'capabilities', 'Capabilities'),
            ('h3', 'Reading'),
            ('ul', ['**skeleton:** the default view; `full_skeleton` forces the whole map of a very large file.',
                    '**search:** narrows a large skeleton to matching segments.',
                    '**segment:** reads one part by address, such as `5.3`.',
            '**trace:** follows the file\'s signal through the codebase: what it imports, who imports it, and the databases, programs and servers it touches. It then checks the direct neighbours: any that has not been verified gets a level 3 check, and the walk stops at the first failure.',
                    '**status:** lists open edit buffers.']),
            ('h3', 'Editing'),
            ('ul', ['**replace**, **insert** between two segments, **delete**, **move**.',
                    '**comment_out** and **uncomment** a segment while debugging.',
            '**paste:** copy a segment, or a whole file, verbatim from the read buffer into the file being edited (see the clipboard below).']),
            ('h3', 'Two buffers and the clipboard'),
            ('p', 'read_file keeps exactly two buffers per sandbox. The read buffer is read-only and always '
                  'fresh, and doubles as a clipboard: open any file there, then paste one of its segments, '
                  'or the whole file, verbatim into a segment of the file you are editing. The model never '
                  'retypes code it copies, so nothing is lost or changed on the way, and it costs almost no '
                  'tokens. The edit buffer holds the one file being changed; it is committed or discarded '
                  'before another file is opened for editing.'),
            ('h3', 'Undo'),
            ('ul', ['Every edit records its inverse: the previous text, a deleted segment with its position and children, or where a moved segment used to be. The record is also written to the edit history database.',
                    '**undo** reverts the last edit.',
                    '**undo** with an address reverts the latest change to that one segment, even when other edits came after it.',
                    '**undo all** reverts every edit since the last commit.',
                    'Inserts, deletes and moves change the structure of the file, so they are undone in reverse order (last in, first out). Text replacements can be undone in any order.',
                    'Every undo clears the verification: the file must pass verify again before it can be committed.']),
            ('h3', 'Safety'),
            ('ul', ['**Read before write:** a segment must have been displayed since the last change before it can be changed.',
                    '**verify:** level 1 syntax; level 2 the language\'s compiler or the service\'s own checker, such as `nginx -t`, `systemd-analyze verify` or `sshd -t`; level 3 imports and external references must resolve.',
            '**diff** shows changes against disk; **discard** drops the edit buffer.',
                    '**commit:** an atomic write, only with a current verification. It writes through symlinks to the real file and keeps its permissions.']),
            ('h3', 'Languages'),
            ('p', '16 tree-sitter grammars: Python, JavaScript, TypeScript, HTML, CSS, Go, Rust, C, '
                  'C++, Java, C#, PHP, Ruby, Bash, Swift and Kotlin. Configuration files (nginx, '
                  'systemd units, sshd_config, INI and more) get structure-aware segments, and plain '
                  'text and Markdown are split into paragraphs.'),
            ('h2', 'why', 'Why it is built this way'),
            ('ul', ['**Segments instead of lines:** a function named `authenticate_user` stays addressable when it moves from line 214 to line 389.',
                    '**Read before write** stops the most common agent mistake: editing code it never looked at.',
                    '**Verify before commit** turns a broken edit into a clear error message instead of a broken file.',
                    'In typical use the agent reads about 120 lines instead of a whole 5,000-line file.']),
        ],
    },
    {
        'file': 'mcp-tool-write-file.html',
        'title': 'write_file',
        'desc': 'write_file: creates new files for AI agents, never overwrites, and files them into the project map.',
        'lead': ('Creates new files, and only new files. Existing files are changed through '
                 'read_file, with its safety rules.'),
        'blocks': [
            ('diagram', 'write_file'),
            ('h2', 'components', 'Components'),
            ('deps', 'write_file'),
            ('h2', 'capabilities', 'Capabilities'),
            ('ul', ['Creates a file at the given path, creating missing folders.',
                    'Refuses to overwrite: if the file exists, it says so and points to read_file.',
                    'Files the new file into the project map, so master_architect and read_file know it immediately.']),
            ('h2', 'why', 'Why'),
            ('p', 'Silent overwrites are one of the most common ways agents destroy work. Making '
                  'creating and editing two separate tools removes that ambiguity entirely.'),
        ],
    },
    {
        'file': 'mcp-tool-git.html',
        'title': 'git',
        'desc': 'The sandboxed git tool: shallow clones from remote URLs, status and commit, no push.',
        'lead': ('Gets code into the sandbox and records your work there. Nothing leaves: '
                 'there is no push.'),
        'blocks': [
            ('diagram', 'git'),
            ('h2', 'components', 'Components'),
            ('deps', 'git'),
            ('h2', 'capabilities', 'Capabilities'),
            ('ul', ['**clone:** remote URLs only (https, http, git, ssh or `user@host:path`), never a local path. Shallow (`--depth=1`), with a 2-minute limit. Into the sandbox root unless you name a folder.',
                    '**status:** the changed files in a cloned repository.',
                    '**commit:** saves your changes in the sandbox under a fixed sandbox identity.']),
            ('h2', 'safety', 'Safety'),
            ('ul', ['Every folder is checked against the sandbox, including where symlinks really lead.',
                    'Clones are made with symlinks turned off, so a repository cannot plant a link that points outside the sandbox.',
                    'No push, so the sandbox can never publish anything.']),
            ('h2', 'why', 'Why'),
            ('p', 'A shallow clone turns minutes into seconds for large repositories, and most tasks '
                  'need no history.'),
        ],
    },
    {
        'file': 'mcp-tool-web-skeleton.html',
        'title': 'web_skeleton',
        'desc': 'web_skeleton: LLM-first web perception. Pages become skeletons of sections with ids.',
        'lead': ('Reads the web the way the other tools read code: a skeleton first, then only the '
                 'section that matters.'),
        'blocks': [
            ('diagram', 'web'),
            ('h2', 'components', 'Components'),
            ('deps', 'web'),
            ('h2', 'capabilities', 'Capabilities'),
            ('ul', ['**search:** search results, each with a title and a one-line summary.',
                    '**skeleton:** a rendered page as headings, sections, links and form elements, each with a stable id.',
                    '**read:** the full text of one section by id.',
                    '**click:** follow a link or button by id and get the new page\'s skeleton.']),
            ('h2', 'how', 'How it works'),
            ('p', 'Pages are rendered in headless Chromium through the Chrome DevTools Protocol, so '
                  'content built by JavaScript is included. In typical use, a page that would cost '
                  '50,000 to 200,000 tokens as raw HTML becomes a skeleton of 500 to 3,000 tokens.'),
            ('h2', 'safety', 'Safety in the sandbox'),
            ('ul', ['**Egress guard:** all browser traffic, including redirects, frames, background scripts and websockets, goes through a guard that resolves every address itself.',
                    'Private, loopback, link-local and cloud metadata addresses are refused, and the guard connects only to the exact address it checked, so DNS tricks cannot reach this machine or its network.',
                    'Only https for public sites; `file://`, `data:` and similar schemes are blocked.']),
        ],
    },
]

TRY_INTRO = 'Add this URL as a custom connector in your MCP client:'
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


def _markers(key):
    return ('<defs><marker id="ah-%s" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
            '<path d="M0,0 L10,5 L0,10 z" class="dg-head"/></marker>'
            '<marker id="ab-%s" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
            '<path d="M0,0 L10,5 L0,10 z" class="dg-head-back"/></marker></defs>' % (key, key))


def _fig(svg, caption):
    return f'<figure class="dg-fig">{svg}<figcaption>{html.escape(caption)}</figcaption></figure>'


# ── SVG diagrams for the website ────────────────────────────────────────────
def svg_diagram(key):
    d = DIAGRAMS[key]
    nodes, back = d['nodes'], d.get('back')
    W, BX, BW, BH, GAP, TOP = 400, 16, 290, 56, 30, 10
    H = TOP + len(nodes) * BH + (len(nodes) - 1) * GAP + 10
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(d["caption"])}" class="dg">',
           _markers(key)]
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
    return _fig(''.join(out), d['caption'])


def svg_deps(key):
    """Tree: the component on top, what it needs below, joined by a spine."""
    d = DEPS[key]
    items = d['items']
    W, RX, RW, RH = 400, 16, 290, 56
    SX, IX, IW, IH, IG = 40, 64, 320, 46, 12
    top = RH + 20
    ys = [top + 10 + i * (IH + IG) for i in range(len(items))]
    H = ys[-1] + IH + 10
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(d["caption"])}" class="dg">']
    rt, rd = d['root']
    out.append(f'<rect x="{RX}" y="10" width="{RW}" height="{RH}" rx="10" class="dg-box dg-root"/>')
    out.append(f'<text x="{RX + RW / 2}" y="33" class="dg-title" text-anchor="middle">{html.escape(rt)}</text>')
    out.append(f'<text x="{RX + RW / 2}" y="52" class="dg-sub" text-anchor="middle">{html.escape(rd)}</text>')
    out.append(f'<line x1="{SX}" y1="{10 + RH}" x2="{SX}" y2="{ys[-1] + IH / 2}" class="dg-spine"/>')
    for y, (name, role, ext) in zip(ys, items):
        cls = 'dg-box dg-ext' if ext else 'dg-box'
        out.append(f'<line x1="{SX}" y1="{y + IH / 2}" x2="{IX}" y2="{y + IH / 2}" class="dg-spine"/>')
        out.append(f'<rect x="{IX}" y="{y}" width="{IW}" height="{IH}" rx="8" class="{cls}"/>')
        out.append(f'<text x="{IX + 14}" y="{y + 19}" class="dg-title">{html.escape(name)}</text>')
        out.append(f'<text x="{IX + 14}" y="{y + 36}" class="dg-sub">{html.escape(role)}</text>')
    out.append('</svg>')
    return _fig(''.join(out), d['caption'])


def svg_hub():
    """The clickable overview: client → server → five tools → your sandbox."""
    W = 400
    out = [f'<svg viewBox="0 0 {W} 494" role="img" aria-label="Itamos MCP: server, tools and sandbox. Select a part for details." class="dg dg-hub">',
           _markers('hub')]

    def box(x, y, w, title, sub, link=None):
        rect = f'<rect x="{x}" y="{y}" width="{w}" height="56" rx="10" class="dg-box{" dg-link" if link else ""}"/>'
        t1 = f'<text x="{x + w / 2}" y="{y + 23}" class="dg-title" text-anchor="middle">{html.escape(title)}</text>'
        t2 = f'<text x="{x + w / 2}" y="{y + 42}" class="dg-sub" text-anchor="middle">{html.escape(sub)}</text>'
        g = rect + t1 + t2
        if link:
            return f'<a href="{link}" class="dg-a"><title>{html.escape(title)}: details</title>{g}</a>'
        return g

    def arrow(y1, y2):
        return f'<line x1="200" y1="{y1}" x2="200" y2="{y2 - 2}" class="dg-arrow" marker-end="url(#ah-hub)"/>'

    out.append(box(55, 10, 290, 'Your MCP client', 'Claude or any MCP client'))
    out.append(arrow(66, 96))
    out.append(box(55, 96, 290, 'Sandbox server', 'sign-in, slots, queue, isolation', HUB_LINKS['server']))
    out.append(arrow(152, 182))
    out.append('<rect x="8" y="182" width="384" height="216" rx="12" class="dg-group"/>')
    tools = [('master_architect', 'project map'), ('read_file', 'segment editor'),
             ('write_file', 'creates new files'), ('git', 'clones repositories'),
             ('web_skeleton', 'reads web pages')]
    pos = [(20, 194), (205, 194), (20, 262), (205, 262), (112.5, 330)]
    for (name, sub), (x, y) in zip(tools, pos):
        out.append(box(x, y, 175, name, sub, HUB_LINKS[name]))
    out.append(arrow(398, 428))
    out.append(box(55, 428, 290, 'Your private sandbox', 'isolated 2 GB workspace', HUB_LINKS['sandbox']))
    out.append('</svg>')
    return _fig(''.join(out), 'Select the server, a tool or the sandbox for its own page.')


# ── Mermaid diagrams for GitHub ─────────────────────────────────────────────
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


def mermaid_deps(key):
    d = DEPS[key]
    rt, rd = d['root']
    lines = ['```mermaid', 'flowchart LR', f'  r["<b>{rt}</b><br/>{rd}"]']
    for i, (name, role, ext) in enumerate(d['items']):
        lines.append(f'  d{i}{"([" if ext else "["}"<b>{name}</b><br/>{role}"{"])" if ext else "]"}')
        lines.append(f'  r --> d{i}')
    lines.append('```')
    lines.append(f'*{d["caption"].replace("Dashed", "Rounded")}*')
    return '\n'.join(lines)


def mermaid_hub():
    return '\n'.join([
        '```mermaid', 'flowchart TD',
        '  c["<b>Your MCP client</b>"] --> s["<b>Sandbox server</b><br/>sign-in, slots, queue, isolation"]',
        '  s --> ma["master_architect"] & rf["read_file"] & wf["write_file"] & g["git"] & ws["web_skeleton"]',
        '  ma & rf & wf & g & ws --> sb["<b>Your private sandbox</b><br/>isolated 2 GB workspace"]',
        '```'])


# ── Markdown (all pages in one file) ────────────────────────────────────────
def page_anchor(p):
    return pathlib.Path(p['file']).stem


def blocks_markdown(blocks, level):
    md, h2, h3 = [], '#' * level, '#' * (level + 1)
    for b in blocks:
        kind = b[0]
        if kind == 'h2':
            md += [f'{h2} {b[2]}', '']
        elif kind == 'h3':
            md += [f'{h3} {b[1]}', '']
        elif kind == 'p':
            md += [b[1], '']
        elif kind == 'ul':
            md += [f'- {x}' for x in b[1]] + ['']
        elif kind == 'ol':
            md += [f'{i}. {x}' for i, x in enumerate(b[1], 1)] + ['']
        elif kind == 'diagram':
            md += [mermaid_diagram(b[1]), '']
        elif kind == 'deps':
            md += [mermaid_deps(b[1]), '']
        elif kind == 'hub':
            md += [mermaid_hub(), '']
        elif kind == 'note':
            md += [f'> {b[1]}', '']
    return md


def build_markdown():
    hub, details = PAGES[0], PAGES[1:]
    md = [f'# {hub["title"]}', '', f'*{hub["lead"]}*', '',
          f'**Live alpha, free:** connect any MCP client to `{MCP_URL}` (details at the end).', '',
          '## Contents', '', '- [Overview](#overview)']
    md += [f'- [{p["title"]}](#{page_anchor(p)})' for p in details] + ['- [Try it](#try-it)', '']
    md += ['<a id="overview"></a>', '## Overview', ''] + blocks_markdown(hub['blocks'], 3)
    for p in details:
        md += [f'<a id="{page_anchor(p)}"></a>', f'## {p["title"]}', '', f'*{p["lead"]}*', '']
        md += blocks_markdown(p['blocks'], 3)
    md += ['<a id="try-it"></a>', '## Try it', '', TRY_INTRO, '', f'```\n{MCP_URL}\n```', '']
    md += [f'{i}. {x}' for i, x in enumerate(TRY_STEPS, 1)] + ['']
    if REPO_URL:
        md += [f'Source code: [{REPO_URL}]({REPO_URL})', '']
    md += ['---', '', '*This file is generated by `docs/build_paper.py`; edit the content there.*', '']
    return '\n'.join(md)


# ── website pages ───────────────────────────────────────────────────────────
PAGE_CSS = """
/* ── paper (generated by itamos-mcp-tools docs/build_paper.py) ── */
.paper { max-width: 820px; margin: 0 auto; padding: 120px 22px 40px; }
.paper .badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--success); }
.paper .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.paper .crumb { display: inline-block; font-size: 0.9rem; margin-bottom: 14px; }
.paper h1 { font-family: var(--font-display); font-weight: 400; font-size: clamp(2.2rem, 6vw, 3.2rem); line-height: 1.1; margin: 10px 0 12px; overflow-wrap: anywhere; }
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
.paper .pages { border-top: 1px solid var(--border); margin-top: 46px; padding-top: 18px; }
.paper .pages ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.paper .pages li { margin: 0; }
.paper .pages a, .paper .pages span { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 0.88rem; text-decoration: none; }
.paper .pages span { color: var(--text-muted); }
.dg-fig { margin: 22px auto; max-width: 440px; }
.dg { width: 100%; height: auto; display: block; }
.dg-box { fill: rgba(56,189,248,0.07); stroke: rgba(56,189,248,0.45); stroke-width: 1.2; }
.dg-root { fill: rgba(56,189,248,0.16); }
.dg-ext { fill: transparent; stroke-dasharray: 5 4; }
.dg-group { fill: none; stroke: rgba(56,189,248,0.25); stroke-width: 1; stroke-dasharray: 4 4; }
.dg-spine { stroke: rgba(56,189,248,0.45); stroke-width: 1.2; }
.dg-link { fill: rgba(56,189,248,0.14); stroke: var(--accent); }
.dg-a { cursor: pointer; }
.dg-a:hover .dg-link, .dg-a:focus .dg-link { fill: rgba(56,189,248,0.28); }
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


def blocks_html(blocks):
    h = []
    for b in blocks:
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
        elif kind == 'deps':
            h.append(svg_deps(b[1]))
        elif kind == 'hub':
            h.append(svg_hub())
        elif kind == 'note':
            h.append(f'<div class="note"><p>{inline_html(b[1])}</p></div>')
    return h


def try_section():
    h = ['<section class="try" id="try-it">',
         '<h2>Try it</h2>',
         f'<p>{inline_html(TRY_INTRO)}</p>',
         f'<div class="url-row"><code id="mcp-url">{html.escape(MCP_URL)}</code>'
         '<button type="button" id="copy-url">Copy</button></div>',
         '<ol>' + ''.join(f'<li>{inline_html(x)}</li>' for x in TRY_STEPS) + '</ol>',
         '<p class="slots" id="slots" hidden><b id="slots-used">—</b>/<span id="slots-total">500</span> spots in use right now.</p>']
    if REPO_URL:
        h.append(f'<p>Source code: <a href="{html.escape(REPO_URL)}">{html.escape(REPO_URL)}</a></p>')
    h.append('</section>')
    return h


def page_links(current):
    items = []
    for p in PAGES:
        label = 'Overview' if p.get('hub') else p['title']
        if p['file'] == current['file']:
            items.append(f'<li><span aria-current="page">{html.escape(label)}</span></li>')
        else:
            items.append(f'<li><a href="{p["file"]}">{html.escape(label)}</a></li>')
    return ['<nav class="pages" aria-label="All pages"><strong>All pages</strong><ul>'] + items + ['</ul></nav>']


def build_html_body(page):
    h = ['<!-- PAPER:START (generated by itamos-mcp-tools docs/build_paper.py; edit there, not here) -->',
         '<main class="paper">']
    if not page.get('hub'):
        h.append(f'<a class="crumb" href="{PAGES[0]["file"]}">← Itamos MCP Tools</a>')
    h += ['<div class="badge">Live alpha · free</div>',
          f'<h1>{html.escape(page["title"])}</h1>',
          f'<p class="lead">{inline_html(page["lead"])}</p>']
    h += blocks_html(page['blocks'])
    h += try_section()
    h += page_links(page)
    h += ['</main>', PAGE_JS, '<!-- PAPER:END -->', '']
    return '\n'.join(h)


def render_page(template, page):
    src = template
    body = build_html_body(page)
    if '<!-- PAPER:START' in src:
        start = src.index('<!-- PAPER:START')
        end = src.index('<!-- PAPER:END -->') + len('<!-- PAPER:END -->') + 1
    else:
        # First build: replace everything between the navigation and the footer.
        start = src.index('</nav>', src.index('<nav class="navbar"')) + len('</nav>') + 1
        end = src.index('<footer class="footer">')
    src = src[:start] + '\n' + body + '\n' + src[end:]
    title = page.get('page_title') or f'{page["title"]}: Itamos MCP Tools | Itamos Technologia'
    desc = page['desc']
    src = re.sub(r'<title>.*?</title>', f'<title>{html.escape(title)}</title>', src, count=1, flags=re.S)
    src = re.sub(r'<meta name="description" content="[^"]*"',
                 f'<meta name="description" content="{html.escape(desc)}"', src, count=1)
    src = re.sub(r'<meta name="keywords" content="[^"]*"',
                 f'<meta name="keywords" content="{html.escape(PAGE_KEYWORDS)}"', src, count=1)
    # Social previews (WhatsApp, LinkedIn, Facebook) use the og: tags.
    src = re.sub(r'<meta property="og:title" content="[^"]*"',
                 f'<meta property="og:title" content="{html.escape(title)}"', src, count=1)
    src = re.sub(r'<meta property="og:description" content="[^"]*"',
                 f'<meta property="og:description" content="{html.escape(desc)}"', src, count=1)
    src = re.sub(r'<meta property="og:type" content="[^"]*"', '<meta property="og:type" content="article"', src, count=1)
    src = re.sub(r'(<link rel="canonical" href="[^"]*/)[^"/]*"', rf'\g<1>{page["file"]}"', src, count=1)
    src = re.sub(r'(<meta property="og:url" content="[^"]*/)[^"/]*"', rf'\g<1>{page["file"]}"', src, count=1)
    marker = '/* ── paper (generated by itamos-mcp-tools'
    if marker in src:
        cs = src.index(marker)
        src = src[:cs] + PAGE_CSS.lstrip('\n') + src[src.index('</style>', cs):]
    else:
        k = src.index('</style>')
        src = src[:k] + PAGE_CSS + src[k:]
    return src


def build_site(site_dir):
    site = pathlib.Path(site_dir)
    template = (site / PAGES[0]['file']).read_text()
    written = []
    for page in PAGES:
        out = site / page['file']
        out.write_text(render_page(template, page))
        written.append(out)
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', help='website directory containing mcp-hosting.html')
    args = ap.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    (here / 'PAPER.md').write_text(build_markdown())
    print('wrote', here / 'PAPER.md')
    if args.site:
        for p in build_site(args.site):
            print('wrote', p)


if __name__ == '__main__':
    main()
