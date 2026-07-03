import express from 'express';
import type { Request, Response } from 'express';
import {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
} from '../integrations/store.js';
import { listProviders, getProvider } from '../integrations/registry.js';
import { maskIntegration, mergeMaskedConfig } from '../integrations/mask.js';
import { badRequest, notFound, ServiceError } from '../services/errors.js';
// Side-effect: ensure all providers are registered when the API is loaded.
import '../integrations/index.js';

export const router = express.Router();

// GET /api/integrations/providers — list registered providers with their schemas
router.get('/api/integrations/providers', (_req: Request, res: Response) => {
  const providers = listProviders().map((p) => ({
    kind: p.kind,
    displayName: p.displayName,
    configSchema: p.configSchema,
    events: p.events,
  }));
  res.json(providers);
});

// GET /api/integrations — list all configured integrations (config masked)
router.get('/api/integrations', (_req: Request, res: Response) => {
  const integrations = listIntegrations();
  const masked = integrations.map((i) => {
    const provider = getProvider(i.kind);
    if (!provider) return i;
    return maskIntegration(i, provider.configSchema);
  });
  res.json(masked);
});

// POST /api/integrations — create a new integration
router.post('/api/integrations', (req: Request, res: Response) => {
  const body = req.body as { kind?: string; name?: string; config?: unknown };
  if (!body.kind?.trim()) {
    throw badRequest('kind is required');
  }
  if (!body.name?.trim()) {
    throw badRequest('name is required');
  }
  const provider = getProvider(body.kind);
  if (!provider) {
    throw badRequest(`unknown integration kind: ${body.kind}`);
  }
  const validation = provider.validate(body.config ?? {});
  if (!validation.ok) {
    throw new ServiceError('config validation failed', 400, {
      error: 'config validation failed',
      details: validation.errors,
    });
  }
  const integration = createIntegration(body.kind, body.name, body.config ?? {});
  res.status(201).json(maskIntegration(integration, provider.configSchema));
});

// PATCH /api/integrations/:id — update an integration
router.patch('/api/integrations/:id', (req: Request, res: Response) => {
  const id = (req.params as Record<string, string>).id;
  const existing = getIntegration(id);
  if (!existing) {
    throw notFound('Integration not found');
  }
  const provider = getProvider(existing.kind);
  const body = req.body as { name?: string; config?: unknown; enabled?: boolean };
  const patch: { name?: string; config?: unknown; enabled?: boolean } = {};

  if (body.name !== undefined) patch.name = body.name;
  if (body.enabled !== undefined) patch.enabled = body.enabled;

  if (body.config !== undefined) {
    const mergedConfig = provider
      ? mergeMaskedConfig(existing.config, body.config, provider.configSchema)
      : (body.config as Record<string, unknown>);
    const validation = provider ? provider.validate(mergedConfig) : { ok: true };
    if (!validation.ok) {
      throw new ServiceError('config validation failed', 400, {
        error: 'config validation failed',
        details: (validation as { errors?: string[] }).errors,
      });
    }
    patch.config = mergedConfig;
  }

  const updated = updateIntegration(id, patch);
  if (!updated) {
    throw notFound('Integration not found');
  }
  res.json(provider ? maskIntegration(updated, provider.configSchema) : updated);
});

// DELETE /api/integrations/:id
router.delete('/api/integrations/:id', (req: Request, res: Response) => {
  const id = (req.params as Record<string, string>).id;
  const existing = getIntegration(id);
  if (!existing) {
    throw notFound('Integration not found');
  }
  deleteIntegration(id);
  res.status(204).send();
});

// POST /api/integrations/linear/prefill — fetch teams/states and build a prefilled config map
router.post('/api/integrations/linear/prefill', async (req: Request, res: Response) => {
  const body = req.body as { api_key?: string };
  const apiKey = body.api_key?.trim();
  if (!apiKey) {
    throw badRequest('api_key is required');
  }
  try {
    const { prefillFromLinear } = await import('../integrations/linear/prefill.js');
    const result = await prefillFromLinear(apiKey);
    res.json(result);
  } catch (err) {
    throw new ServiceError((err as Error).message, 502);
  }
});

// POST /api/integrations/:id/test — test the connection using stored (unmasked) config
router.post('/api/integrations/:id/test', async (req: Request, res: Response) => {
  const id = (req.params as Record<string, string>).id;
  const existing = getIntegration(id);
  if (!existing) {
    throw notFound('Integration not found');
  }
  const provider = getProvider(existing.kind);
  if (!provider) {
    throw badRequest(`no provider for kind: ${existing.kind}`);
  }
  if (!provider.test) {
    res.json({ ok: true, message: 'Provider does not support connection testing' });
    return;
  }
  try {
    const result = await provider.test(existing.config);
    res.json(result);
  } catch (err) {
    throw new ServiceError((err as Error).message, 500, {
      ok: false,
      message: (err as Error).message,
    });
  }
});
