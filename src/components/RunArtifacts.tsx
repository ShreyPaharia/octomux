/**
 * src/components/RunArtifacts.tsx
 *
 * Run-detail surface for `ctx.artifacts.write()` (SHR-269) — lists the files a
 * plugin wrote against a run's task. Purely presentational: the artifact body
 * itself is never inlined into the run JSON, the browser fetches it from
 * `artifact.url` (`/api/tasks/:taskId/artifacts/:pluginId/:name`) only when the
 * link is followed.
 */
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { RunArtifact } from '@/lib/api/runApi';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// sqlite datetime('now') is 'YYYY-MM-DD HH:MM:SS' UTC with no 'T'/'Z' — append
// 'Z' before parsing, same as src/components/BoardCard.tsx.
function formatUpdatedAt(updatedAt: string): string {
  return new Date(updatedAt + 'Z').toLocaleString();
}

export interface RunArtifactsProps {
  artifacts: RunArtifact[];
}

/** Renders nothing when there are no artifacts — a run with no plugins
 *  installed (or none that write artifacts) shows no empty shell. */
export function RunArtifacts({ artifacts }: RunArtifactsProps) {
  if (artifacts.length === 0) return null;
  return (
    <Card size="sm" data-testid="run-artifacts">
      <CardHeader>
        <CardTitle>Artifacts</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Name</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Plugin</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Type</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Size</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((artifact) => (
              <tr key={`${artifact.pluginId}:${artifact.name}`}>
                <td className="border-b border-border/50 px-2 py-1">
                  <a
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary hover:underline"
                  >
                    {artifact.name}
                  </a>
                </td>
                <td className="border-b border-border/50 px-2 py-1">
                  <Badge variant="secondary">{artifact.pluginId}</Badge>
                </td>
                <td className="border-b border-border/50 px-2 py-1 text-muted-foreground">
                  {artifact.mime}
                </td>
                <td className="border-b border-border/50 px-2 py-1 text-muted-foreground">
                  {formatSize(artifact.size)}
                </td>
                <td className="border-b border-border/50 px-2 py-1 text-muted-foreground">
                  {formatUpdatedAt(artifact.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
