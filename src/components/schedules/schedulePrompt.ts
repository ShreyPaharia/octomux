/**
 * When the textarea still matches the shipped default, store null so the schedule
 * keeps tracking future SKILL.md updates instead of freezing a copy.
 */
export function resolveStoredPrompt(
  promptText: string,
  defaultPrompt: string | null,
): string | null {
  const trimmed = promptText.trim();
  if (!trimmed) return null;
  if (defaultPrompt !== null && trimmed === defaultPrompt.trim()) return null;
  return trimmed;
}
