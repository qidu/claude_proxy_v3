/**
 * Hand-authored tools for the interactive AGENT=true session (see src/agent-session.ts).
 *
 * Deliberately minimal — read_file/write_file/bash, plus find_skill/add_skill when the
 * `skills` CLI (vercel-labs/skills, npm package "skills") is available. No speculative
 * surface beyond that. pi-coding-agent ships a similar read/write/bash set but isn't
 * installed here (large CLI/TUI dependency tree we don't otherwise need), so these are
 * built directly against pi-agent-core's AgentTool shape.
 *
 * All paths are resolved relative to `workDir`, the working directory the user
 * picked (or the /tmp fallback) at session start — never process.cwd() directly.
 *
 * write_file and bash's rm/mv are confined to workDir plus the real /tmp/ tree
 * (isPathAllowed) — writes/deletes/moves outside both are blocked outright.
 * bash also blocks a small denylist of destructive command patterns regardless
 * of path (rm -rf, kill -9, force push, chmod -R 777, curl|sh). All of this is
 * raw-string/regex-based, not a real shell parser — see the comments above
 * DANGEROUS_COMMAND_PATTERNS and isPathAllowed for the accepted tradeoffs.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { loadSkills, formatSkillInvocation } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { Type, type Static } from 'typebox';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { realpathSync } from 'fs';
import { dirname, isAbsolute, resolve, sep } from 'path';
import { execFile } from 'child_process';
import { tmpdir } from 'os';

const BASH_TIMEOUT_MS = 60_000;
const BASH_MAX_BUFFER = 10 * 1024 * 1024;
const SKILL_TIMEOUT_MS = 60_000;
const SKILL_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_SKILLS = 5;

function resolveInWorkDir(workDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workDir, path);
}

// os.tmpdir() is the actual OS temp root (e.g. /var/folders/.../T on stock
// macOS, /tmp when $TMPDIR is overridden) — NOT necessarily the literal
// string "/tmp". Both the raw form and its realpath'd form (e.g. macOS's
// /tmp -> /private/tmp symlink) are accepted as roots below: a target path
// may arrive already resolved through the symlink, or not, and we can't
// realpath a target that doesn't exist yet (e.g. a file about to be
// created), so both variants of the root are checked instead.
const TMP_ROOT_RAW = tmpdir();
const TMP_ROOT_REAL = (() => {
  try {
    return realpathSync(TMP_ROOT_RAW);
  } catch {
    return TMP_ROOT_RAW;
  }
})();

function underRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + sep);
}

// Confines writes/deletes/moves to workDir plus the real OS tmp tree (a
// second always-allowed root — covers the Section 3 /tmp/task-<id> fallback
// dir too, since workDir is one of the two allowed roots regardless of where
// it lives).
function isPathAllowed(workDir: string, targetPath: string): boolean {
  const resolved = resolve(targetPath);
  const resolvedWorkDir = resolve(workDir);
  return (
    underRoot(resolved, resolvedWorkDir) ||
    underRoot(resolved, TMP_ROOT_RAW) ||
    underRoot(resolved, TMP_ROOT_REAL)
  );
}

function runCli(command: string, args: string[], cwd: string, timeoutMs: number, maxBuffer: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} ${args.join(' ')} failed: ${error.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

// Narrow, hardcoded denylist for the bash tool. Not a real shell parser — matches
// on the raw command string, so determined obfuscation (quoting tricks, variable
// indirection) can evade it. That's an accepted tradeoff: the goal is to stop the
// agent from accidentally running an obviously destructive command it explicitly
// decided to type, not to sandbox an adversarial actor — bash already runs with
// the operator's own shell privileges in workDir. Blocks outright (throws), no
// override/bypass flag. See plan Section 11 for the rationale and scope.
const DANGEROUS_COMMAND_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s/, reason: 'recursive force delete (rm -rf)' },
  { pattern: /\bkill\s+(-9|-KILL|-s\s*KILL)\b/, reason: 'unconditional process kill (kill -9)' },
  { pattern: /\bgit\s+push\b.*(--force\b|-f\b)/, reason: 'force push (can overwrite remote history)' },
  { pattern: /\bchmod\s+-R\s+777\b/, reason: 'recursive world-writable permissions (chmod -R 777)' },
  { pattern: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b|\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/, reason: 'piping a remote download directly into a shell' },
];

function findDangerousPattern(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// Matches a bare `rm <args...>` or `mv <args...>` invocation, capturing every
// space-separated token after the verb. Raw-string extraction, not a real shell
// parser (see DANGEROUS_COMMAND_PATTERNS doc comment for the same caveat).
const RM_MV_COMMAND = /\b(rm|mv)\s+(.+)/;

// Extends the bash denylist: blocks rm/mv where any non-flag argument resolves
// outside workDir and outside the real /tmp/ tree. Checks ALL non-flag args, not
// just the first — for `mv src dest` both matter (dest is where data lands; src
// is being read/removed from outside workDir either way). Separate from
// findDangerousPattern because it needs workDir to resolve relative paths
// (Section 12).
function findPathEscapingRmMv(command: string, workDir: string): string | null {
  const match = RM_MV_COMMAND.exec(command);
  if (!match) return null;
  const [, verb, rest] = match;
  const args = rest.split(/\s+/).filter((arg) => arg.length > 0 && !arg.startsWith('-'));
  for (const target of args) {
    const resolved = resolveInWorkDir(workDir, target);
    if (!isPathAllowed(workDir, resolved)) {
      return `${verb} targeting a path outside the working directory and outside /tmp/ (${target})`;
    }
  }
  return null;
}

const readFileParams = Type.Object({
  path: Type.String({ description: 'File path, absolute or relative to the working directory' }),
});
const writeFileParams = Type.Object({
  path: Type.String({ description: 'File path, absolute or relative to the working directory' }),
  content: Type.String({ description: 'Full file content to write' }),
});
const bashParams = Type.Object({
  command: Type.String({ description: 'Shell command to execute' }),
});
const findSkillParams = Type.Object({
  query: Type.String({ description: 'Search query, e.g. a technology or task name' }),
});
const addSkillParams = Type.Object({
  package: Type.String({ description: 'Skill package to install from, e.g. "vercel-labs/agent-skills"' }),
  skill: Type.String({ description: 'Name of the specific skill within the package to install' }),
});

/**
 * Options for wiring the skill tools into a live agent session.
 * `skillsCliAvailable` gates whether find_skill/add_skill are exposed at all
 * (probed once at session start in agent-session.ts — Rule 8: don't ship tools
 * that are present but always fail).
 * `getSystemPrompt`/`setSystemPrompt` let add_skill mutate the live Agent's
 * system prompt (agent.state.systemPrompt) without agent-tools.ts depending on
 * the Agent class directly.
 */
export interface AgentToolsOptions {
  skillsCliAvailable: boolean;
  getSystemPrompt: () => string;
  setSystemPrompt: (prompt: string) => void;
}

export function createAgentTools(workDir: string, options?: AgentToolsOptions): AgentTool[] {
  const readFileTool: AgentTool<typeof readFileParams> = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file as UTF-8 text.',
    parameters: readFileParams,
    execute: async (_toolCallId: string, params: Static<typeof readFileParams>) => {
      const fullPath = resolveInWorkDir(workDir, params.path);
      const content = await readFile(fullPath, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: content }],
        details: { path: fullPath, bytes: Buffer.byteLength(content) },
      };
    },
  };

  const writeFileTool: AgentTool<typeof writeFileParams> = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write UTF-8 text content to a file, creating parent directories as needed. Overwrites existing files.',
    parameters: writeFileParams,
    execute: async (_toolCallId: string, params: Static<typeof writeFileParams>) => {
      const fullPath = resolveInWorkDir(workDir, params.path);
      if (!isPathAllowed(workDir, fullPath)) {
        throw new Error(`Blocked: write_file path is outside the working directory and outside /tmp/ (${fullPath}).`);
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, params.content, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${fullPath}` }],
        details: { path: fullPath, bytes: Buffer.byteLength(params.content) },
      };
    },
  };

  const bashTool: AgentTool<typeof bashParams> = {
    name: 'bash',
    label: 'Run Shell Command',
    description: `Run a shell command in the working directory (${workDir}) and return its stdout/stderr. Times out after ${BASH_TIMEOUT_MS / 1000}s.`,
    parameters: bashParams,
    execute: async (_toolCallId: string, params: Static<typeof bashParams>, signal?: AbortSignal) => {
      const blocked = findDangerousPattern(params.command);
      if (blocked) {
        throw new Error(`Blocked: command matches a denylisted pattern (${blocked}). Command: ${params.command}`);
      }
      const pathEscape = findPathEscapingRmMv(params.command, workDir);
      if (pathEscape) {
        throw new Error(`Blocked: ${pathEscape}. Command: ${params.command}`);
      }
      const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, rejectPromise) => {
        const child = execFile(
          '/bin/sh',
          ['-c', params.command],
          { cwd: workDir, timeout: BASH_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER, signal },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === undefined && (error as any).killed) {
              rejectPromise(new Error(`Command timed out after ${BASH_TIMEOUT_MS / 1000}s: ${params.command}`));
              return;
            }
            resolvePromise({ stdout, stderr, code: child.exitCode });
          }
        );
      });
      const text = [
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
        `exit code: ${result.code}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      return {
        content: [{ type: 'text' as const, text }],
        details: result,
      };
    },
  };

  const tools: AgentTool[] = [readFileTool, writeFileTool, bashTool];

  if (options?.skillsCliAvailable) {
    let installedCount = 0;

    const findSkillTool: AgentTool<typeof findSkillParams> = {
      name: 'find_skill',
      label: 'Find Skill',
      description: 'Search for installable agent skill packages matching a query. Read-only — does not install anything.',
      parameters: findSkillParams,
      execute: async (_toolCallId: string, params: Static<typeof findSkillParams>) => {
        const { stdout } = await runCli('npx', ['skills', 'find', params.query, '--json'], workDir, SKILL_TIMEOUT_MS, SKILL_MAX_BUFFER);
        return {
          content: [{ type: 'text' as const, text: stdout || '[]' }],
          details: { query: params.query },
        };
      },
    };

    const addSkillTool: AgentTool<typeof addSkillParams> = {
      name: 'add_skill',
      label: 'Add Skill',
      description: `Install a specific skill from a package found via find_skill, then add its instructions to the running system prompt. Limited to ${MAX_SKILLS} skills per session.`,
      parameters: addSkillParams,
      execute: async (_toolCallId: string, params: Static<typeof addSkillParams>) => {
        if (installedCount >= MAX_SKILLS) {
          throw new Error(`${MAX_SKILLS}-skill limit reached for this session — cannot add "${params.skill}" from "${params.package}".`);
        }

        await runCli(
          'npx',
          ['skills', 'add', params.package, '--skill', params.skill, '--agent', 'pi', '-y', '-p'],
          workDir,
          SKILL_TIMEOUT_MS,
          SKILL_MAX_BUFFER,
        );

        // `skills add --agent pi -p` writes SKILL.md files under `.pi/skills` relative
        // to the project root (confirmed by reading vercel-labs/skills' own agent
        // registry: skillsDir: ".pi/skills" for the "pi" agent target, project-scoped).
        const skillsDir = resolve(workDir, '.pi/skills');
        const env = new NodeExecutionEnv({ cwd: workDir });
        const { skills, diagnostics } = await loadSkills(env, skillsDir);
        const added = skills.find((s) => s.name === params.skill);
        if (!added) {
          const diagText = diagnostics.map((d) => `${d.code}: ${d.message} (${d.path})`).join('; ');
          throw new Error(
            `"skills add" reported success but skill "${params.skill}" was not found under ${skillsDir}.${diagText ? ` Diagnostics: ${diagText}` : ''}`,
          );
        }

        const formatted = formatSkillInvocation(added);
        options.setSystemPrompt(`${options.getSystemPrompt()}\n\n${formatted}`);
        installedCount += 1;

        return {
          content: [{ type: 'text' as const, text: `Added skill "${added.name}" (${installedCount}/${MAX_SKILLS} used).` }],
          details: { name: added.name, filePath: added.filePath, installedCount },
        };
      },
    };

    tools.push(findSkillTool, addSkillTool);
  }

  return tools;
}
