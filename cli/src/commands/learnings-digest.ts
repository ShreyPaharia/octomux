import { Command } from 'commander';
import { errorMessage } from '../format.js';

interface DigestLearning {
  id: string;
  trigger: string;
  lesson: string;
  evidence: string | null;
  usage_count: number;
  created_at: string;
}

interface SupersededLearning extends DigestLearning {
  superseded_reason: string | null;
}

interface DigestBenefit {
  seededPassRate: number;
  unseededPassRate: number;
  seededN: number;
  unseededN: number;
}

interface DigestResponse {
  additions: DigestLearning[];
  unused: DigestLearning[];
  superseded?: SupersededLearning[];
  benefit: DigestBenefit;
}

const DEFAULT_SINCE_DAYS = '7';

/**
 * octomux learnings-digest — the weekly curation surface (replaces a
 * per-add human gate). Reads the base URL / bearer token from the same
 * OCTOMUX_ACTION_* env vars `octomux emit`/`learn`/`recall` read.
 */
export function registerLearningsDigest(program: Command): void {
  program
    .command('learnings-digest')
    .description(
      'Print the weekly agent-learnings digest (additions / removal candidates / benefit) for a repo',
    )
    .requiredOption('--repo <path>', 'repository path')
    .option('--since <days>', 'lookback window in days', DEFAULT_SINCE_DAYS)
    .action(async (opts: { repo: string; since: string }) => {
      const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
      const token = process.env.OCTOMUX_ACTION_TOKEN;
      if (!baseUrl || !token) {
        errorMessage(
          'octomux learnings-digest is not configured (missing OCTOMUX_ACTION_BASE_URL / OCTOMUX_ACTION_TOKEN)',
        );
        process.exit(1);
        return;
      }

      const url = new URL(`${baseUrl}/api/learnings/digest`);
      url.searchParams.set('repo', opts.repo);
      url.searchParams.set('sinceDays', opts.since);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage(`learnings-digest failed (HTTP ${res.status}): ${text}`);
        process.exit(1);
        return;
      }

      const digest = (await res.json()) as DigestResponse;
      console.log(formatDigest(opts.repo, opts.since, digest));
    });
}

export function formatDigest(repo: string, sinceDays: string, digest: DigestResponse): string {
  const lines: string[] = [];

  lines.push(`# Agent Learnings Digest: ${repo}`);
  lines.push(`_Past ${sinceDays} day(s)_`);
  lines.push('');

  lines.push('## Additions');
  if (digest.additions.length === 0) {
    lines.push('_No new learnings this period._');
  } else {
    for (const l of digest.additions) {
      lines.push(
        l.evidence
          ? `- **${l.trigger}**: ${l.lesson} (${l.evidence})`
          : `- **${l.trigger}**: ${l.lesson}`,
      );
    }
  }
  lines.push('');

  lines.push('## Removal candidates');
  const superseded = digest.superseded ?? [];
  if (digest.unused.length === 0 && superseded.length === 0) {
    lines.push('_No removal candidates._');
  } else {
    if (digest.unused.length > 0) {
      lines.push('_Never used since creation — human review before deleting:_');
      for (const l of digest.unused) {
        lines.push(`- \`${l.id}\` [${l.created_at}] ${l.lesson}`);
      }
    }
    if (superseded.length > 0) {
      lines.push(
        '_Soft-superseded by an agent (`unlearn`) — human review before hard-deleting with `octomux learn-forget <id>`:_',
      );
      for (const l of superseded) {
        lines.push(
          `- \`${l.id}\` ${l.lesson} (superseded: ${l.superseded_reason ?? 'no reason given'})`,
        );
      }
    }
  }
  lines.push('');

  lines.push('## Benefit');
  const { seededPassRate, unseededPassRate, seededN, unseededN } = digest.benefit;
  lines.push(`- Seeded iterations: ${seededN} (pass rate ${(seededPassRate * 100).toFixed(0)}%)`);
  lines.push(
    `- Unseeded iterations: ${unseededN} (pass rate ${(unseededPassRate * 100).toFixed(0)}%)`,
  );

  return lines.join('\n');
}
