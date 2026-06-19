import { parseArgs } from 'node:util';

export async function runCreate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      pr: { type: 'string' },
      repo: { type: 'string' },
    },
  });

  if (!values.pr) {
    process.stderr.write('--pr is required\n');
    process.exit(2);
  }

  const base = process.env.OCTOMUX_SERVER_URL ?? 'http://127.0.0.1:7777';
  const body: { pr_url: string; repo_path?: string } = { pr_url: values.pr as string };
  if (values.repo) {
    body.repo_path = values.repo as string;
  }

  let res: Response;
  try {
    res = await fetch(`${base}/api/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`connection failed: ${msg}\nis the octomux server running? (${base})\n`);
    process.exit(1);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    process.stderr.write(`unexpected response from server (status ${res.status})\n`);
    process.exit(1);
  }

  if (!res.ok) {
    const errMsg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    process.stderr.write(`${errMsg}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(json, null, 2) + '\n');
}
