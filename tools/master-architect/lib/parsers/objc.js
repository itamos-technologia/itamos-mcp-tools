// =============================================================================
// Objective-C containers for the C and C++ analysers (c.js, cpp.js)
// =============================================================================
// .m and .mm files are registered as c / cpp but parse with the Objective-C grammar
// (lib/dialect_grammars.js), so their trees carry @interface / @implementation /
// @protocol nodes next to the plain C ones. walkObjc records those; plain C / C++
// trees never contain these node types, so for them it changes nothing.
//   @interface Greeter         -> { kind: 'interface', name: 'Greeter' }
//   @interface Greeter (Extra) -> { kind: 'interface', name: 'Greeter (Extra)' }
//   @implementation Greeter    -> { kind: 'class',     name: 'Greeter' }
//   @protocol Speaker          -> { kind: 'protocol',  name: 'Speaker' }
//   - (void)greet:(id)w times:(int)n { ... } in @implementation Greeter
//                              -> { kind: 'method',    name: '-[Greeter greet:times:]' }

const CONTAINERS = {
  class_interface: 'interface',
  category_interface: 'interface',
  class_implementation: 'class',
  category_implementation: 'class',
  protocol_declaration: 'protocol',
};

const nodeLine = (n) => n.startPosition.row + 1;
const nodeLineEnd = (n) => n.endPosition.row + 1;

// greet:times: (keyword identifiers, ':' per parameter) and the sign '-' / '+'
function selector(method) {
  let sign = '-';
  let sel = '';
  for (let i = 0; i < method.childCount; i++) {
    const k = method.child(i);
    if (!k.isNamed && (k.type === '-' || k.type === '+') && !sel) sign = k.type;
    else if (k.type === 'identifier') sel += k.text;
    else if (k.type === 'method_parameter') sel += ':';
  }
  return sel ? { sign, sel } : null;
}

// Returns true when node was an Objective-C container (recorded), false otherwise.
export function walkObjc(node, analysis) {
  const kind = CONTAINERS[node.type];
  if (!kind) return false;
  const id = node.namedChildren.find(k => k.type === 'identifier');
  const cat = node.childForFieldName('category');
  const base = id ? id.text : '(anonymous)';
  analysis.modules.push({
    kind,
    name: cat ? `${base} (${cat.text})` : base,
    line: nodeLine(node),
    line_end: nodeLineEnd(node),
  });
  if (kind !== 'class') return true;              // interfaces / protocols only declare methods
  for (const child of node.namedChildren) {
    const m = child.type === 'implementation_definition'
      ? child.namedChildren.find(k => k.type === 'method_definition')
      : (child.type === 'method_definition' ? child : null);
    if (!m) continue;
    const s = selector(m);
    if (!s) continue;
    analysis.modules.push({
      kind: 'method',
      name: `${s.sign}[${cat ? `${base}(${cat.text})` : base} ${s.sel}]`,
      line: nodeLine(m),
      line_end: nodeLineEnd(m),
    });
  }
  return true;
}
