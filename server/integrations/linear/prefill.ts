import { linearGraphql } from './graphql.js';

interface LinearState {
  id: string;
  name: string;
  type: string;
}

interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: { nodes: LinearState[] };
}

interface TeamsResponse {
  teams: { nodes: LinearTeam[] };
}

const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes {
        id
        key
        name
        states {
          nodes { id name type }
        }
      }
    }
  }
`;

const COLUMN_PATTERNS: Record<string, RegExp> = {
  backlog: /^backlog$/i,
  planned: /^(todo|planned)$/i,
  in_progress: /^(in[- ]?progress|in[- ]?development)$/i,
  human_review: /^(in[- ]?review|review)$/i,
  // pr handled same as human_review below
};

export interface PrefillResult {
  teams: Array<{
    id: string;
    key: string;
    name: string;
    states: LinearState[];
  }>;
  status_map_by_team: Record<
    string,
    Partial<Record<'backlog' | 'planned' | 'in_progress' | 'human_review' | 'pr' | 'done', string>>
  >;
  default_team_suggestion: string | null;
}

function pickByName(states: LinearState[], pattern: RegExp): string | undefined {
  const match = states.find((s) => pattern.test(s.name.trim()));
  return match?.id;
}

function pickDone(states: LinearState[]): string | undefined {
  // Prefer a state literally named "Done"; otherwise the first completed-type state.
  const byName = states.find((s) => /^done$/i.test(s.name.trim()));
  if (byName) return byName.id;
  const byType = states.find((s) => s.type === 'completed');
  return byType?.id;
}

export async function prefillFromLinear(apiKey: string): Promise<PrefillResult> {
  const data = await linearGraphql<TeamsResponse>(apiKey, TEAMS_QUERY);
  const teamsRaw = data.teams?.nodes ?? [];

  const teams = teamsRaw.map((t) => ({
    id: t.id,
    key: t.key,
    name: t.name,
    states: t.states.nodes,
  }));

  const status_map_by_team: PrefillResult['status_map_by_team'] = {};
  for (const t of teams) {
    const map: Partial<Record<string, string>> = {};
    for (const [col, pattern] of Object.entries(COLUMN_PATTERNS)) {
      const id = pickByName(t.states, pattern);
      if (id) map[col] = id;
    }
    // pr defaults to the human_review choice (Linear rarely has a distinct PR state).
    if (map.human_review) map.pr = map.human_review;
    const done = pickDone(t.states);
    if (done) map.done = done;
    status_map_by_team[t.key] = map as PrefillResult['status_map_by_team'][string];
  }

  const default_team_suggestion = teams.find((t) => t.key === 'BAC')?.key ?? teams[0]?.key ?? null;

  return { teams, status_map_by_team, default_team_suggestion };
}
