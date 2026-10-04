// =============================================================================
// SEGMENTER (worker module)
// =============================================================================
//
// Single source of truth for file segmentation. Lifted VERBATIM from read_file.js
// (the hardened version) so the architect (worker) and read_file (boss) share ONE
// segmenter. read_file imports segmentFile from here; the architect's scan can
// derive modules from the same tree-walk.
//
// Self-contained: owns its tree-sitter parser set + banner constants, identical
// to read_file's. The ONLY injectable is the plaintext AI-titling hook
// (aiTitleSegments) — defaults to a no-op, since module-derivation only needs
// code files, and a no-op keeps the code path byte-identical for those.
//
// Output shape (unchanged from read_file): segmentFile(path, content, lang)
//   -> { segments, hasParseErrors }
// where segments is the ordered, gapless, nested segment tree.

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import JavaScript from 'tree-sitter-javascript';
import TypeScriptModule from 'tree-sitter-typescript';
import Html from 'tree-sitter-html';
import Css from 'tree-sitter-css';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import Java from 'tree-sitter-java';
import CSharpModule from 'tree-sitter-c-sharp';
import PhpModule from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import Bash from 'tree-sitter-bash';
import Swift from 'tree-sitter-swift';
import Kotlin from 'tree-sitter-kotlin';
import { detectConfigFlavor, segmentConfig } from './config_segmenter.js';

const TypeScript = TypeScriptModule.typescript;
const CSharp = CSharpModule;
const Php = PhpModule.php ?? PhpModule;

// Section banner regexes — identical to read_file's.
const SECTION_BANNER_SINGLE = /^[\s]*[#/]+[\s═━─=]+([A-Z][A-Z0-9_ /-]{2,})[\s═━─=]+[#/]*\s*$/;
const BANNER_NAME_LINE      = /^[\s]*[#/]+\s+([A-Z][A-Z0-9_ /-]{2,})\s*$/;
const BANNER_RULE_LINE      = /^[\s]*[#/]+[\s═━─=]{5,}[#/]*\s*$/;

const _parsers = new Map();
function getParser(language) {
  if (_parsers.has(language)) return _parsers.get(language);
  const p = new Parser();
  if (language === 'python') p.setLanguage(Python);
  else if (language === 'javascript') p.setLanguage(JavaScript);
  else if (language === 'typescript') p.setLanguage(TypeScript);
  else if (language === 'html') p.setLanguage(Html);
  else if (language === 'css')     p.setLanguage(Css);
  else if (language === 'go')      p.setLanguage(Go);
  else if (language === 'rust')    p.setLanguage(Rust);
  else if (language === 'c')       p.setLanguage(C);
  else if (language === 'cpp')     p.setLanguage(Cpp);
  else if (language === 'java')    p.setLanguage(Java);
  else if (language === 'csharp')  p.setLanguage(CSharp);
  else if (language === 'php')     p.setLanguage(Php);
  else if (language === 'ruby')    p.setLanguage(Ruby);
  else if (language === 'shell')   p.setLanguage(Bash);
  else if (language === 'swift')   p.setLanguage(Swift);
  else if (language === 'kotlin')  p.setLanguage(Kotlin);
  else return null;
  _parsers.set(language, p);
  return p;
}

let _segId = 0;
function freshId() { return `seg_${String(++_segId).padStart(4, '0')}`; }

function extractName(node) {
  const t = node.type;
  // ── Python / JavaScript / TypeScript ──
  if (t === 'function_definition' || t === 'function_declaration' ||
      t === 'class_definition' || t === 'class_declaration' ||
      t === 'method_definition') {
    const n = node.childForFieldName('name');
    if (n) return n.text;
  }
  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    const decl = node.namedChild(0);
    if (decl) {
      const n = decl.childForFieldName('name');
      if (n) return n.text;
    }
  }
  if (t === 'decorated_definition') {
    for (const c of node.namedChildren) {
      if (c.type === 'function_definition' || c.type === 'class_definition') {
        return extractName(c);
      }
    }
  }
  if (t === 'expression_statement') {
    const expr = node.namedChild(0);
    if (!expr) return '(expr)';
    return extractCallTargetName(expr) || '(expr)';
  }
  if (t === 'import_statement' || t === 'import_from_statement') {
    return '(import)';
  }
  if (t === 'export_statement') {
    const inner = node.namedChild(0);
    if (inner && inner.childForFieldName) {
      const n = inner.childForFieldName('name');
      if (n) return `export ${n.text}`;
      return `export ${inner.type}`;
    }
    return 'export';
  }
  // ── HTML ──
  if (t === 'element' || t === 'self_closing_tag') {
    const startTag = node.children.find(c => c.type === 'start_tag' || c.type === 'self_closing_tag');
    if (startTag) {
      const tagName = startTag.children.find(c => c.type === 'tag_name');
      let name = tagName ? tagName.text : '(element)';
      // Append id and class for identification
      for (const attr of startTag.children) {
        if (attr.type === 'attribute') {
          const attrName = attr.children.find(c => c.type === 'attribute_name');
          const attrVal = attr.children.find(c => c.type === 'quoted_attribute_value' || c.type === 'attribute_value');
          if (attrName && attrVal) {
            const n = attrName.text;
            const v = attrVal.text.replace(/['"]/g, '');
            if (n === 'id') name += '#' + v;
            else if (n === 'class') name += '.' + v.split(/\s+/)[0];
          }
        }
      }
      return name;
    }
  }
  if (t === 'doctype') return '<!DOCTYPE>';
  if (t === 'comment') return '(comment)';
  if (t === 'text') {
    const txt = node.text.trim();
    if (!txt) return '(blank)';
    return txt.length > 40 ? txt.slice(0, 37) + '...' : txt;
  }
  // ── CSS ──
  if (t === 'rule_set') {
    const sel = node.children.find(c => c.type === 'selectors');
    return sel ? sel.text : '(rule)';
  }
  if (t === 'media_statement') {
    // @media (max-width: 768px) { ... }
    const txt = node.text;
    const match = txt.match(/@media\s*([^{]+)/);
    return match ? '@media ' + match[1].trim() : '@media';
  }
  if (t === 'import_statement') return '@import';
  if (t === 'charset_statement') return '@charset';
  if (t === 'keyframes_statement') {
    const nameNode = node.children.find(c => c.type === 'keyframes_name');
    return nameNode ? '@keyframes ' + nameNode.text : '@keyframes';
  }
  if (t === 'at_rule') {
    const txt = node.text.slice(0, 60);
    return txt.includes('{') ? txt.slice(0, txt.indexOf('{')).trim() : txt;
  }
  return `(${t})`;
}

function extractCallTargetName(expr) {
  if (expr.type === 'assignment_expression' || expr.type === 'assignment') {
    const left = expr.childForFieldName('left');
    if (left) return left.text.slice(0, 60);
  }
  if (expr.type === 'call_expression' || expr.type === 'call') {
    const fn = expr.childForFieldName('function') || expr.childForFieldName('callee');
    if (fn) return fn.text.slice(0, 60);
  }
  if (expr.type === 'member_expression' || expr.type === 'attribute') {
    return expr.text.slice(0, 60);
  }
  if (expr.type === 'identifier') return expr.text;
  return null;
}

function detectSectionBanners(source) {
  const lines = source.split('\n');
  const banners = [];
  for (let i = 0; i < lines.length; i++) {
    const single = lines[i].match(SECTION_BANNER_SINGLE);
    if (single) {
      banners.push({ line: i + 1, name: single[1].trim() });
      continue;
    }
    if (i >= 1 && i + 1 < lines.length) {
      const above = lines[i - 1];
      const me    = lines[i];
      const below = lines[i + 1];
      if (BANNER_RULE_LINE.test(above) &&
          BANNER_RULE_LINE.test(below) &&
          BANNER_NAME_LINE.test(me)) {
        const m = me.match(BANNER_NAME_LINE);
        banners.push({ line: i + 2, name: m[1].trim() });
      }
    }
  }
  return banners;
}

function isBannerText(text) {
  // Test whether a chunk of comment text looks like a section banner.
  // Matches either a single-line decorated banner (// === FOO === or # === FOO ===)
  // or a three-line rule/name/rule banner.
  const lines = text.split('\n');
  // Single-line case: any one line matches the decorated single pattern.
  for (const line of lines) {
    if (SECTION_BANNER_SINGLE.test(line)) return true;
  }
  // Three-line case: at least one rule line above and below a name line.
  for (let i = 1; i < lines.length - 1; i++) {
    if (BANNER_RULE_LINE.test(lines[i - 1]) &&
        BANNER_RULE_LINE.test(lines[i + 1]) &&
        BANNER_NAME_LINE.test(lines[i]) &&
        !BANNER_RULE_LINE.test(lines[i])) {
      return true;
    }
  }
  return false;
}

function extractBannerTitle(text) {
  // Pull the title out of a banner-shaped comment_block. Returns '(section)' as fallback.
  const lines = text.split('\n');
  for (const line of lines) {
    const m1 = line.match(SECTION_BANNER_SINGLE);
    if (m1) return m1[1].trim();
  }
  for (let i = 1; i < lines.length - 1; i++) {
    if (BANNER_RULE_LINE.test(lines[i - 1]) &&
        BANNER_RULE_LINE.test(lines[i + 1]) &&
        BANNER_NAME_LINE.test(lines[i]) &&
        !BANNER_RULE_LINE.test(lines[i])) {
      const m = lines[i].match(BANNER_NAME_LINE);
      if (m) return m[1].trim();
    }
  }
  return '(section)';
}

function walkSegments(rootNode, source) {
  // Produces an ORDERED, GAPLESS list of segments covering every byte of source.
  // Inter-child gaps become explicit segments:
  //   - 'whitespace' if the gap contains only whitespace
  //   - 'comment_block' if the gap contains comment(s) (standalone, not inline-trailing)
  // Inline-trailing comments (comment on the same line a decl ends) attach to that decl.
  // Leading comments (immediately above a decl, no blank line between) attach to that decl,
  // EXCEPT when they form a banner (=== TITLE === style) — banners are kept standalone so
  // a later grouping pass can promote them to section_group parents.
  //
  // Invariant: concat(segments[i].text for i in range) === source
  //
  // The skeleton view in opSkeleton hides 'whitespace' segments by default.
  const out = [];
  const children = rootNode.namedChildren;
  let cursor = 0;                  // byte position we have accounted for
  let pending = [];                // leading comments awaiting a real decl
  const isComment = (n) => n.type === 'comment';

  function emitGap(fromByte, toByte) {
    if (fromByte >= toByte) return;
    const text = source.slice(fromByte, toByte);
    if (/^\s*$/.test(text)) {
      out.push({
        id: freshId(),
        kind: 'whitespace',
        name: '(blank)',
        startByte: fromByte,
        endByte: toByte,
        startLine: byteToLine(source, fromByte),
        endLine: byteToLine(source, toByte > fromByte ? toByte - 1 : fromByte),
      });
    } else {
      out.push({
        id: freshId(),
        kind: 'gap',
        name: '(gap)',
        startByte: fromByte,
        endByte: toByte,
        startLine: byteToLine(source, fromByte),
        endLine: byteToLine(source, toByte > fromByte ? toByte - 1 : fromByte),
      });
    }
  }

  function flushPendingAsCommentBlock() {
    if (pending.length === 0) return;
    const firstC = pending[0];
    const lastC = pending[pending.length - 1];
    if (cursor < firstC.startIndex) {
      emitGap(cursor, firstC.startIndex);
      cursor = firstC.startIndex;
    }
    out.push({
      id: freshId(),
      kind: 'comment_block',
      name: pending.length === 1 ? '(comment)' : `(${pending.length} comments)`,
      startByte: firstC.startIndex,
      endByte: lastC.endIndex,
      startLine: firstC.startPosition.row + 1,
      endLine: lastC.endPosition.row + 1,
    });
    cursor = lastC.endIndex;
    pending = [];
  }

  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (isComment(c)) {
      const last = out[out.length - 1];
      if (
        last && pending.length === 0 &&
        last.kind !== 'whitespace' && last.kind !== 'comment_block' && last.kind !== 'gap' &&
        c.startPosition.row + 1 === last.endLine
      ) {
        last.endByte = c.endIndex;
        cursor = c.endIndex;
        continue;
      }
      pending.push(c);
      continue;
    }

    const declStartLine = c.startPosition.row + 1;
    let leaders = [];
    while (pending.length > 0) {
      const tail = pending[pending.length - 1];
      const tailEndLine = tail.endPosition.row + 1;
      const nextStartLine = leaders.length > 0
        ? leaders[0].startPosition.row + 1
        : declStartLine;
      if (tailEndLine === nextStartLine - 1) {
        leaders.unshift(tail);
        pending.pop();
      } else {
        break;
      }
    }

    // Banner-aware leaders: if the candidate leaders form a banner shape, refuse
    // to take them. They go back to pending and will flush as a standalone
    // comment_block (the grouping pass promotes such blocks to section_groups).
    if (leaders.length > 0) {
      const combined = source.slice(leaders[0].startIndex, leaders[leaders.length - 1].endIndex);
      if (isBannerText(combined)) {
        // Push them back in order
        for (const l of leaders) pending.push(l);
        leaders = [];
      }
    }

    flushPendingAsCommentBlock();

    const leadStart = leaders.length > 0 ? leaders[0].startIndex : c.startIndex;
    const leadStartLine = leaders.length > 0 ? leaders[0].startPosition.row + 1 : c.startPosition.row + 1;

    if (cursor < leadStart) {
      emitGap(cursor, leadStart);
      cursor = leadStart;
    }

    const seg = {
      id: freshId(),
      kind: c.type,
      name: extractName(c),
      startByte: leadStart,
      endByte: c.endIndex,
      startLine: leadStartLine,
      endLine: c.endPosition.row + 1,
    };
    // Parse the inline JS body of an HTML <script> node and return JS segments
    // with byte/line offsets shifted to the script's position in the file.
    // tree-sitter-html emits script bodies as opaque raw_text, so without this
    // the JS is never segmented. Returns null for external (src=) / non-JS /
    // empty / unparseable scripts, leaving the script as an opaque leaf.
    const parseScriptJsChildren = (scriptNode) => {
      const startTag = scriptNode.namedChildren.find(n => n.type === 'start_tag');
      let scriptType = '';
      if (startTag) {
        for (const attr of startTag.namedChildren) {
          if (attr.type !== 'attribute') continue;
          const an = attr.namedChildren.find(n => n.type === 'attribute_name');
          if (!an) continue;
          const anName = an.text.toLowerCase();
          if (anName === 'src') return null;
          if (anName === 'type') {
            const av = attr.namedChildren.find(n => n.type === 'quoted_attribute_value' || n.type === 'attribute_value');
            if (av) scriptType = av.text.replace(/["']/g, '').toLowerCase();
          }
        }
      }
      const isJs = scriptType === '' || scriptType === 'text/javascript'
        || scriptType === 'module' || scriptType === 'application/javascript';
      if (!isJs) return null;
      const raw = scriptNode.namedChildren.find(n => n.type === 'raw_text');
      if (!raw || !raw.text || raw.text.trim().length === 0) return null;
      try {
        const jsParser = getParser('javascript');
        if (!jsParser) return null;
        const baseByte = raw.startIndex;
        const baseRow = raw.startPosition.row;
        const jsTree = jsParser.parse(raw.text);
        const jsSegs = walkSegments(jsTree.rootNode, raw.text);
        const shift = (arr) => {
          for (const s of arr) {
            s.startByte += baseByte;
            s.endByte += baseByte;
            if (typeof s.startLine === 'number') s.startLine += baseRow;
            if (typeof s.endLine === 'number') s.endLine += baseRow;
            if (s.children && s.children.length) shift(s.children);
          }
        };
        shift(jsSegs);
        return jsSegs.length > 0 ? jsSegs : null;
      } catch (e) {
        return null;
      }
    };
    // Python/JS class bodies → children
    if (c.type === 'class_definition' || c.type === 'class_declaration') {
      const body = c.childForFieldName('body');
      if (body) seg.children = walkClassBody(body, source);
    }
    // Large functions → sub-segment their bodies so the LLM can address inner blocks
    const LARGE_FN_THRESHOLD = 40;
    const isFnLike = [
      'function_declaration', 'function_definition', 'method_declaration',
      'method_definition', 'arrow_function',
    ].includes(c.type);
    if (isFnLike && !seg.children) {
      const lineSpan = (c.endPosition.row - c.startPosition.row) + 1;
      if (lineSpan > LARGE_FN_THRESHOLD) {
        const body = c.childForFieldName('body') || c.childForFieldName('block');
        if (body) seg.children = walkClassBody(body, source);
      }
    }
    // Large expression_statements with callbacks → break down the callback body
    // Handles: obj.addEventListener('event', function() { ... }), obj.on('x', () => { ... })
    if (c.type === 'expression_statement' && !seg.children) {
      const lineSpan = (c.endPosition.row - c.startPosition.row) + 1;
      if (lineSpan > LARGE_FN_THRESHOLD) {
        const findFnBody = (node, depth) => {
          if (depth > 5) return null;
          if (['function', 'function_expression', 'arrow_function'].includes(node.type)) {
            return node.childForFieldName('body') || node.childForFieldName('block');
          }
          for (const child of node.namedChildren) {
            const found = findFnBody(child, depth + 1);
            if (found) return found;
          }
          return null;
        };
        const fnBody = findFnBody(c, 0);
        if (fnBody) seg.children = walkClassBody(fnBody, source);
      }
    }
    // Large wrapper statements (guard if, loops, try, switch, decl wrappers)
    // -> sub-segment their block body so a file wholly wrapped in a single
    // `if(!loaded){...}` / loop / try doesn't collapse to one giant segment.
    // 40-line threshold keeps small wrappers atomic.
    if (!seg.children) {
      const WRAPPER_TYPES = new Set([
        'if_statement', 'for_statement', 'for_in_statement', 'while_statement',
        'do_statement', 'try_statement', 'switch_statement',
        'lexical_declaration', 'variable_declaration',
      ]);
      if (WRAPPER_TYPES.has(c.type)) {
        const wLineSpan = (c.endPosition.row - c.startPosition.row) + 1;
        if (wLineSpan > LARGE_FN_THRESHOLD) {
          const meaningfulW = (blk) => (blk.namedChildren || []).filter(k => k.type !== 'comment').length;
          const collectBlocksW = (node, depth, acc) => {
            if (!node || depth > 10) return acc;
            if (node.type === 'statement_block') acc.push(node);
            for (const k of (node.namedChildren || [])) collectBlocksW(k, depth + 1, acc);
            return acc;
          };
          const blocksW = collectBlocksW(c, 0, []);
          let chosenW = null;
          for (const b of blocksW) { if (meaningfulW(b) >= 2) { chosenW = b; break; } }
          if (chosenW) {
            const kidsW = walkClassBody(chosenW, source);
            if (kidsW && kidsW.length >= 2) seg.children = kidsW;
          }
        }
      }
    }
    if (c.type === 'decorated_definition') {
      const inner = c.namedChildren.find(n => n.type === 'class_definition');
      if (inner) {
        const body = inner.childForFieldName('body');
        if (body) seg.children = walkClassBody(body, source);
      }
    }
    // Top-level HTML <script> with inline JS → nest its JS segments.
    if (!seg.children && c.type === 'script_element') {
      const kids = parseScriptJsChildren(c);
      if (kids && kids.length > 0) seg.children = kids;
    }
    // HTML elements with child elements or inline <script> → children
    if (!seg.children && c.type === 'element') {
      const childNodes = c.namedChildren.filter(n => n.type === 'element' || n.type === 'script_element');
      if (childNodes.length > 0) {
        seg.children = childNodes.map(ch => {
          const childSeg = {
            id: freshId(),
            kind: ch.type,
            name: extractName(ch),
            startByte: ch.startIndex,
            endByte: ch.endIndex,
            startLine: ch.startPosition.row + 1,
            endLine: ch.endPosition.row + 1,
          };
          if (ch.type === 'script_element') {
            const kids = parseScriptJsChildren(ch);
            if (kids && kids.length > 0) childSeg.children = kids;
          } else {
            const nested = ch.namedChildren.filter(n => n.type === 'element' || n.type === 'script_element');
            if (nested.length > 0) {
              childSeg.children = nested.map(n => {
                const nSeg = {
                  id: freshId(),
                  kind: n.type,
                  name: extractName(n),
                  startByte: n.startIndex,
                  endByte: n.endIndex,
                  startLine: n.startPosition.row + 1,
                  endLine: n.endPosition.row + 1,
                };
                if (n.type === 'script_element') {
                  const k = parseScriptJsChildren(n);
                  if (k && k.length > 0) nSeg.children = k;
                }
                return nSeg;
              });
            }
          }
          return childSeg;
        });
      }
    }
    // CSS rule_set → children are declarations
    if (c.type === 'rule_set') {
      const block = c.children.find(n => n.type === 'block');
      if (block) {
        const decls = block.namedChildren.filter(n => n.type === 'declaration');
        if (decls.length > 0) {
          seg.children = decls.map(d => ({
            id: freshId(),
            kind: 'declaration',
            name: (() => {
              const prop = d.children.find(n => n.type === 'property_name');
              return prop ? prop.text : '(decl)';
            })(),
            startByte: d.startIndex,
            endByte: d.endIndex,
            startLine: d.startPosition.row + 1,
            endLine: d.endPosition.row + 1,
          }));
        }
      }
    }
    // CSS @media → children are nested rule_sets
    if (c.type === 'media_statement') {
      const block = c.children.find(n => n.type === 'block');
      if (block) {
        const rules = block.namedChildren.filter(n => n.type === 'rule_set');
        if (rules.length > 0) {
          seg.children = rules.map(r => ({
            id: freshId(),
            kind: r.type,
            name: extractName(r),
            startByte: r.startIndex,
            endByte: r.endIndex,
            startLine: r.startPosition.row + 1,
            endLine: r.endPosition.row + 1,
          }));
        }
      }
    }
    out.push(seg);
    cursor = c.endIndex;
  }

  flushPendingAsCommentBlock();
  if (cursor < source.length) {
    emitGap(cursor, source.length);
  }

  return out;
}

function byteToLine(source, byteIdx) {
  if (byteIdx <= 0) return 1;
  return source.slice(0, byteIdx).split('\n').length;
}

function walkClassBody(bodyNode, source) {
  // Mirror of walkSegments for class bodies. Same gap-aware and banner-aware behavior.
  const out = [];
  const children = bodyNode.namedChildren;
  let cursor = bodyNode.startIndex;
  let pending = [];
  const isComment = (n) => n.type === 'comment';

  function emitGap(fromByte, toByte) {
    if (fromByte >= toByte) return;
    const text = source.slice(fromByte, toByte);
    out.push({
      id: freshId(),
      kind: /^\s*$/.test(text) ? 'whitespace' : 'gap',
      name: '(blank)',
      startByte: fromByte,
      endByte: toByte,
      startLine: byteToLine(source, fromByte),
      endLine: byteToLine(source, toByte > fromByte ? toByte - 1 : fromByte),
    });
  }

  function flushPendingAsCommentBlock() {
    if (pending.length === 0) return;
    const firstC = pending[0];
    const lastC = pending[pending.length - 1];
    if (cursor < firstC.startIndex) {
      emitGap(cursor, firstC.startIndex);
      cursor = firstC.startIndex;
    }
    out.push({
      id: freshId(),
      kind: 'comment_block',
      name: pending.length === 1 ? '(comment)' : `(${pending.length} comments)`,
      startByte: firstC.startIndex,
      endByte: lastC.endIndex,
      startLine: firstC.startPosition.row + 1,
      endLine: lastC.endPosition.row + 1,
    });
    cursor = lastC.endIndex;
    pending = [];
  }

  for (const c of children) {
    if (isComment(c)) {
      const last = out[out.length - 1];
      if (
        last && pending.length === 0 &&
        last.kind !== 'whitespace' && last.kind !== 'comment_block' && last.kind !== 'gap' &&
        c.startPosition.row + 1 === last.endLine
      ) {
        last.endByte = c.endIndex;
        cursor = c.endIndex;
        continue;
      }
      pending.push(c);
      continue;
    }

    const declStartLine = c.startPosition.row + 1;
    let leaders = [];
    while (pending.length > 0) {
      const tail = pending[pending.length - 1];
      const tailEndLine = tail.endPosition.row + 1;
      const nextStartLine = leaders.length > 0
        ? leaders[0].startPosition.row + 1
        : declStartLine;
      if (tailEndLine === nextStartLine - 1) {
        leaders.unshift(tail);
        pending.pop();
      } else {
        break;
      }
    }

    // Banner-aware: refuse banner-shaped leaders so they stay standalone.
    if (leaders.length > 0) {
      const combined = source.slice(leaders[0].startIndex, leaders[leaders.length - 1].endIndex);
      if (isBannerText(combined)) {
        for (const l of leaders) pending.push(l);
        leaders = [];
      }
    }

    flushPendingAsCommentBlock();

    const leadStart = leaders.length > 0 ? leaders[0].startIndex : c.startIndex;
    const leadStartLine = leaders.length > 0 ? leaders[0].startPosition.row + 1 : c.startPosition.row + 1;

    if (cursor < leadStart) {
      emitGap(cursor, leadStart);
      cursor = leadStart;
    }

    const innerSeg = {
      id: freshId(),
      kind: c.type,
      name: extractName(c),
      startByte: leadStart,
      endByte: c.endIndex,
      startLine: leadStartLine,
      endLine: c.endPosition.row + 1,
    };
    // Large methods inside class bodies → recurse into their bodies too
    const LARGE_METHOD_THRESHOLD = 40;
    const isMethodLike = [
      'function_declaration', 'function_definition', 'method_declaration',
      'method_definition', 'arrow_function',
    ].includes(c.type);
    if (isMethodLike) {
      const lineSpan = (c.endPosition.row - c.startPosition.row) + 1;
      if (lineSpan > LARGE_METHOD_THRESHOLD) {
        const body = c.childForFieldName('body') || c.childForFieldName('block');
        if (body) innerSeg.children = walkClassBody(body, source);
      }
    }
    // Large expression_statements with callbacks → break down the callback body
    // Handles: obj.addEventListener('event', function() { ... }), obj.on('x', () => { ... })
    if (c.type === 'expression_statement' && !innerSeg.children) {
      const lineSpan = (c.endPosition.row - c.startPosition.row) + 1;
      if (lineSpan > LARGE_METHOD_THRESHOLD) {
        const findFnBody = (node, depth) => {
          if (depth > 5) return null;
          if (['function', 'function_expression', 'arrow_function'].includes(node.type)) {
            return node.childForFieldName('body') || node.childForFieldName('block');
          }
          for (const child of node.namedChildren) {
            const found = findFnBody(child, depth + 1);
            if (found) return found;
          }
          return null;
        };
        const fnBody = findFnBody(c, 0);
        if (fnBody) innerSeg.children = walkClassBody(fnBody, source);
      }
    }
    // Large wrapper statements (guard if, loops, try, switch, decl wrappers)
    // -> sub-segment their block body so a file wholly wrapped in a single
    // `if(!loaded){...}` / loop / try doesn't collapse to one giant segment.
    // 40-line threshold keeps small wrappers atomic.
    if (!innerSeg.children) {
      const WRAPPER_TYPES = new Set([
        'if_statement', 'for_statement', 'for_in_statement', 'while_statement',
        'do_statement', 'try_statement', 'switch_statement',
        'lexical_declaration', 'variable_declaration',
      ]);
      if (WRAPPER_TYPES.has(c.type)) {
        const wLineSpan = (c.endPosition.row - c.startPosition.row) + 1;
        if (wLineSpan > LARGE_METHOD_THRESHOLD) {
          const meaningfulW = (blk) => (blk.namedChildren || []).filter(k => k.type !== 'comment').length;
          const collectBlocksW = (node, depth, acc) => {
            if (!node || depth > 10) return acc;
            if (node.type === 'statement_block') acc.push(node);
            for (const k of (node.namedChildren || [])) collectBlocksW(k, depth + 1, acc);
            return acc;
          };
          const blocksW = collectBlocksW(c, 0, []);
          let chosenW = null;
          for (const b of blocksW) { if (meaningfulW(b) >= 2) { chosenW = b; break; } }
          if (chosenW) {
            const kidsW = walkClassBody(chosenW, source);
            if (kidsW && kidsW.length >= 2) innerSeg.children = kidsW;
          }
        }
      }
    }
    out.push(innerSeg);
    cursor = c.endIndex;
  }

  flushPendingAsCommentBlock();
  if (cursor < bodyNode.endIndex) {
    emitGap(cursor, bodyNode.endIndex);
  }

  return out;
}

function promoteBannerSections(segments, source) {
  // Post-process the flat segments list: any comment_block whose text matches
  // banner-shape (isBannerText) becomes a section_group parent. All subsequent
  // segments until the next banner (or end of array) become its children.
  //
  // Effect: banners gain hierarchical addressing (5.1, 5.2, ...), and operations
  // on the parent move the whole subtree atomically. Children are addressable
  // and editable individually.
  //
  // Byte-faithfulness preserved: section_group's [startByte, endByte] covers
  // banner + all children's bytes. assembleText walks top-level only, so the
  // group's text (which includes banner + children bytes via slice) is emitted.
  const out = [];
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.kind === 'comment_block') {
      const text = source.slice(seg.startByte, seg.endByte);
      if (isBannerText(text)) {
        const groupChildren = [];
        let j = i + 1;
        while (j < segments.length) {
          const next = segments[j];
          if (next.kind === 'comment_block' &&
              isBannerText(source.slice(next.startByte, next.endByte))) {
            break;
          }
          groupChildren.push(next);
          j++;
        }
        const lastByte = groupChildren.length > 0
          ? groupChildren[groupChildren.length - 1].endByte
          : seg.endByte;
        const lastLine = groupChildren.length > 0
          ? groupChildren[groupChildren.length - 1].endLine
          : seg.endLine;
        out.push({
          id: freshId(),
          kind: 'section_group',
          name: extractBannerTitle(text),
          startByte: seg.startByte,
          endByte: lastByte,
          startLine: seg.startLine,
          endLine: lastLine,
          children: groupChildren,
        });
        i = j;
        continue;
      }
    }
    out.push(seg);
    i++;
  }
  return out;
}

// ── Plain-text segmenter (no tree-sitter) ──────────────────────────────────
// Splits on blank lines. Detects heading patterns for named segments.
// Used for .txt, .md, .json, .yaml, .ini, .env, .toml, .log, .csv
//
// aiTitle is an optional injected async hook (segments, content) => void that
// can rename untitled paragraph segments. Defaults to a no-op so the worker is
// self-contained; read_file injects its ollama-backed titler for parity.
async function segmentPlainText(content, language, aiTitle) {
  const lines = content.split('\n');
  const segments = [];
  let chunkLines = [];
  let chunkStart = 0;
  let cursor = 0;

  function detectTitle(text) {
    const trimmed = text.trim();
    // Markdown heading
    const mdMatch = trimmed.match(/^#{1,6}\s+(.+)/);
    if (mdMatch) return mdMatch[1].trim();
    // ALL CAPS line (at least 4 chars, mostly uppercase)
    if (trimmed.length >= 4 && trimmed.length < 80
        && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) return trimmed;
    // Numbered section: "1.2.3 Title" or "Section 4:"
    const numMatch = trimmed.match(/^[\d.]+\s+(.+)/);
    if (numMatch) return numMatch[1].trim();
    // Underlined heading (next line is === or ---)
    return null;
  }

  function flushChunk() {
    if (chunkLines.length === 0) return;
    const text = chunkLines.join('\n');
    const startByte = getCharOffset(content, chunkStart);
    const endByte = startByte + text.length;
    const firstLine = chunkLines.find(l => l.trim().length > 0) || '';
    const detectedTitle = detectTitle(firstLine);
    const title = detectedTitle || firstLine.trim().slice(0, 60) || '(blank)';

    // Detect kind
    let kind = 'paragraph';
    const trimFirst = firstLine.trim();
    if (/^#{1,6}\s/.test(trimFirst)) kind = 'heading';
    else if (trimFirst === trimFirst.toUpperCase() && trimFirst.length >= 4 && /[A-Z]/.test(trimFirst)) kind = 'heading';
    else if (/^[\d.]+\s/.test(trimFirst)) kind = 'section';
    else if (/^[-*+]\s/.test(trimFirst) || /^\d+\.\s/.test(trimFirst)) kind = 'list';
    else if (trimFirst.startsWith('{') || trimFirst.startsWith('[')) kind = 'block';
    else if (trimFirst.includes(':') && trimFirst.indexOf(':') < 30 && language === 'yaml') kind = 'mapping';
    else if (trimFirst.startsWith('[') && language === 'ini') kind = 'section';
    else if (trimFirst.includes('=') && (language === 'env' || language === 'ini')) kind = 'assignment';
    else if (trimFirst.startsWith('```')) kind = 'code_block';
    else if (trimFirst.startsWith('---') || trimFirst.startsWith('===')) kind = 'separator';

    // Name: truncate title for readability
    let name = title.length > 60 ? title.slice(0, 57) + '...' : title;
    if (kind === 'heading') name = title;

    const seg = {
      id: freshId(),
      kind,
      name,
      startByte,
      endByte,
      startLine: chunkStart + 1,
      endLine: chunkStart + chunkLines.length,
    };
    if (!detectedTitle && kind === 'paragraph') {
      seg._needsAiTitle = true;
    }
    segments.push(seg);

    chunkLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlank = line.trim().length === 0;
    const isHeading = detectTitle(line) !== null;

    // Check for underline heading pattern: previous line text, current line === or ---
    const isUnderline = /^[=-]{3,}\s*$/.test(line.trim()) && chunkLines.length > 0;

    if (isBlank && chunkLines.length > 0) {
      // Blank line after content = end of chunk
      flushChunk();
      chunkStart = i + 1;
    } else if (isHeading && chunkLines.length > 0 && !isUnderline) {
      // New heading starts a new chunk (flush previous)
      flushChunk();
      chunkStart = i;
      chunkLines.push(line);
    } else if (!isBlank) {
      if (chunkLines.length === 0) chunkStart = i;
      chunkLines.push(line);
    }
  }
  flushChunk();

  // AI-title paragraphs that have no detected heading (optional, injected)
  if (typeof aiTitle === 'function') {
    await aiTitle(segments, content);
  }

  return { segments, hasParseErrors: false };
}

function getCharOffset(content, lineIndex) {
  // Get byte offset of a line index in content
  let byte = 0;
  const lines = content.split('\n');
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    byte += lines[i].length + 1; // +1 for \n
  }
  return byte;
}

// MAIN ENTRY. Identical contract to read_file's original segmentFile, plus an
// optional aiTitle hook forwarded to the plaintext path.
async function segmentFile(filePath, content, language, aiTitle) {
  // Config files (nginx, systemd, YAML, JSON, sshd_config, fstab, ...) get
  // structure-aware segments instead of the blank-line paragraph splitter.
  const cfgFlavor = detectConfigFlavor(filePath, content, language);
  if (cfgFlavor) {
    const r = segmentConfig(content, cfgFlavor, freshId);
    return { segments: r.segments, hasParseErrors: r.hasParseErrors, structureErrors: r.structureErrors, configFlavor: cfgFlavor };
  }
  // Plain text languages bypass tree-sitter
  if (['plaintext', 'markdown', 'json', 'yaml', 'toml', 'ini', 'env'].includes(language)) {
    return await segmentPlainText(content, language, aiTitle);
  }
  const parser = getParser(language);
  if (!parser) {
    // Code language with no tree-sitter parser — not supported for editing.
    // Throw so the caller surfaces a clear error rather than silently mangling the file.
    throw new Error(`No tree-sitter parser available for language: ${language}. Read-only access via raw file path instead.`);
  }
  const tree = parser.parse(content);
  const flat = walkSegments(tree.rootNode, content);
  const segs = promoteBannerSections(flat, content);
  return { segments: segs, hasParseErrors: tree.rootNode.hasError };
}

// Reset the segment-id counter. read_file resets per buffer-open so ids are
// stable/deterministic per parse; expose it so callers can match that behavior.
// Parse a file ONCE and hand back the raw tree-sitter tree + rootNode. This is
// the shared-parse hook for the boss/worker unification: a caller (e.g. the
// architect scan) can run its own analysis walkers (walkTopLevel/walkImports/
// etc.) over this rootNode instead of parsing the file a second time. Returns
// { tree, rootNode, hasParseErrors } or { tree:null, ... } for plaintext langs
// (which have no tree-sitter parser).
function parseTree(content, language) {
  if (['plaintext', 'markdown', 'json', 'yaml', 'toml', 'ini', 'env'].includes(language)) {
    return { tree: null, rootNode: null, hasParseErrors: false, plaintext: true };
  }
  const parser = getParser(language);
  if (!parser) {
    throw new Error(`No tree-sitter parser available for language: ${language}.`);
  }
  const tree = parser.parse(content);
  return { tree, rootNode: tree.rootNode, hasParseErrors: tree.rootNode.hasError };
}

function resetSegIds() { _segId = 0; }

export {
  segmentFile,
  parseTree,
  segmentPlainText,
  walkSegments,
  walkClassBody,
  promoteBannerSections,
  extractName,
  isBannerText,
  extractBannerTitle,
  getParser,
  freshId,
  resetSegIds,
};
