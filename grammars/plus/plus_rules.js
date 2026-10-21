// =============================================================================
// "plus" rules for the C++-based grammars (tree-sitter-cpp, -cuda, -metal)
// =============================================================================
// Real C++ the stock grammar turns into ERROR nodes. Each rule here only ADDS what the stock
// grammar rejects, so code it already parses keeps the very same tree (the build checks
// this on a corpus before anything is used). Found by parsing 600 PyTorch / cutlass /
// composable_kernel / oneTBB files after the macro-aware pass (lib/macro_mask.js).
//
//   E1  void f(bool_constant<x> = {})     braced default argument, unnamed parameter
//       void f(int* = nullptr)            abstract (pointer) declarator with a default
//   E2  size(typename T::TiledMma{})      typename-qualified type used as a value
//       x = typename T::Stride()
//   E3  using v = T __attribute__((ext_vector_type(N)));   attribute inside a type-id
//   E4  body_types<R (T::*)(const In&) const>              pointer-to-member types
//
// Usage (in a grammar.js):  module.exports = grammar(BASE, { name, ...require('./plus_rules')() })

// only: '' = every group, or a comma list such as 'E1,E3' (for checking groups one by one)
module.exports = function plusRules(only = '') {
  // default: E1-E3, E5-E9 (each checked: identical trees on the 495 stock-clean files, see
  // bisect.log, bisect2.log, bisect3.log). E4 (pointer-to-member anywhere) is NOT on by default:
  // it changed the tree of 13 of 495 files (e.g. broke `delete[] p;`); E6 covers its usual case.
  const want = new Set((only || 'E1,E2,E3,E5,E6,E7,E8,E9').split(',').map(s => s.trim()).filter(Boolean));
  const groups = {
    E1: {
      optional_parameter_declaration: $ => seq(
        $._declaration_specifiers,
        field('declarator', optional(choice($._declarator, $._abstract_declarator))),
        '=',
        field('default_value', choice($.expression, $.initializer_list)),
      ),
    },
    E2: {
      expression: ($, original) => choice(original, $.typename_value_expression),
      typename_value_expression: $ => prec.dynamic(-1, seq(
        'typename',
        field('type', choice(
          alias($.qualified_type_identifier, $.qualified_identifier),
          $.template_type,
        )),
        field('arguments', choice($.argument_list, $.initializer_list)),
      )),
    },
    E3: {
      type_descriptor: $ => prec.right(seq(
        repeat($.type_qualifier),
        field('type', $.type_specifier),
        repeat(choice($.type_qualifier, $.attribute_specifier)),
        field('declarator', optional($._abstract_declarator)),
      )),
    },
    // E4 (off by default): pointer-to-member anywhere in an abstract declarator
    E4: {
      _abstract_declarator: ($, original) => choice(original, $.abstract_member_pointer_declarator),
      abstract_member_pointer_declarator: $ => prec.dynamic(1, prec.right(seq(
        repeat1($._scope_resolution),
        '*',
        repeat($.type_qualifier),
        field('declarator', optional($._abstract_declarator)),
      ))),
    },
    // E5  extern template void f<int>(int);   (explicit instantiation declaration)
    E5: {
      template_instantiation: ($, original) => seq(optional('extern'), original),
    },
    // E6  R (T::*)(Args) const   pointer-to-member, only in its usual place: inside ( )
    E6: {
      abstract_parenthesized_declarator: ($, original) => choice(
        original,
        prec(1, seq('(', $.abstract_member_pointer_declarator, ')')),
      ),
      abstract_member_pointer_declarator: $ => seq(
        repeat1($._scope_resolution),
        '*',
        repeat($.type_qualifier),
        field('declarator', optional($._abstract_declarator)),
      ),
    },
    // E7  decltype(make_desc()){}   compound literal of a decltype type
    E7: {
      compound_literal_expression: ($, original) => choice(
        original,
        seq(field('type', $.decltype), field('value', $.initializer_list)),
      ),
    },
  };
  // E8  enable_if<N >= 1 && N <= 3>   '>=' inside template arguments: the stock lexer takes
  //     the '>' as the end of the argument list; this '>=' token wins (same node, same text)
  groups.E8 = {
    binary_expression: ($, original) => choice(
      original,
      prec.left(7, seq(
        field('left', $.expression),
        field('operator', alias(token(prec(2, '>=')), '>=')),
        field('right', $.expression),
      )),
    ),
  };
  // E9  decltype(typename A::Arguments(), void())   comma expression inside decltype
  groups.E9 = {
    decltype: ($, original) => choice(original, seq('decltype', '(', $.comma_expression, ')')),
  };
  const rules = {};
  for (const [g, r] of Object.entries(groups)) if (!want || want.has(g)) Object.assign(rules, r);
  return rules;
};
