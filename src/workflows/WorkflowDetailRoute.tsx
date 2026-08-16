import { useParams } from 'react-router-dom';
import { getWorkflowUI } from './registry';
import { DefaultDetailView } from './DefaultDetailView';

export default function WorkflowDetailRoute() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const ui = kind ? getWorkflowUI(kind) : undefined;

  if (!ui || !id) {
    return <p className="p-6 text-sm text-muted-foreground">Unknown workflow kind: {kind}</p>;
  }
  if (ui.DetailView) {
    const DetailView = ui.DetailView;
    return <DetailView id={id} />;
  }
  if (ui.getItem && ui.outputSchema) {
    return (
      <DefaultDetailView
        id={id}
        displayName={ui.navLabel}
        outputSchema={ui.outputSchema}
        getItem={ui.getItem}
      />
    );
  }
  return (
    <p className="p-6 text-sm text-muted-foreground">
      {ui.navLabel} registered no DetailView and no schema-driven fallback data.
    </p>
  );
}
