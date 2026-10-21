/**
 * Metal Shading Language grammar for tree-sitter (Itamos, Oct 2026).
 * Metal is based on C++14, so this extends the C++ grammar (the same way tree-sitter-cuda
 * does) with Metal's function kinds and address spaces. Metal attributes such as
 * [[buffer(0)]] and [[thread_position_in_grid]] are already C++ attribute syntax.
 */
const CPP = require("tree-sitter-cpp/grammar")

module.exports = grammar(CPP, {
    name: 'metal',

    rules: {
        _top_level_item: (_, original) => original,

        // function kinds: kernel void f(...), vertex VOut v(...), fragment float4 f(...), ...
        _declaration_modifiers: ($, original) =>
            choice(
                // only these three are keywords; [[visible]], [[stitchable]], [[object]],
                // [[mesh]] and [[intersection(...)]] are attributes (already C++ syntax)
                prec(10, choice(
                    'kernel',
                    'vertex',
                    'fragment',
                )),
                original
            ),

        // address spaces: device const float* a, constant Uniforms& u, threadgroup float t[64], ...
        type_qualifier: (_, original) => choice(
            original,
            'device',
            'constant',
            'threadgroup',
            'thread',
            'threadgroup_imageblock',
            'ray_data',
            'object_data',
        ),
    }
});
