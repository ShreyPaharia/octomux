export interface PRPromptContext {
  taskTitle: string;
  taskDescription: string;
  commitLog: string;
  diffStats: string;
}

export function buildPRPrompt(context: PRPromptContext): string {
  return `Generate a pull request title and description based on the following changes.

Task: ${context.taskTitle}
Description: ${context.taskDescription}

Commits:
${context.commitLog}

File changes:
${context.diffStats}

Requirements:
- PR title must follow Conventional Commits: <type>(<scope>): <description>
  Types: feat, fix, refactor, test, docs, chore
- PR body must use this exact format:

## What
<1-3 bullet points describing what changed>

## Why
<1-2 sentences explaining the motivation>

## Testing
<Bulleted checklist of how to verify the changes>

Return ONLY valid JSON with no other text:
{"title": "the PR title", "body": "the PR body in markdown"}`;
}
