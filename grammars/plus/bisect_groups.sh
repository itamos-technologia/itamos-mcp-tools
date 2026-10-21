#!/usr/bin/env bash
# Build cpp_plus with one rule group at a time (E1..E4) and compare each with the stock
# C++ grammar on the corpus, to see which group changes trees of code that already parsed.
set -u
G=/tank/projects/mcp-sandbox-public/grammars
CPP=/tank/projects/mcp-sandbox-server/node_modules/tree-sitter-cpp
cd $G/plus
for g in ${PLUS_GROUPS:-E1 E2 E3 E4}; do      # (not GROUPS: bash's own variable)
  lg=$(echo $g | tr 'A-Z,' 'a-z_')
  echo "=== $g"
  PLUS_ONLY=$g python3 generate_loop.py cpp_plus_$lg $CPP/grammar.js $CPP/src/scanner.c 2>&1 | tail -3
  node /home/bncs/compare_plus.mjs /tank/experiments/pytorch-cuda13 900 tree-sitter-cpp tree-sitter-cpp-plus-${lg//_/-} .cpp,.cc,.hpp,.h runtime 2>&1 | head -8
done
echo BISECT_DONE
