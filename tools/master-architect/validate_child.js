// Validates ONE file in its own short-lived process, so all the memory the
// checks use (tree-sitter trees, macro-masking re-parses, compiler output)
// goes back to the operating system when the process exits. The server's
// validation queue starts one of these per file, one at a time.
//
// Usage:  MASTER_ARCHITECT_DB=<architect db> node --expose-gc validate_child.js <absPath> <language>
// Output: one JSON line on stdout: { level, problems, unchecked }
process.env.VALIDATE_CHILD = '1';   // set before the engine loads: no queues start in here

const [, , absPath, language] = process.argv;
try {
  const engine = await import('./read_file.js');
  const result = await engine.validateOneFile(absPath, language);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ level: 1, problems: [`check failed: ${e.message}`], unchecked: [] }) + '\n');
  process.exit(0);
}
