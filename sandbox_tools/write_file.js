import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { registerBareFile, listProjects, createProject } from '../tools/master-architect/lib/editor/architect-link.js';

// write_file creates NEW files only (never overwrites) and never decides a
// project on its own: the agent names one every time — an existing project
// to attach the file to, or a new name to start a project with this file.
export default {
  name: 'write_file',
  description: 'Create a NEW file (never overwrites; edit existing files with read_file). Every new file must belong to a project: pass project="<existing name>" to attach it, or a new name to start a new project rooted at the file\'s folder. Called without project, nothing is written and the existing projects are listed.',
  schema: {
    path: z.string().describe('File path'),
    content: z.string().describe('Content to write'),
    project: z.string().optional().describe('Project this file belongs to: an existing project name (attach) or a new name (creates the project, rooted at this file\'s folder). Required — without it the call only lists projects.'),
  },
  async handler({ path: filePath, content, project }) {
    const reply = (text) => ({ content: [{ type: 'text', text }] });
    try {
      // Block overwriting existing files — use read_file to edit them
      try {
        await fs.access(filePath);
        return reply(`File already exists: ${filePath}. Use read_file to edit existing files.`);
      } catch {}

      const absPath = path.resolve(filePath);
      const folder = path.dirname(absPath);
      const projects = listProjects() || [];
      const listing = projects.length
        ? projects.map(p => `  - ${p.name}  (${p.root_path})`).join('\n')
        : '  (no projects yet)';

      // No project named: ask, write nothing.
      if (!project || !project.trim()) {
        return reply(
          `Not written: which project does ${filePath} belong to?\n`
          + `Existing projects:\n${listing}\n`
          + `Call write_file again with project="<existing name>" to attach it, `
          + `or project="<new name>" to start a new project rooted at ${folder}.`);
      }
      project = project.trim();

      // Existing project → attach. New name → create (rooted at this file's folder).
      let target = projects.find(p => p.name === project);
      let created = false;
      if (!target) {
        const c = createProject(project, folder);
        if (!c || !c.ok) {
          return reply(`Not written: could not create project '${project}' (${c?.error || 'architect DB unavailable'}).\n`
            + `Existing projects:\n${listing}`);
        }
        target = { id: c.project_id, name: project, root_path: folder };
        created = true;
      }

      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(absPath, content, 'utf8');

      const r = registerBareFile(absPath, target.id);
      const outside = !(absPath === target.root_path || absPath.startsWith(target.root_path + path.sep));
      return reply(
        `Written: ${filePath} — ${created ? 'new project' : 'attached to project'} '${target.name}'`
        + (r && r.filed ? '' : ` (project record not updated: ${r?.error || 'architect DB unavailable'})`)
        + (outside ? `. Note: the file is outside the project folder ${target.root_path}.` : '.'));
    } catch (e) {
      return reply(`Error writing ${filePath}: ${e.message}`);
    }
  },
};
