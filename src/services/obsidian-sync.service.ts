import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Project } from '../models/project.model';
import { Employee } from '../models/employee.model';
import { WorkingStatusHistory } from '../models/working-status-history.model';
import { EmployeeMemory } from '../models/employee-memory.model';
import { config } from '../config';
import { TelemetryService } from './telemetry.service';

const telemetry = new TelemetryService();
const LOG_PREFIX = '[ObsidianSync]';

interface SyncResult {
  projectssynced: number;
  employeesSynced: number;
  filesCopied: number;
  driveLink?: string;
  durationMs: number;
}

interface SyncStatus {
  syncing: boolean;
  lastSyncAt: string | null;
  vaultPath: string;
}

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  '.angular', '.turbo', '__pycache__', '.venv', 'coverage',
]);

function slugify(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

function yamlEscape(value: string): string {
  if (/[:"'\n\r#\[\]{}|>&*!%@`]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function formatDate(d: Date): string {
  return new Date(d).toISOString().replace('T', ' ').substring(0, 16);
}

function projectLabel(project: any): string {
  return `[[${project.name}]]`;
}

function taskStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'in_progress': return '🔄';
    default: return '⏳';
  }
}

const DEBOUNCE_MS = 30_000; // 30s debounce for reactive syncs

export class ObsidianSyncService {
  private syncing = false;
  private lastSyncAt: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUserId: string | null = null;

  getStatus(): SyncStatus {
    return {
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      vaultPath: config.obsidianVaultPath,
    };
  }

  /**
   * Debounced reactive sync — called on employee events.
   * Batches rapid events into a single sync after 30s of quiet.
   */
  scheduleSync(userId: string): void {
    if (!config.obsidianVaultPath) return;

    this.pendingUserId = userId;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      if (this.syncing) {
        console.log(`${LOG_PREFIX} Skipping scheduled sync — already in progress`);
        return;
      }
      console.log(`${LOG_PREFIX} Reactive sync triggered (debounced)`);
      try {
        await this.sync(this.pendingUserId!, { full: false });
      } catch (err: any) {
        console.error(`${LOG_PREFIX} Reactive sync failed:`, err.message);
      }
    }, DEBOUNCE_MS);
  }

  async sync(userId: string, opts: { full?: boolean; publishToDrive?: boolean } = {}): Promise<SyncResult> {
    if (this.syncing) throw new Error('Sync already in progress');
    if (!config.obsidianVaultPath) throw new Error('OBSIDIAN_VAULT_PATH not configured');

    this.syncing = true;
    const start = Date.now();
    let filesCopied = 0;
    const mode = opts.full ? 'full' : 'incremental';

    console.log(`${LOG_PREFIX} Starting ${mode} sync to ${config.obsidianVaultPath}`);
    await telemetry.track({
      userId, type: 'agent_run', source: 'obsidian-sync', status: 'started',
      description: `Obsidian vault ${mode} sync started`,
      metadata: { mode, publishToDrive: !!opts.publishToDrive },
    });

    try {
      const vaultRoot = path.join(config.obsidianVaultPath, 'ProjectsHub');
      fs.mkdirSync(vaultRoot, { recursive: true });

      // Load last sync metadata
      const syncMetaPath = path.join(vaultRoot, '.last-sync.json');
      let lastSync: Record<string, any> = {};
      if (!opts.full && fs.existsSync(syncMetaPath)) {
        try { lastSync = JSON.parse(fs.readFileSync(syncMetaPath, 'utf-8')); } catch { /* ignore */ }
      }

      const projects: any[] = await Project.find({ userId }).lean();
      const allEmployees: any[] = await Employee.find({ userId }).lean();
      console.log(`${LOG_PREFIX} Found ${projects.length} projects, ${allEmployees.length} employees`);

      // Generate overview
      fs.writeFileSync(
        path.join(vaultRoot, '_overview.md'),
        this.generateOverview(projects),
        'utf-8',
      );

      let employeesSynced = 0;
      let statusEntriesTotal = 0;
      let tasksTotal = 0;

      for (const project of projects) {
        const projName = slugify(project.name);
        const projDir = path.join(vaultRoot, projName);
        fs.mkdirSync(path.join(projDir, 'employees'), { recursive: true });
        fs.mkdirSync(path.join(projDir, 'agents'), { recursive: true });
        fs.mkdirSync(path.join(projDir, 'docs'), { recursive: true });

        const employees = allEmployees.filter(
          (e) => String(e.projectId) === String(project._id),
        );

        console.log(`${LOG_PREFIX} Syncing project "${project.name}" — ${employees.length} employees`);

        // Project page
        fs.writeFileSync(
          path.join(projDir, `_project - ${projName}.md`),
          this.generateProjectPage(project, employees),
          'utf-8',
        );

        // Employee pages
        fs.mkdirSync(path.join(projDir, 'learnings'), { recursive: true });
        for (const emp of employees) {
          const statusHistory: any[] = await WorkingStatusHistory.find({ employeeId: emp._id })
            .sort({ createdAt: -1 })
            .lean();

          const learnings: any[] = await EmployeeMemory.find({ employeeId: emp._id, category: 'learning' })
            .sort({ importance: -1, createdAt: -1 })
            .lean();

          const taskCount = emp.taskHistory?.length || 0;
          statusEntriesTotal += statusHistory.length;
          tasksTotal += taskCount;

          const empId = String(emp._id).slice(-6);
          const empFileName = slugify(`${emp.name} - ${empId}`);
          const learningsFileName = slugify(`${emp.name} - ${empId} - learnings`);

          fs.writeFileSync(
            path.join(projDir, 'employees', `${empFileName}.md`),
            this.generateEmployeePage(emp, project, statusHistory, learnings.length, learningsFileName),
            'utf-8',
          );

          if (learnings.length > 0) {
            fs.writeFileSync(
              path.join(projDir, 'learnings', `${learningsFileName}.md`),
              this.generateLearningsPage(emp, project, learnings, empFileName),
              'utf-8',
            );
          }

          console.log(`${LOG_PREFIX}   ↳ ${emp.avatar} ${emp.name}: ${statusHistory.length} status entries, ${taskCount} tasks, ${learnings.length} learnings`);
          employeesSynced++;
        }

        // Sync project .md files from disk
        const folders = [...(project.folders || [])];
        if (project.localPath && !folders.includes(project.localPath)) {
          folders.unshift(project.localPath);
        }

        let projectFilesCopied = 0;
        for (const folder of folders) {
          const normFolder = folder.replace(/\\/g, '/');
          if (!fs.existsSync(normFolder)) {
            console.log(`${LOG_PREFIX}   ⚠ Folder not found: ${normFolder}`);
            continue;
          }

          // Generate / update CLAUDE.md for this project folder
          try {
            this.writeClaudeMd(normFolder, project, employees);
          } catch (err: any) {
            console.warn(`${LOG_PREFIX}   ⚠ CLAUDE.md write failed: ${err.message}`);
          }

          // Sync .agents/ subdirectories
          const agentsDir = path.join(normFolder, '.agents');
          if (fs.existsSync(agentsDir)) {
            for (const subDir of ['comms', 'status', 'task-results', 'personal-skills']) {
              const srcSub = path.join(agentsDir, subDir);
              if (!fs.existsSync(srcSub)) continue;
              const destSub = path.join(projDir, 'agents', subDir);
              const copied = this.copyMdFiles(srcSub, destSub, opts.full, employees, projectLabel(project));
              projectFilesCopied += copied;
            }
          }

          // Sync root-level and other .md files into docs/
          projectFilesCopied += this.copyRootMdFiles(normFolder, projDir, opts.full, employees, projectLabel(project));
        }

        filesCopied += projectFilesCopied;
        if (projectFilesCopied > 0) {
          console.log(`${LOG_PREFIX}   ↳ Copied ${projectFilesCopied} project files`);
        }
      }

      // Write sync metadata
      const now = new Date().toISOString();
      fs.writeFileSync(syncMetaPath, JSON.stringify({ lastSyncAt: now }, null, 2), 'utf-8');
      this.lastSyncAt = now;

      const result: SyncResult = {
        projectssynced: projects.length,
        employeesSynced,
        filesCopied,
        durationMs: Date.now() - start,
      };

      console.log(`${LOG_PREFIX} Vault sync complete — ${projects.length} projects, ${employeesSynced} employees, ${filesCopied} files copied, ${statusEntriesTotal} status entries, ${tasksTotal} tasks (${result.durationMs}ms)`);

      // Google Drive publishing
      if (opts.publishToDrive) {
        console.log(`${LOG_PREFIX} Publishing to Google Drive...`);
        const driveResult = this.publishToDrive(vaultRoot);
        result.driveLink = driveResult.link;
        console.log(`${LOG_PREFIX} Drive publish complete: ${driveResult.link}`);
      }

      await telemetry.track({
        userId, type: 'agent_run', source: 'obsidian-sync', status: 'completed',
        description: `Obsidian vault sync: ${projects.length} projects, ${employeesSynced} employees, ${filesCopied} files`,
        durationMs: result.durationMs,
        metadata: { ...result, mode, statusEntriesTotal, tasksTotal },
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      console.error(`${LOG_PREFIX} Sync failed after ${durationMs}ms:`, err.message);

      await telemetry.track({
        userId, type: 'agent_run', source: 'obsidian-sync', status: 'failed',
        description: `Obsidian vault sync failed`, error: err.message,
        durationMs,
        metadata: { mode, publishToDrive: !!opts.publishToDrive },
      });

      throw err;
    } finally {
      this.syncing = false;
    }
  }

  // ── Markdown generators ──

  private generateOverview(projects: any[]): string {
    const now = new Date().toISOString();
    let md = `---
type: overview
synced: ${now}
---

# ProjectsHub Overview

**Last synced:** ${formatDate(new Date(now))}

## Projects (${projects.length})

`;

    for (const p of projects) {
      const label = projectLabel(p);
      const status = p.onHolding ? '⏸️ On Hold' : '▶️ Active';
      md += `- [[_project - ${slugify(p.name)}|${label}]] — ${status}`;
      if (p.description) md += ` — ${p.description.substring(0, 100)}`;
      md += '\n';
    }

    return md;
  }

  private generateProjectPage(project: any, employees: any[]): string {
    const now = new Date().toISOString();
    const label = projectLabel(project);
    const projId = String(project._id).slice(-6);
    let md = `---
type: project
name: ${yamlEscape(project.name)}
projectId: ${projId}
status: ${project.onHolding ? 'on-hold' : 'active'}
synced: ${now}
---

# ${label}

`;

    if (project.description) md += `${project.description}\n\n`;
    if (project.strategicDirection) {
      md += `## Strategic Direction\n${project.strategicDirection.substring(0, 3000)}\n\n`;
    }

    if (project.applications?.length) {
      md += `## Applications\n`;
      for (const app of project.applications) {
        md += `- **${app.name}** (${app.type}) — port ${app.port} — ${app.status}\n`;
      }
      md += '\n';
    }

    md += `## Team (${employees.length})\n`;
    for (const emp of employees) {
      const empId = String(emp._id).slice(-6);
      const empFile = slugify(`${emp.name} - ${empId}`);
      md += `- ${emp.avatar} [[${emp.name}]] — ${emp.title} — ${emp.status}\n`;
    }

    return md;
  }

  private generateEmployeePage(employee: any, project: any, statusHistory: any[], learningsCount = 0, learningsFileName = ''): string {
    const now = new Date().toISOString();
    const label = projectLabel(project);
    const empId = String(employee._id).slice(-6);

    let md = `---
type: employee
project: ${yamlEscape(label)}
name: ${yamlEscape(employee.name)}
employeeId: ${empId}
role: ${yamlEscape(employee.role)}
title: ${yamlEscape(employee.title)}
status: ${employee.status}
${employee.lastActivity ? `lastActivity: ${new Date(employee.lastActivity).toISOString()}\n` : ''}synced: ${now}
---

# ${employee.avatar} [[${employee.name}]] — ${employee.title}

**Status:** ${employee.status} | **Project:** [[_project - ${slugify(project.name)}|${label}]]
${learningsCount > 0 ? `\n📘 **Learnings:** [[${learningsFileName}|${learningsCount} accumulated learnings]]\n` : ''}
`;

    // Current task
    if (employee.currentTask) {
      md += `## Current Task\n${employee.currentTask}\n\n`;
    }

    // Current working status
    if (employee.workingStatus) {
      const ago = employee.workingStatusAt ? ` (${formatDate(new Date(employee.workingStatusAt))})` : '';
      md += `## Working Status${ago}\n${employee.workingStatus}\n\n`;
    }

    // Build task lookup for enriching status entries
    const taskMap = new Map<string, any>();
    for (const t of (employee.taskHistory || [])) {
      if (t.taskId) taskMap.set(t.taskId, t);
    }

    // Status history
    if (statusHistory.length > 0) {
      md += `## Status History\n`;
      for (const entry of statusHistory) {
        md += `### ${formatDate(new Date(entry.createdAt))} (${entry.source})\n`;
        md += `- **Project:** ${projectLabel(project)}\n`;
        md += `- **Employee:** ${employee.avatar} [[${employee.name}]] — ${employee.title}\n`;
        if (entry.taskId) {
          const task = taskMap.get(entry.taskId);
          md += `- **Task:** ${task?.description || entry.taskId}\n`;
          if (task?.status) md += `- **Task Status:** ${taskStatusIcon(task.status)} ${task.status}\n`;
        }
        md += `\n${entry.content}\n\n---\n\n`;
      }
    }

    // Task history
    const tasks = [...(employee.taskHistory || [])].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    if (tasks.length > 0) {
      md += `## Task History\n`;
      for (const task of tasks) {
        const icon = taskStatusIcon(task.status);
        const completed = task.completedAt ? ` (completed ${formatDate(new Date(task.completedAt))})` : '';
        md += `### ${icon} ${task.description}${completed}\n`;
        md += `- **Status:** ${task.status}\n`;
        md += `- **Started:** ${formatDate(new Date(task.startedAt))}\n`;
        if (task.result) {
          md += `- **Result:**\n\n${task.result.substring(0, 5000)}\n`;
        }
        md += '\n---\n\n';
      }
    }

    return md;
  }

  private generateLearningsPage(employee: any, project: any, learnings: any[], empFileName: string): string {
    const now = new Date().toISOString();
    const label = projectLabel(project);
    const empId = String(employee._id).slice(-6);

    let md = `---
type: learnings
project: ${yamlEscape(label)}
employee: ${yamlEscape(employee.name)}
employeeId: ${empId}
role: ${yamlEscape(employee.role)}
count: ${learnings.length}
synced: ${now}
---

# 📘 Learnings — ${employee.avatar} [[${empFileName}|${employee.name}]]

**Project:** [[_project - ${slugify(project.name)}|${label}]]
**Total learnings:** ${learnings.length}

`;

    for (const learning of learnings) {
      md += `### imp ${learning.importance} — ${formatDate(new Date(learning.createdAt))}\n`;
      md += `${learning.content}\n`;
      if (learning.tags?.length) {
        md += `\n*Tags:* ${learning.tags.map((t: string) => `#${t}`).join(' ')}\n`;
      }
      md += '\n---\n\n';
    }

    return md;
  }

  /**
   * Write or update CLAUDE.md in the project folder so Claude Code sessions
   * automatically get full project context (description, team, available skills).
   * Preserves any user-added content below the AUTO-GENERATED markers.
   */
  private writeClaudeMd(projectFolder: string, project: any, employees: any[]): void {
    const claudeMdPath = path.join(projectFolder, 'CLAUDE.md');
    const projId = String(project._id).slice(-6);
    const now = new Date().toISOString();

    const START = '<!-- AUTO-GENERATED:START — managed by ProjectsHub obsidian-sync -->';
    const END = '<!-- AUTO-GENERATED:END -->';

    let teamSection = '';
    if (employees.length > 0) {
      teamSection = `\n## Team (${employees.length})\n\n`;
      teamSection += `| Employee | ID | Role | Status | Last Activity |\n`;
      teamSection += `|----------|----|----|--------|---------------|\n`;
      for (const emp of employees) {
        const empId = String(emp._id).slice(-6);
        const lastActivity = emp.lastActivity
          ? new Date(emp.lastActivity).toISOString().substring(0, 10)
          : '—';
        teamSection += `| ${emp.avatar} ${emp.name} | \`${empId}\` | ${emp.role} | ${emp.status} | ${lastActivity} |\n`;
      }
    }

    const generated = `${START}
<!-- Last sync: ${now} -->

# ${project.name} \`${projId}\`

${project.description || '_(no description)_'}

${project.strategicDirection ? `## Strategic Direction\n${project.strategicDirection.substring(0, 2000)}\n` : ''}
${project.applications?.length ? `## Applications\n${project.applications.map((a: any) => `- **${a.name}** (${a.type}) — port ${a.port} — ${a.status}`).join('\n')}\n` : ''}${teamSection}
## Public Gateway Rules

All apps in this workspace run behind a shared nginx gateway exposed via ngrok at:
\`https://nonshattering-adelaida-ponchoed.ngrok-free.dev\`

Every app MUST be reachable through that public URL — not just localhost.

**Frontends:**
- Use RELATIVE paths for all assets, API calls, and client-side routes (no hardcoded \`http://localhost\` or absolute URLs)
- Must work both at the root \`/\` (cookie-routed) and at \`/<company>__<app>/\` (path-routed)
- Respect the \`X-Base-Path\` header set by nginx for path-routed apps
- Use HTML5 history mode for SPA routing

**Backends:**
- CORS MUST allow \`https://nonshattering-adelaida-ponchoed.ngrok-free.dev\` (in addition to \`http://localhost:4567\` for dev)
- CORS MUST set \`credentials: true\` so cookies cross the boundary
- Trust \`X-Forwarded-Proto\` and \`X-Forwarded-For\` headers from nginx
- Cookies should use \`SameSite=Lax\` (or \`None; Secure\` for cross-site) and \`Path=/\`

Test EVERY app at both \`http://localhost:<port>\` AND \`https://nonshattering-adelaida-ponchoed.ngrok-free.dev/<your-shortcut>\` before marking it done.

${END}
`;

    let finalContent: string;
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, 'utf-8');
      const startIdx = existing.indexOf(START);
      const endIdx = existing.indexOf(END);

      if (startIdx !== -1 && endIdx !== -1) {
        // Replace existing auto-generated block, preserve everything else
        const before = existing.substring(0, startIdx);
        const after = existing.substring(endIdx + END.length);
        finalContent = before + generated.trim() + after;
      } else {
        // No markers — prepend the auto-generated block
        finalContent = generated + '\n' + existing;
      }
    } else {
      finalContent = generated;
    }

    fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');
  }

  // ── File operations ──

  /**
   * Build a map from role title/name → "Title (id)" for enriching author references.
   * Multiple employees with the same role get separate entries.
   */
  private buildAuthorMap(employees: any[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const emp of employees) {
      const empId = String(emp._id).slice(-6);
      const label = `[[${emp.name}]]`;
      // Map various forms of the role name to the enriched label
      map.set(emp.name.toLowerCase(), label);
      map.set(emp.title.toLowerCase(), label);
      map.set(emp.role.toLowerCase(), label);
    }
    return map;
  }

  /**
   * Replace all role name references in markdown content with enriched employee IDs.
   * Handles: Author:, Role:, From:, "Message from X → Y", title lines with role names.
   */
  private enrichFileContent(content: string, authorMap: Map<string, string>, projectName: string, fileMtime: Date): string {
    // Helper: replace a role name if found in the map
    const replaceRole = (name: string): string => {
      const lookup = name.trim().toLowerCase();
      return authorMap.get(lookup) || name;
    };

    // 1. **Author:** / **Role:** / **From:** lines
    content = content.replace(
      /(\*{0,2}(?:Author|Role|From)\*{0,2}:\s*\*{0,2})([^\n*]+?)(\*{0,2}\s*$)/gim,
      (_match, prefix, name, suffix) => `${prefix}${replaceRole(name)}${suffix}`,
    );

    // 2. "Message from X → Y" or "Message from X to Y"
    content = content.replace(
      /(Message from\s+)([A-Z][\w/ ]+?)\s*(?:→|to)\s*([A-Z][\w/ ]+)/gi,
      (_match, prefix, from, to) => `${prefix}${replaceRole(from)} → ${replaceRole(to)}`,
    );

    // 3. Title lines: "# Role Name Status Update" or "# Role Name Report"
    content = content.replace(
      /^(#{1,3}\s+)([A-Z][\w/ ]+?)\s+(Status Update|Report|Consultation|Summary)/gim,
      (_match, hashes, name, suffix) => `${hashes}${replaceRole(name)} ${suffix}`,
    );

    // 4. Enrich **Date:** lines — add time if missing, and inject **Project:** after it
    content = content.replace(
      /^(\*{0,2}Date\*{0,2}:\s*\*{0,2})(\d{4}-\d{2}-\d{2})(\*{0,2}\s*)$/gim,
      (_match, prefix, date, suffix) => `${prefix}${date} ${fileMtime.toISOString().substring(11, 16)}${suffix}`,
    );
    // Also handle dates without ISO format (e.g. "18 de Março de 2026") — leave as-is but still inject project
    // Inject **Project:** after the **Date:** line if not already present
    if (!content.match(/^\*{0,2}Project\*{0,2}:/im)) {
      const dateInjected = content.replace(
        /^(\*{0,2}Date\*{0,2}:.*$)/im,
        `$1\n**Project:** ${projectName}`,
      );
      if (dateInjected !== content) {
        content = dateInjected;
      } else {
        // No Date: line found — inject after first heading
        content = content.replace(
          /^(#{1,3}\s+.+)$/m,
          `$1\n\n**Project:** ${projectName}`,
        );
      }
    }

    return content;
  }

  private copyMdFiles(srcDir: string, destDir: string, full?: boolean, employees?: any[], projectName?: string): number {
    fs.mkdirSync(destDir, { recursive: true });
    const authorMap = employees ? this.buildAuthorMap(employees) : new Map();
    let count = 0;

    const entries = this.walkDir(srcDir);
    for (const filePath of entries) {
      if (!filePath.endsWith('.md') && !filePath.endsWith('.json')) continue;

      const rel = path.relative(srcDir, filePath);
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      const srcStat = fs.statSync(filePath);
      if (!full && fs.existsSync(dest)) {
        const destMtime = fs.statSync(dest).mtimeMs;
        if (srcStat.mtimeMs <= destMtime) continue;
      }

      if (filePath.endsWith('.md') && (authorMap.size > 0 || projectName)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const enriched = this.enrichFileContent(content, authorMap, projectName || '', srcStat.mtime);
          fs.writeFileSync(dest, enriched, 'utf-8');
        } catch {
          fs.copyFileSync(filePath, dest);
        }
      } else {
        fs.copyFileSync(filePath, dest);
      }
      count++;
    }

    return count;
  }

  private copyRootMdFiles(projectFolder: string, vaultProjDir: string, full?: boolean, employees?: any[], projectName?: string): number {
    let count = 0;
    const docsDir = path.join(vaultProjDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    const authorMap = employees ? this.buildAuthorMap(employees) : new Map();

    try {
      const entries = fs.readdirSync(projectFolder, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        if (!entry.name.endsWith('.md')) continue;
        if (entry.name.startsWith('.')) continue;

        const src = path.join(projectFolder, entry.name);
        const dest = path.join(docsDir, entry.name);

        const srcStat = fs.statSync(src);
        if (!full && fs.existsSync(dest)) {
          const destMtime = fs.statSync(dest).mtimeMs;
          if (srcStat.mtimeMs <= destMtime) continue;
        }

        if (authorMap.size > 0 || projectName) {
          try {
            const content = fs.readFileSync(src, 'utf-8');
            const enriched = this.enrichFileContent(content, authorMap, projectName || '', srcStat.mtime);
            fs.writeFileSync(dest, enriched, 'utf-8');
          } catch {
            fs.copyFileSync(src, dest);
          }
        } else {
          fs.copyFileSync(src, dest);
        }
        count++;
      }
    } catch {
      // Folder may not be accessible
    }

    return count;
  }

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          results.push(...this.walkDir(path.join(dir, entry.name)));
        } else {
          results.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Skip inaccessible dirs
    }
    return results;
  }

  // ── Google Drive publishing ──

  private publishToDrive(vaultRoot: string): { link: string } {
    try {
      // Check if ProjectsHub-Vault folder exists
      const listCmd = `gws drive files list --params "{\\"q\\": \\"name='ProjectsHub-Vault' and mimeType='application/vnd.google-apps.folder' and trashed=false\\", \\"fields\\": \\"files(id,name,webViewLink)\\"}"`;
      const listResult = JSON.parse(execSync(listCmd, { encoding: 'utf-8', timeout: 30000 }));

      let folderId: string;
      let folderLink: string;

      if (listResult.files?.length > 0) {
        folderId = listResult.files[0].id;
        folderLink = listResult.files[0].webViewLink;
      } else {
        // Create the folder
        const createCmd = `gws drive files create --params "{\\"name\\": \\"ProjectsHub-Vault\\", \\"mimeType\\": \\"application/vnd.google-apps.folder\\"}"`;
        const createResult = JSON.parse(execSync(createCmd, { encoding: 'utf-8', timeout: 30000 }));
        folderId = createResult.id;
        folderLink = `https://drive.google.com/drive/folders/${folderId}`;
      }

      // Upload all files from vault
      const files = this.walkDir(vaultRoot);
      console.log(`${LOG_PREFIX} Uploading ${files.length} files to Drive folder ${folderId}`);
      let uploaded = 0;
      let skipped = 0;
      for (const filePath of files) {
        const rel = path.relative(vaultRoot, filePath).replace(/\\/g, '/');
        const fileName = rel; // Keep relative path as name for organization

        // Check if file already exists in Drive folder
        const checkCmd = `gws drive files list --params "{\\"q\\": \\"name='${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false\\", \\"fields\\": \\"files(id)\\"}"`;
        try {
          const checkResult = JSON.parse(execSync(checkCmd, { encoding: 'utf-8', timeout: 15000 }));
          if (checkResult.files?.length > 0) {
            const updateCmd = `gws drive files update --file-id ${checkResult.files[0].id} --upload-file "${filePath.replace(/\\/g, '/')}"`;
            execSync(updateCmd, { encoding: 'utf-8', timeout: 30000 });
          } else {
            const uploadCmd = `gws drive files create --params "{\\"name\\": \\"${fileName}\\", \\"parents\\": [\\"${folderId}\\"]}" --upload-file "${filePath.replace(/\\/g, '/')}"`;
            execSync(uploadCmd, { encoding: 'utf-8', timeout: 30000 });
          }
          uploaded++;
        } catch {
          skipped++;
          console.warn(`${LOG_PREFIX} Failed to upload: ${rel}`);
        }
      }

      console.log(`${LOG_PREFIX} Drive upload done — ${uploaded} uploaded, ${skipped} skipped`);
      return { link: folderLink };
    } catch (err: any) {
      console.error(`${LOG_PREFIX} Drive publish failed:`, err.message);
      throw new Error(`Drive publish failed: ${err.message}`);
    }
  }
}

export const obsidianSyncService = new ObsidianSyncService();
