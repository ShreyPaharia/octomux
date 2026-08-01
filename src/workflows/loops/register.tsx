import { lazy } from 'react';
import { registerWorkflowUI } from '../registry';
import { LoopsIcon } from '@/components/sidebar/glyphs';

const LoopsPage = lazy(() => import('@/pages/LoopsPage'));
const LoopDetailPage = lazy(() => import('@/pages/LoopDetailPage'));

registerWorkflowUI('loops', {
  navLabel: 'Loops',
  icon: LoopsIcon,
  ListView: LoopsPage,
  DetailView: LoopDetailPage,
});
