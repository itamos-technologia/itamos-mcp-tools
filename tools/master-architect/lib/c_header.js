// =============================================================================
// .h files: C or C++?
// =============================================================================
// The extension says nothing, so the content decides. Comments and string literals are
// removed first, and so is everything inside #ifdef __cplusplus / #if defined(__cplusplus)
// blocks (C headers wrap their extern "C" { } or a C++ convenience API in those). One
// C++-only construct anywhere else makes the header C++:
//   namespace X {, template <, class X { / class X : , public: / private: / protected:,
//   std::, using namespace, nullptr, constexpr, noexcept, virtual, operator overloads,
//   #include of a C++ standard header without .h (<vector>, <string>, <memory>, ...)
// Used by read_file (which check runs: gcc -x c or g++ -x c++, which grammar parses) and by
// the architect registry (which analyser runs).
import { readFileSync } from 'fs';

const SNIFF_BYTES = 256 * 1024;

const CPP_STD_HEADERS = new Set([
  'algorithm', 'any', 'array', 'atomic', 'bitset', 'chrono', 'codecvt', 'complex', 'concepts',
  'condition_variable', 'deque', 'exception', 'filesystem', 'forward_list', 'fstream', 'functional',
  'future', 'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'iterator',
  'limits', 'list', 'locale', 'map', 'memory', 'mutex', 'new', 'numeric', 'optional', 'ostream',
  'queue', 'random', 'ranges', 'ratio', 'regex', 'set', 'shared_mutex', 'span', 'sstream', 'stack',
  'stdexcept', 'streambuf', 'string', 'string_view', 'system_error', 'thread', 'tuple',
  'type_traits', 'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray',
  'variant', 'vector', 'cstdint', 'cstddef', 'cstdlib', 'cstdio', 'cstring', 'cmath', 'cassert',
  'climits', 'cfloat', 'cctype', 'cerrno', 'ctime', 'cinttypes', 'cstdarg', 'csignal',
]);

const CPP_SIGNALS = [
  /\bnamespace\s+[A-Za-z_][\w:]*\s*\{/,
  /\bnamespace\s*\{/,
  /\btemplate\s*</,
  /\bclass\s+[A-Za-z_]\w*\s*(final\s*)?(:[^:;{]*)?\{/,     // class X {  /  class X : public Y {
  /\bstruct\s+[A-Za-z_]\w*\s*(final\s*)?:[^:;{]*\{/,        // struct X : Y {  (plain struct X { is C)
  /\bclass\s+[A-Za-z_]\w*\s*;/,                              // forward-declared class
  /^\s*(public|private|protected)\s*:/m,
  /\bstd::/,
  /\busing\s+namespace\b/,
  /\busing\s+[A-Za-z_]\w*\s*=/,
  /\bnoexcept\b/,
  /\bvirtual\s+[\w~]/,
  /\boperator\s*(\(\)|\[\]|[-+*\/%^&|~!=<>]+|new\b|delete\b)\s*\(/,
  /\bstatic_cast\s*</, /\breinterpret_cast\s*</, /\bdynamic_cast\s*</,
  // not used alone: constexpr / nullptr / bool / true (also C23)
];

// remove comments and string / char literals in one left-to-right pass (so "/*" inside a
// string or // inside a comment cannot confuse it), keeping line structure
function stripCommentsAndStrings(src) {
  return src.replace(/\/\*[\s\S]*?(\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => {
    if (m[0] === '"') return '""';
    if (m[0] === "'") return "''";
    return m.replace(/[^\n]/g, ' ');
  });
}

// drop the C++-only branches of __cplusplus conditionals:
//   #ifdef __cplusplus / #if defined(__cplusplus) ...  -> the #if branch is C++
//   #ifndef __cplusplus / #if !defined(__cplusplus) ... -> the #else branch is C++
// (an #elif of such a block is treated like #else)
function dropCplusplusBlocks(src) {
  const out = [];
  const stack = [];                 // per open #if: { cpp: about __cplusplus, skip: in its C++ branch }
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (/^#\s*if/.test(t)) {
      const cpp = /\b__cplusplus\b/.test(t);
      const negated = /^#\s*ifndef\b/.test(t) || /!\s*(defined\s*\(?\s*)?__cplusplus\b/.test(t);
      stack.push({ cpp, skip: cpp && !negated });
      continue;
    }
    if (/^#\s*(else|elif)\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top && top.cpp) top.skip = !top.skip;
      continue;
    }
    if (/^#\s*endif\b/.test(t)) { stack.pop(); continue; }
    if (stack.some((f) => f.skip)) continue;
    out.push(line);
  }
  return out.join('\n');
}

// The first C++ construct found, as { line, why }, or null for a C header
export function headerCppEvidence(content) {
  const text = dropCplusplusBlocks(stripCommentsAndStrings(String(content).slice(0, SNIFF_BYTES)));
  for (const m of text.matchAll(/^\s*#\s*include\s*<([\w/]+)>/gm)) {
    if (CPP_STD_HEADERS.has(m[1])) return { line: m[0].trim(), why: 'C++ standard header' };
  }
  for (const re of CPP_SIGNALS) {
    const m = text.match(re);
    if (m) {
      const at = text.lastIndexOf('\n', m.index) + 1;
      return { line: text.slice(at, text.indexOf('\n', m.index) >>> 0 || undefined).trim().slice(0, 120), why: String(re) };
    }
  }
  return null;
}

// 'cpp' when the header's content is C++, otherwise 'c'
export function headerLanguageFromContent(content) {
  return headerCppEvidence(content) ? 'cpp' : 'c';
}

// For a .h path (content optional: read from disk when not given). Other paths -> null.
export function cHeaderLanguage(filePath, content) {
  if (!/\.h$/i.test(String(filePath))) return null;
  if (content == null) {
    try { content = readFileSync(filePath, 'utf8'); } catch { return 'c'; }   // new file: C until it says otherwise
  }
  return headerLanguageFromContent(content);
}

// Dialect files, parsed with that dialect's grammar (lib/dialect_grammars.js):
//   'objc' — .h with @interface / @protocol / @implementation / @class
//   'cuda' — .h / .hpp / .hh / .hxx / .inl / .cpp / .cc / .cxx with CUDA / HIP keywords used
//            directly (__global__, __device__, __host__, __shared__) or a kernel launch
//            (name<<<grid, block>>>(...)) — e.g. composable_kernel's HIP .hpp files
// else null. (Macros such as C10_HOST_DEVICE hide the keywords: those stay plain C++.)
const CUDA_CAPABLE = /\.(h|hh|hpp|hxx|inl|cpp|cc|cxx)$/i;
export function headerDialect(filePath, content) {
  const fp = String(filePath);
  if (!CUDA_CAPABLE.test(fp)) return null;
  if (content == null) {
    try { content = readFileSync(filePath, 'utf8'); } catch { return null; }
  }
  const text = stripCommentsAndStrings(String(content).slice(0, SNIFF_BYTES));
  if (/\.h$/i.test(fp) && /^\s*@(interface|protocol|implementation|class)\b/m.test(text)) return 'objc';
  const code = text.replace(/^\s*#[^\n]*(\\\n[^\n]*)*/gm, '');   // not in #define bodies
  if (/(^|[^\w#])__(global|device|host|shared)__\b/.test(code) || /\w\s*<<<[^;]*>>>\s*\(/.test(code)) return 'cuda';
  return null;
}

