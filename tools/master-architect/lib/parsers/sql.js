/**
 * SQL parser adapter for master-architect.
 *
 * Uses regex-based DDL extraction — tree-sitter-sql has version compatibility
 * issues with tree-sitter 0.25. SQL DDL is structurally simple enough that
 * regex is more reliable and faster anyway.
 *
 * Detected:
 *   modules:  CREATE TABLE, CREATE VIEW, CREATE PROCEDURE, CREATE FUNCTION,
 *             CREATE INDEX, CREATE TRIGGER
 * Note: sql_queries not populated (entire file IS queries)
 */

function nodeLine(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

export default {
  language: 'sql',
  extensions: ['.sql'],

  parseFile(content) {
    const analysis = { modules: [], imports: [], databases: [], sql_queries: [] };
    try {
      // Match CREATE [OR REPLACE] [kind modifiers] <kind> <name>
      const ddlPattern = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER|SEQUENCE|TYPE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`'"]?[\w.]+[`'"]?)/gim;

      let match;
      while ((match = ddlPattern.exec(content)) !== null) {
        const kind  = match[1].toLowerCase();
        const name  = match[2].replace(/[`'"]/g, '');
        const line  = nodeLine(content, match.index);
        analysis.modules.push({ kind, name, line, line_end: line });
      }
    } catch (err) {
      analysis.parse_error = err.message;
    }
    return analysis;
  },

  resolveImport() { return null; },
};
