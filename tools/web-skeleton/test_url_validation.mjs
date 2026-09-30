/**
 * Test URL validation for web_skeleton
 * Run: node test_url_validation.mjs
 */

// Extract validateUrl from the module by importing and testing the handler
// But since validateUrl is not exported, let's inline-test the logic

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }

  const scheme = parsed.protocol;
  if (scheme === 'https:') return; // always OK

  if (scheme === 'http:') {
    const host = parsed.hostname;
    // localhost variants
    if (host === 'localhost' || host === '127.0.0.1'
        || host === '[::1]' || host === '::1' || host === '0.0.0.0') return;
    // Private RFC1918 ranges
    if (host.startsWith('10.')) return;
    if (host.startsWith('192.168.')) return;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return;
    // Link-local
    if (host.startsWith('169.254.')) return;

    throw new Error(`HTTP only allowed for local/private addresses. Got: ${host}. Use HTTPS for public sites.`);
  }

  throw new Error(`Blocked URL scheme: ${scheme} — only https:// and http:// (local only) are allowed.`);
}

// Test cases
const tests = [
  // Should PASS
  { url: 'https://example.com', expect: 'pass', desc: 'HTTPS public' },
  { url: 'https://claude.ai/chat', expect: 'pass', desc: 'HTTPS Claude' },
  { url: 'http://localhost:3000', expect: 'pass', desc: 'HTTP localhost' },
  { url: 'http://127.0.0.1:8080', expect: 'pass', desc: 'HTTP 127.0.0.1' },
  { url: 'http://[::1]:5000', expect: 'pass', desc: 'HTTP IPv6 loopback' },
  { url: 'http://0.0.0.0:4000', expect: 'pass', desc: 'HTTP 0.0.0.0' },
  { url: 'http://192.168.1.100:3000', expect: 'pass', desc: 'HTTP 192.168.x.x' },
  { url: 'http://10.0.0.5:8080', expect: 'pass', desc: 'HTTP 10.x.x.x' },
  { url: 'http://172.16.0.1:9090', expect: 'pass', desc: 'HTTP 172.16.x.x' },
  { url: 'http://172.31.255.255', expect: 'pass', desc: 'HTTP 172.31.x.x upper bound' },
  { url: 'http://169.254.1.1', expect: 'pass', desc: 'HTTP link-local' },

  // Should FAIL
  { url: 'http://example.com', expect: 'fail', desc: 'HTTP public site' },
  { url: 'http://8.8.8.8', expect: 'fail', desc: 'HTTP public IP' },
  { url: 'http://172.32.0.1', expect: 'fail', desc: 'HTTP 172.32 (outside RFC1918)' },
  { url: 'http://172.15.0.1', expect: 'fail', desc: 'HTTP 172.15 (outside RFC1918)' },
  { url: 'file:///etc/passwd', expect: 'fail', desc: 'file:// scheme' },
  { url: 'file:///tank/projects/mcp-servers/.oauth_tokens.json', expect: 'fail', desc: 'file:// secrets' },
  { url: 'chrome://settings', expect: 'fail', desc: 'chrome:// scheme' },
  { url: 'javascript:alert(1)', expect: 'fail', desc: 'javascript: scheme' },
  { url: 'data:text/html,<h1>hi</h1>', expect: 'fail', desc: 'data: scheme' },
  { url: 'ftp://files.example.com', expect: 'fail', desc: 'ftp: scheme' },
  { url: 'not a url', expect: 'fail', desc: 'invalid URL' },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  let result;
  try {
    validateUrl(t.url);
    result = 'pass';
  } catch (e) {
    result = 'fail';
  }

  const ok = result === t.expect;
  const icon = ok ? '✓' : '✗';
  const status = ok ? 'OK' : 'FAIL';
  console.log(`${icon} [${status}] ${t.desc}: ${t.url} → expected ${t.expect}, got ${result}`);

  if (ok) passed++;
  else failed++;
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
process.exit(failed > 0 ? 1 : 0);
