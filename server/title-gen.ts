import { childLogger } from './logger.js';
import { runClaudePrint } from './claude-cli.js';

const logger = childLogger('title-gen');

const TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You are a concise task-naming assistant. Return only a JSON object with "title" and "description" fields — no markdown fences, no extra text.';

interface TitleAndDescription {
  title: string;
  description: string;
}

function fallback(initialPrompt: string): TitleAndDescription {
  const firstLine = initialPrompt.trim().split('\n')[0] ?? '';
  return {
    title: firstLine.slice(0, 80) || 'Untitled task',
    description: initialPrompt,
  };
}

export async function generateTitleAndDescription(
  initialPrompt: string,
): Promise<TitleAndDescription> {
  if (!initialPrompt.trim()) {
    return fallback(initialPrompt);
  }

  try {
    const prompt = `Given this task description, return JSON {"title","description"}.
title: ≤50 chars, imperative verb phrase ("Add X", "Fix Y"), no trailing period.
description: 1 sentence ≤140 chars summarizing the goal.

Task description:
${initialPrompt}`;

    const stdout = await runClaudePrint({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: TIMEOUT_MS,
    });

    const parsed = JSON.parse(stdout) as { title?: unknown; description?: unknown };
    const title =
      typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim().slice(0, 50)
        : fallback(initialPrompt).title;
    const description =
      typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim().slice(0, 140)
        : initialPrompt;

    return { title, description };
  } catch (err) {
    logger.warn({ err }, 'title-gen failed, using fallback');
    return fallback(initialPrompt);
  }
}
