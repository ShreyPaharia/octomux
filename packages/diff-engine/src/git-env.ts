/**
 * Strip GIT_* env vars so our git calls target the worktree we pass via -C,
 * not whatever repo an outer caller (e.g. a git hook) happens to be in.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}
