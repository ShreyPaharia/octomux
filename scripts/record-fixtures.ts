#!/usr/bin/env tsx
/**
 * record-fixtures.ts — Phase-0 spike helper
 *
 * Captures real session transcript JSONL files pinned to `claude --version`.
 * Run this after any claude CLI upgrade to regenerate fixtures.
 *
 * Usage: bun run scripts/record-fixtures.ts [--session-id <id>] [--cwd <path>]
 *
 * The transcript path is: ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
 * where encoded-cwd = absolute path with '/' replaced by '-', leading '-' dropped.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const claudeVersion = execSync('claude --version 2>/dev/null || echo unknown')
  .toString()
  .trim()
  .split(' ')[0]; // e.g. "2.1.183"

console.log(`Claude version: ${claudeVersion}`);

function _transcriptPath(sessionId: string, cwd: string): string {
  // Claude encodes the cwd by replacing all '/' with '-' and dropping the leading '-'
  const encodedCwd = cwd.replace(/\//g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${encodedCwd}`, `${sessionId}.jsonl`);
}

function _encodeProjectDir(absoluteCwd: string): string {
  return `-${absoluteCwd.replace(/\//g, '-')}`;
}

console.log('Transcript path formula:');
console.log('  ~/.claude/projects/-<cwd-with-slashes-as-dashes>/<session_id>.jsonl');
console.log('');

// List available transcripts
const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
const entries = fs.readdirSync(claudeProjectsDir);
console.log(`Found ${entries.length} project directories`);

// Show compaction structure
console.log('\nTranscript format (observed in 2.1.183):');
console.log('- append-only JSONL');
console.log('- type=user: user messages (content as string or array)');
console.log('- type=assistant: assistant responses (message.content[])');
console.log('- type=system subtype=compact_boundary: marks start of compacted section');
console.log('  followed by type=user with summary text');
console.log('- type=attachment: hook events (hookName field)');
console.log('- metadata: last-prompt, mode, permission-mode, ai-title, file-history-snapshot');
console.log('- "version" field present in user/assistant lines (e.g. "2.1.183")');
console.log('');
console.log('CRITICAL: compaction does NOT rewrite the file.');
console.log('It APPENDS compact_boundary + summary, then continues appending.');
console.log('The tail normalizer needs NO special rewrite handling.');
