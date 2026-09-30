import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';import { fileIntoProject } from '../tools/master-architect/lib/editor/architect-link.js';


export default {
  name: 'write_file',
  description: 'Write content to NEW file. Cannot overwrite existing files — use read_file replace to edit existing files.',
  schema: {
    path: z.string().describe('File path'),
    content: z.string().describe('Content to write'),
  },
  async handler({ path: filePath, content }) {
    try {
      // Block overwriting existing files — use read_file replace instead
      try {
        await fs.access(filePath);
        return { content: [{ type: 'text', text: `File already exists: ${filePath}. Use read_file with replace to edit existing files.` }] };
      } catch {}
      // Ensure parent directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');

      // PLACEMENT GATE (H7/H8): file the new file into a project as a bare
      // record. Never prompts — under a project root -> that project; else an
      // unknown_N cluster that self-corrects later. Best-effort: a placement
      // failure must NOT fail the write itself.
      let placementMsg = '';
      try {
        const r = fileIntoProject(filePath);
        if (r && r.filed) {
          placementMsg = ` — filed under project '${r.project_name}'`
            + (r.placement === 'unknown'
                ? ' (unknown cluster, will reconcile as links are discovered)'
                : ' (v1 bare record, unparsed)');
        }
      } catch (pe) {
        placementMsg = ` — (architect placement skipped: ${pe.message})`;
      }

      return { content: [{ type: 'text', text: `Written: ${filePath}${placementMsg}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error writing ${filePath}: ${e.message}` }] };
    }
  },
};
