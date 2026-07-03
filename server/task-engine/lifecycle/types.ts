export interface AddAgentOpts {
  prompt?: string;
  agent?: string | null;
  label?: string;
  model?: string | null;
  skeleton?: string;
  notify_agent_id?: string | null;
}
