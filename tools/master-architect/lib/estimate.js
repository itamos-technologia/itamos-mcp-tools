/**
 * Estimate a scan's size and duration without actually parsing.
 *
 * Walks the directory tree, classifies each file by extension, returns
 * counts per category and a heuristic time estimate. Does NOT open files
 * or invoke parsers — runs in seconds even for very large codebases.
 *
 * Heuristic timings (measured on Monster, EPYC 7551, NVMe):
 *   supported:   ~30 ms per file (read + tree-sitter parse + DB inserts)
 *   coming_soon: ~5  ms per file (read for line count + DB insert)
 *   opaque_text: ~5  ms per file (same)
 *   opaque_binary: ~2 ms per file (stat only, no read)
 */

import fs from 'fs';
import path from 'path';
import { detectLanguage, isIgnoredDir, isIgnoredFile } from './registry.js';

const TIMING_MS = {
  supported:     30,
  coming_soon:    5,
  opaque_text:    5,
  opaque_binary:  2,
};

const LARGE_THRESHOLD = 1000;   // files
const HUGE_THRESHOLD  = 5000;

export function estimateScan(rootPath) {
  rootPath = path.resolve(rootPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }

  const counts = {
    supported: 0, coming_soon: 0, opaque_text: 0, opaque_binary: 0,
    skipped_unrecognized: 0, skipped_ignored_dir: 0, skipped_ignored_file: 0,
  };
  const byLanguage = {};
  let totalDirectories = 0;

  function recurse(absDir, isRoot = false) {
    if (!isRoot) {
      const dirName = path.basename(absDir);
      if (isIgnoredDir(dirName, absDir)) {
        counts.skipped_ignored_dir += 1;
        return;
      }
    }
    totalDirectories += 1;

    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const entryAbs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        recurse(entryAbs, false);
      } else if (entry.isFile()) {
        if (isIgnoredFile(entry.name)) {
          counts.skipped_ignored_file += 1;
          continue;
        }
        const detection = detectLanguage(entry.name);
        if (detection.kind === 'unrecognized') {
          counts.skipped_unrecognized += 1;
          continue;
        }
        let category;
        if (detection.kind === 'supported')        category = 'supported';
        else if (detection.kind === 'coming_soon') category = 'coming_soon';
        else if (detection.kind === 'opaque')      category = detection.isBinary ? 'opaque_binary' : 'opaque_text';
        counts[category] += 1;
        byLanguage[detection.language] = (byLanguage[detection.language] || 0) + 1;
      }
    }
  }

  const startMs = Date.now();
  recurse(rootPath, true);
  const walkDurationMs = Date.now() - startMs;

  const filesTotal = counts.supported + counts.coming_soon + counts.opaque_text + counts.opaque_binary;
  const estDurationMs =
      counts.supported     * TIMING_MS.supported
    + counts.coming_soon   * TIMING_MS.coming_soon
    + counts.opaque_text   * TIMING_MS.opaque_text
    + counts.opaque_binary * TIMING_MS.opaque_binary;

  let warning = null;
  if (filesTotal >= HUGE_THRESHOLD) {
    warning = `Very large scan (${filesTotal.toLocaleString()} files). Estimated ${Math.round(estDurationMs/1000)}s. Consider scanning a subdirectory if you only need part of the project.`;
  } else if (filesTotal >= LARGE_THRESHOLD) {
    warning = `Large scan (${filesTotal.toLocaleString()} files). Estimated ${Math.round(estDurationMs/1000)}s.`;
  }

  return {
    root_path: rootPath,
    walk_duration_ms: walkDurationMs,
    directories_total: totalDirectories,
    files_total: filesTotal,
    by_category: {
      supported: counts.supported,
      coming_soon: counts.coming_soon,
      opaque_text: counts.opaque_text,
      opaque_binary: counts.opaque_binary,
    },
    by_language: Object.fromEntries(
      Object.entries(byLanguage).sort((a, b) => b[1] - a[1])
    ),
    skipped: {
      unrecognized: counts.skipped_unrecognized,
      ignored_directories: counts.skipped_ignored_dir,
      ignored_files: counts.skipped_ignored_file,
    },
    est_duration_ms: estDurationMs,
    est_duration_seconds: Math.round(estDurationMs / 1000),
    warning,
  };
}
