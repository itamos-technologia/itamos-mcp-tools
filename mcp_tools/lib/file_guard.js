/**
 * File access guard — blocks shell commands that LLMs use to read or edit files.
 * All file reading must go through read_file, all editing through write_file.
 */

// Commands an LLM would use to read files
const READ_BLOCKED = [
  'cat', 'head', 'tail', 'tac',
  'less', 'more',
  'bat', 'batcat',
  'strings',
];

// Commands an LLM would use to edit files
const EDIT_BLOCKED = [
  'sed',
  'awk',
  'perl',
  'tee',
  'truncate',
  'patch',
];

// RTK subcommands that read files
const BLOCKED_RTK = ['read', 'smart'];

const READ_MSG = 'This command reads file contents. Use the read_file tool instead — it provides a skeleton view with 70-95% token reduction.';
const EDIT_MSG = 'This command edits files. Use the write_file tool instead — it provides safe segment-based editing with undo and verification.';

export function checkCommand(cmd) {
  var trimmed = cmd.trim();
  var first = trimmed.split(/[\s|;&]/)[0].replace(/^.*\//, '');

  if (READ_BLOCKED.includes(first)) return READ_MSG;
  if (EDIT_BLOCKED.includes(first)) return EDIT_MSG;

  // Catch redirect writes: echo/printf > file
  if (/\b(echo|printf)\b.*[^>]>[^>]/.test(trimmed)) return EDIT_MSG;

  // Catch python file operations (read or write)
  if (/\bpython3?\s+-c\s+.*open\s*\(/.test(trimmed)) return EDIT_MSG;
  if (/\bpython3?\s+.*<</.test(trimmed)) return EDIT_MSG;
  if (/\bpython3?\s+-c\s+.*(read|write|\.readlines|\.writelines)/.test(trimmed)) return EDIT_MSG;

  // Catch node file operations
  if (/\bnode\s+-e\s+.*(readFile|writeFile|appendFile|createWriteStream|createReadStream)/.test(trimmed)) return EDIT_MSG;

  // Block bash/sh executing script files (bypass vector)
  if (/\b(bash|sh|source)\s+\S+\.(sh|bash|py|js|pl|rb)\b/.test(trimmed)) return EDIT_MSG;
  if (/\b(bash|sh)\s+-c\b/.test(trimmed)) {
    // Inspect inner command for blocked patterns
    var inner = trimmed.replace(/^.*?\b(?:bash|sh)\s+-c\s+['"]?/, '');
    var innerFirst = inner.split(/[\s|;&]/)[0].replace(/^.*\//, '');
    if (READ_BLOCKED.includes(innerFirst)) return READ_MSG;
    if (EDIT_BLOCKED.includes(innerFirst)) return EDIT_MSG;
  }

  return null;
}

export function checkRtkCommand(cmd) {
  var sub = cmd.trim().split(/\s+/)[0];
  if (BLOCKED_RTK.includes(sub)) return READ_MSG;
  return checkCommand(cmd);
}
