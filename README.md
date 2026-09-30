# Itamos MCP Tools

**Model Context Protocol tools for AI-assisted development.**  
Built by [Itamos Technologia](https://itamos-technologia.com)

---

## 🚀 Try it instantly — no setup required

Get a live sandbox in one request:

```bash
curl https://mcp.itamos.eu/session/create
```

Returns:
```json
{
  "ok": true,
  "mcp_url": "https://mcp.itamos.eu/mcp",
  "sandbox": "/fast/sandboxes/slot_042",
  "expires": "5 minutes of inactivity"
}
```

Paste the `mcp_url` into Claude, Cursor, or any MCP-compatible client and start using the tools immediately.

**No signup. No API key. No installation.**  
Your sandbox is isolated, quota-limited (2GB), and auto-wiped after 5 minutes of inactivity.

---

## 🛠 Tools

### `master_architect`
Navigate codebases of any size. Scans project structure into a segment-addressed DB, then lets you drill from topology → file bones → exact code segments. Navigated a 240,000-file C++ codebase and fixed a low-level bug in 10 seconds.

**Actions:** `scan`, `list`, `topology`, `bones`, `navigate`, `estimate`

### `read_file`
Segment-addressed file reading with project awareness. Reads exactly the code you need — not the whole file.

### `write_file`
Write new files or make targeted segment edits. Integrates with the architect's addressing system.

### `web_skeleton`
97% token reduction vs raw HTML. Turns any web page into a structured, navigable skeleton with interactive elements identified and extracted.

**Actions:** `skeleton`, `read`, `click`

### `git`
Clone any public repository into your sandbox, check status, commit changes.

**Actions:** `clone`, `status`, `commit`

---

## 🔧 Self-hosting

### Requirements
- Node.js 20+
- ZFS filesystem (for sandbox isolation and quotas)
- Chromium (for web_skeleton)

### Setup
```bash
git clone https://github.com/Itamos-technologia/itamos-mcp-tools.git
cd itamos-mcp-tools
npm install
cd tools/master-architect && npm install && cd ../..

# Pre-create ZFS sandbox slots (adjust count as needed)
sudo zfs create fast/sandboxes
for i in $(seq 1 50); do
  sudo zfs create -o quota=2G fast/sandboxes/slot_$(printf "%03d" $i)
  sudo chown $USER:$USER /fast/sandboxes/slot_$(printf "%03d" $i)
done

# Start
SANDBOX_PORT=4200 node server-sandbox.js
```

### Connect
```
http://localhost:4200/mcp
```

---

## 📐 Architecture

- **IP-based sessions** — your IP is your identity, no auth needed
- **ZFS isolation** — each session gets its own dataset with hard quota
- **Jail layer** — all file operations confined to your sandbox
- **Auto-cleanup** — 5 minutes idle → sandbox wiped, slot returned to pool
- **500 concurrent sessions** on the hosted instance

---

## 📄 License

Dual licensed — AGPL v3 for open source use, commercial license available.  
See [LICENSE](LICENSE) for details.  
Commercial inquiries: info@itamos-technologia.com
