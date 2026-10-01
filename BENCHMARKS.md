# Benchmarks

This document describes the benchmark methodology and results comparing MCP-tool-assisted navigation against raw shell access across a range of model sizes.

---

## Motivation

The central claim of these tools is that structured codebase navigation produces better results with fewer tokens than raw file access. This document measures that claim against standard benchmarks using publicly available models run on local hardware.

---

## Methodology

### Two conditions

Every task is run twice with the same model.

Round 1 (MCP tools): the model has access to master_architect, read_file, write_file, git, and web_skeleton. It must navigate to the relevant code using the tool hierarchy before producing an answer.

Round 2 (raw shell): the model has access to run_cmd (bash) only. It uses find, grep, cat, and git to explore the codebase before producing an answer.

Same task, same model, same scoring. The delta between conditions is the effect of the tools.

### Metrics

- Accuracy: exact match, partial match, or pass rate depending on the suite
- Input tokens: total tokens consumed across all turns in the agentic loop
- Tool calls: number of tool invocations before the model produced its answer
- Elapsed time: wall-clock milliseconds

### Hardware

All local runs: AMD MI50 (16GB HBM2), Vulkan backend, llama.cpp build b9436.
Large model runs: rented Blackwell B6000 pod, same llama.cpp build.

---

## Benchmark suites

### RepoBench (cross-file retrieval)

Dataset: tianyang/repobench_python_v1.1, splits cross_file_first and cross_file_random.
Task: given a file with its imports and code up to a certain point, predict the next line. The gold next line requires understanding of cross-file context.
Scoring: exact match and partial match of the predicted next line against ground truth.

### RepoExec (function completion)

Dataset: Fsoft-AIC/RepoExec, split small_context.
Task: implement a function given its signature and docstring. Correct implementation requires understanding of cross-file dependencies.
Scoring: execution pass rate.

### SWE-bench Lite (bug fix)

Dataset: princeton-nlp/SWE-bench_Lite, 50-task subset covering psf/requests, pallets/flask, mwaskom/seaborn.
Task: given a GitHub issue description and a repository at a specific commit, produce a patch that fixes the bug.
Scoring: patch validity at first publication. Full test harness scoring to follow.

---

## Models tested

| # | Model | Size | Type | Coding tier |
|---|-------|------|------|-------------|
| 1 | Qwen3 4B | 4B | Dense | mid |
| 2 | LFM 2.5 8B | 8B | MoE | mid |
| 3 | Qwen3 8B | 8B | Dense | mid |
| 4 | Nemotron Nano 9B v2 | 9B | Dense | mid |
| 5 | Ornith 1.5 9B | 9B | Dense | mid |
| 6 | Qwen3.5 9B | 9B | Dense | mid |
| 7 | Gemma 4 12B | 12B | Dense | weak |
| 8 | Qwen2.5-Coder 14B | 14B | Dense | strong |
| 9 | Qwen3 14B | 14B | Dense | strong |
| 10 | Qwen3.6 27B | 27B | Dense | strong |
| 11 | Qwen3.8 27B | 27B | Dense | strong |
| 12 | Nemotron Nano 30B | 30B | MoE | strong |
| 13 | Qwen3 30B MoE | 30B | MoE | strong |
| 14 | Gemma 4 31B | 31B | Dense | mid |
| 15 | Qwen3.6 35B (Opus distilled) | 35B | MoE | strong |

Models 1 to 9 run locally on MI50. Models 10 to 15 run on a rented Blackwell B6000 pod.

---

## Results

(Populating as runs complete)

### RepoBench cross_file_first

| Model | MCP exact% | Raw exact% | MCP tokens | Raw tokens | Token saving |
|-------|-----------|-----------|-----------|-----------|-------------|
| Qwen3 4B | — | — | — | — | — |
| Qwen3 8B | — | — | — | — | — |
| Qwen2.5-Coder 14B | — | — | — | — | — |

### RepoBench cross_file_random

| Model | MCP exact% | Raw exact% | MCP tokens | Raw tokens | Token saving |
|-------|-----------|-----------|-----------|-----------|-------------|
| Qwen3 4B | — | — | — | — | — |

### RepoExec small_context

| Model | MCP pass% | Raw pass% | MCP tokens | Raw tokens | Token saving |
|-------|----------|----------|-----------|-----------|-------------|
| Qwen3 4B | — | — | — | — | — |

### SWE-bench Lite (50 tasks)

| Model | MCP patch valid% | Raw patch valid% | MCP tokens | Raw tokens | Token saving |
|-------|-----------------|-----------------|-----------|-----------|-------------|
| Qwen3 4B | — | — | — | — | — |

---

## Running the benchmarks yourself

Clone the repo, start the sandbox server, then run the harness from the benchmarks directory.
Results are saved as JSON. The compare script prints a summary table and delta between conditions.
