/** JSON Schema for prod-log-triage schedule instance config. */
export const PROD_LOG_TRIAGE_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    logCommand: {
      type: 'string',
      title: 'Log command',
      description: 'Command whose output the triage agent inspects.',
      default: 'gh run list --limit 20 --json databaseId,conclusion,name,url',
    },
    verify: {
      type: 'string',
      title: 'Verify command',
      description:
        'Shell command that exits 0 when triage work is complete (scoped to the task branch).',
      default:
        'test -f "desk/incidents/$(date +%F).md" && [ -n "$(gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state open --json number --jq \'.[0].number\')" ]',
    },
    maxIterations: {
      type: 'integer',
      title: 'Max iterations',
      minimum: 1,
      default: 5,
    },
  },
  additionalProperties: false,
};
