import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { configApi } from '@/lib/api/configApi';
import type { IntegrationRow } from '@/lib/api/configApi';

const WORKFLOW_STATUSES = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'human_review', label: 'Human Review' },
  { key: 'pr', label: 'PR' },
  { key: 'done', label: 'Done' },
] as const;

type Column = (typeof WORKFLOW_STATUSES)[number]['key'];

export interface LinearConfig {
  api_key: string;
  workspace_url?: string;
  default_team_key?: string;
  status_map_by_team: Record<string, Partial<Record<Column, string>>>;
}

interface PrefillTeam {
  id: string;
  key: string;
  name: string;
  states: Array<{ id: string; name: string; type: string }>;
}

interface LinearConfigFormProps {
  initial?: Partial<LinearConfig>;
  prefillTeams?: PrefillTeam[];
  onSubmit: (config: LinearConfig, name: string) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  nameInitial?: string;
}

export function LinearConfigForm({
  initial,
  prefillTeams: prefillTeamsInitial,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  nameInitial = '',
}: LinearConfigFormProps) {
  const [name, setName] = useState(nameInitial);
  const [apiKey, setApiKey] = useState(initial?.api_key ?? '');
  const [defaultTeamKey, setDefaultTeamKey] = useState(initial?.default_team_key ?? '');
  const [statusMapByTeam, setStatusMapByTeam] = useState<
    Record<string, Partial<Record<Column, string>>>
  >(initial?.status_map_by_team ?? {});
  const [teams, setTeams] = useState<PrefillTeam[]>(prefillTeamsInitial ?? []);
  const [prefilling, setPrefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePrefill() {
    setError(null);
    setPrefilling(true);
    try {
      const result = await configApi.prefillLinear(apiKey);
      setTeams(result.teams);
      setStatusMapByTeam(result.status_map_by_team);
      if (!defaultTeamKey && result.default_team_suggestion) {
        setDefaultTeamKey(result.default_team_suggestion);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrefilling(false);
    }
  }

  function setMapping(teamKey: string, col: Column, stateId: string | undefined) {
    setStatusMapByTeam((prev) => {
      const teamMap = { ...(prev[teamKey] ?? {}) };
      if (stateId) {
        teamMap[col] = stateId;
      } else {
        delete teamMap[col];
      }
      return { ...prev, [teamKey]: teamMap };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(
        {
          api_key: apiKey.trim(),
          default_team_key: defaultTeamKey.trim() || undefined,
          status_map_by_team: statusMapByTeam,
        },
        name.trim() || 'Linear',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="linear-name" className="mb-1 block text-xs text-[#b5b5bd]">
          Integration name
        </label>
        <input
          id="linear-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Linear"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 text-sm text-white outline-none focus:border-[#3B82F6]"
        />
      </div>

      <div>
        <label htmlFor="linear-api-key" className="mb-1 block text-xs text-[#b5b5bd]">
          API key
        </label>
        <input
          id="linear-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="lin_api_..."
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!apiKey || prefilling}
          onClick={handlePrefill}
        >
          {prefilling ? 'Connecting…' : 'Connect & auto-detect teams'}
        </Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {teams.length > 0 && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-[#b5b5bd]">Default team</label>
            <select
              value={defaultTeamKey}
              onChange={(e) => setDefaultTeamKey(e.target.value)}
              className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 text-sm text-white outline-none focus:border-[#3B82F6]"
            >
              {teams.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} ({t.key})
                </option>
              ))}
            </select>
          </div>

          {teams.map((team) => {
            const teamMap = statusMapByTeam[team.key] ?? {};
            return (
              <details key={team.key} open={team.key === defaultTeamKey}>
                <summary className="cursor-pointer py-1 text-sm text-white">
                  {team.name} ({team.key})
                </summary>
                <div className="mt-2 space-y-2 pl-3">
                  {WORKFLOW_STATUSES.map((wf) => (
                    <div key={wf.key} className="flex items-center gap-2">
                      <span className="w-32 text-xs text-[#b5b5bd]">{wf.label}</span>
                      <select
                        value={teamMap[wf.key] ?? ''}
                        onChange={(e) => setMapping(team.key, wf.key, e.target.value || undefined)}
                        className="flex-1 border border-glass-edge bg-[#0B0C0F] px-2 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
                      >
                        <option value="">— unmapped —</option>
                        {team.states.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !apiKey}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function toLinearConfig(row: IntegrationRow): LinearConfig {
  return row.config as unknown as LinearConfig;
}
