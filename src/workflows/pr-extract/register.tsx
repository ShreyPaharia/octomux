import { lazy } from 'react';
import { PR_EXTRACT_OUTPUT_SCHEMA } from '@octomux/types';
import { registerWorkflowUI } from '../registry';
import { extractApi } from '@/lib/api/extractApi';
import { ExtractsIcon } from '@/components/sidebar/glyphs';

const ExtractsPage = lazy(() => import('@/pages/ExtractsPage'));

registerWorkflowUI('pr-extract', {
  navLabel: 'PR Extracts',
  icon: ExtractsIcon,
  ListView: ExtractsPage,
  // No custom DetailView registered — this kind is the reference case for the schema-driven
  // DefaultDetailView (pr-extract has no detail route/page today).
  getItem: (id) => extractApi.getExtract(id) as unknown as Promise<Record<string, unknown>>,
  outputSchema: PR_EXTRACT_OUTPUT_SCHEMA as Record<string, unknown>,
});
