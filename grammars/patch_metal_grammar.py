"""tree-sitter-metal: only kernel / vertex / fragment are function keywords in Metal; object,
mesh, intersection, visible and stitchable are written as attributes ([[object]] ...), which
the C++ grammar already parses, and as keywords they broke variables named e.g. 'object'."""
import os
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tree-sitter-metal", "grammar.js")
s = open(P).read()
old = """                prec(10, choice(
                    'kernel',
                    'vertex',
                    'fragment',
                    'visible',
                    'stitchable',
                    'object',
                    'mesh',
                    'intersection',
                )),"""
new = """                // only these three are keywords; [[visible]], [[stitchable]], [[object]],
                // [[mesh]] and [[intersection(...)]] are attributes (already C++ syntax)
                prec(10, choice(
                    'kernel',
                    'vertex',
                    'fragment',
                )),"""
assert s.count(old) == 1
open(P, "w").write(s.replace(old, new))
print("patched grammar.js")
