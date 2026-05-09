import { childLogger } from './logger.js';

const logger = childLogger('title-gen');

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 5000;

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
  if (!process.env.ANTHROPIC_API_KEY) {
    return fallback(initialPrompt);
  }

  try {
    // Dynamic import to avoid module-load errors when the SDK isn't available
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let result: TitleAndDescription;

    try {
      const response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 200,
          system:
            'You are a concise task-naming assistant. Return only a JSON object with "title" and "description" fields — no markdown fences, no extra text.',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Given this task description, return JSON {"title","description"}.
title: ≤50 chars, imperative verb phrase ("Add X", "Fix Y"), no trailing period.
description: 1 sentence ≤140 chars summarizing the goal.

Task description:
${initialPrompt}`,
                  // Prompt caching — mark as ephemeral so SDKs that support caching benefit
                  cache_control: { type: 'ephemeral' },
                },
              ],
            },
          ],
        },
        { signal: controller.signal },
      );

      clearTimeout(timer);

      const text = response.content[0]?.type === 'text' ? (response.content[0].text ?? '') : '';

      const parsed = JSON.parse(text) as { title?: unknown; description?: unknown };
      const title =
        typeof parsed.title === 'string' && parsed.title.trim()
          ? parsed.title.trim().slice(0, 50)
          : fallback(initialPrompt).title;
      const description =
        typeof parsed.description === 'string' && parsed.description.trim()
          ? parsed.description.trim().slice(0, 140)
          : initialPrompt;

      result = { title, description };
    } catch (innerErr) {
      clearTimeout(timer);
      throw innerErr;
    }

    return result;
  } catch (err) {
    logger.warn({ err }, 'title-gen failed, using fallback');
    return fallback(initialPrompt);
  }
}
