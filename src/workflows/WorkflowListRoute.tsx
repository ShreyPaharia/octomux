import { useParams } from 'react-router-dom';
import { getWorkflowUI } from './registry';

export default function WorkflowListRoute() {
  const { kind } = useParams<{ kind: string }>();
  const ui = kind ? getWorkflowUI(kind) : undefined;

  if (!ui) {
    return <p className="p-6 text-sm text-muted-foreground">Unknown workflow kind: {kind}</p>;
  }
  if (!ui.ListView) {
    return <p className="p-6 text-sm text-muted-foreground">{ui.navLabel} has no list view.</p>;
  }
  const ListView = ui.ListView;
  return <ListView />;
}
