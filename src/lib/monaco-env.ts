// Configures Monaco's web-worker factory for Vite. Without this, the diff
// editor cannot run its diff worker and renders both sides as plain text
// (no line-level red/green highlights, no +/- gutter glyphs).
//
// We only use the diff editor — no language services — so the editor worker
// is sufficient for every label. Expand this switch if TS/JSON/CSS workers
// are ever needed.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (workerId: string, label: string) => Worker;
    };
  }
}

if (typeof self !== 'undefined' && !self.MonacoEnvironment) {
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}
