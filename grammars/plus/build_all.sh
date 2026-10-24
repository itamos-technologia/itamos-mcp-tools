#!/usr/bin/env bash
# Build the three plus grammars (rules E1-E3 by default) and check each against its stock
# grammar on the corpus: every file the stock grammar parses must keep the identical tree.
set -u
G="$(cd "$(dirname "$0")/.." && pwd)"
CPP=/tank/projects/mcp-sandbox-server/node_modules/tree-sitter-cpp
CU=$G/node_modules/tree-sitter-cuda
ME=$G/tree-sitter-metal
C=/home/bncs/compare_plus.mjs
R=/tank/experiments/pytorch-cuda13
cd $G/plus
rm -rf $G/tree-sitter-cpp-plus-e1 $G/tree-sitter-cpp-plus-e2 $G/tree-sitter-cpp-plus-e3 $G/tree-sitter-cpp-plus-e4 \
       $G/node_modules/tree-sitter-cpp-plus-e1 $G/node_modules/tree-sitter-cpp-plus-e2 \
       $G/node_modules/tree-sitter-cpp-plus-e3 $G/node_modules/tree-sitter-cpp-plus-e4
echo "=== cpp_plus";   python3 generate_loop.py cpp_plus   $CPP/grammar.js $CPP/src/scanner.c 2>&1 | tail -2
echo "=== cuda_plus";  python3 generate_loop.py cuda_plus  $CU/grammar.js  $CU/src/scanner.c  2>&1 | tail -2
echo "=== metal_plus"; python3 generate_loop.py metal_plus $ME/grammar.js  $ME/src/scanner.c  2>&1 | tail -2
echo "=== compare cpp";  node $C $R 900 tree-sitter-cpp  tree-sitter-cpp-plus  .cpp,.cc,.hpp,.h runtime 2>&1 | head -9
echo "=== compare cuda"; node $C $R 900 tree-sitter-cuda tree-sitter-cuda-plus .cu,.cuh 2>&1 | head -9
echo BUILD_ALL_DONE
