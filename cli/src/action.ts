import type { Command } from 'commander';
import type { OctomuxClient } from './client.js';
import { isJsonMode } from './format.js';

export interface ActionContext {
  client: OctomuxClient;
  json: boolean;
}

export function getContext(cmd: Command): ActionContext {
  const globals = cmd.optsWithGlobals();
  return {
    client: globals._client as OctomuxClient,
    json: isJsonMode(globals.json as boolean | undefined),
  };
}
