#!/usr/bin/env bash
# Rebuild the three plus grammars with the default rule groups (new folders under builds/,
# the live ones are not touched until the node_modules link switches) and check each
# against its stock grammar on the corpus.
set -u
G=/tank/projects/mcp-sandbox-public/grammars
CPP=/tank/projects/mcp-sandbox-server/node_modules/tree-sitter-cpp
CU=$G/node_modules/tree-sitter-cuda
ME=$G/tree-sitter-metal
C=/home/bncs/compare_plus.mjs
R=/tank/experiments/pytorch-cuda13
cd $G/plus
echo "=== cpp_plus";   python3 generate_loop.py cpp_plus   $CPP/grammar.js $CPP/src/scanner.c 2>&1 | tail -2
echo "=== cuda_plus";  python3 generate_loop.py cuda_plus  $CU/grammar.js  $CU/src/scanner.c  2>&1 | tail -2
echo "=== metal_plus"; python3 generate_loop.py metal_plus $ME/grammar.js  $ME/src/scanner.c  2>&1 | tail -2
ls -la $G/node_modules | grep plus
echo "=== compare cpp";  node $C $R 900 tree-sitter-cpp  tree-sitter-cpp-plus  .cpp,.cc,.hpp,.h runtime 2>&1 | head -12
echo "=== compare cuda"; node $C $R 900 tree-sitter-cuda tree-sitter-cuda-plus .cu,.cuh 2>&1 | head -12
echo BUILD_ALL_DONE
