import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';

interface CreatePRDialogProps {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

type Step = 'configure' | 'review';

export function CreatePRDialog({ taskId, open, onOpenChange, onCreated }: CreatePRDialogProps) {
  const [step, setStep] = useState<Step>('configure');
  const [base, setBase] = useState('main');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep('configure');
    setBase('main');
    setTitle('');
    setBody('');
    setError(null);
    setLoading(false);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  };

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.previewPR(taskId, { base });
      setTitle(result.title);
      setBody(result.body);
      setBase(result.base);
      setStep('review');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.createPR(taskId, { base, title, body });
      handleOpenChange(false);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === 'configure' ? 'Create Pull Request' : 'Review PR'}</DialogTitle>
          <DialogDescription>
            {step === 'configure'
              ? 'Configure the base branch, then generate a PR description with Claude.'
              : 'Review and edit the generated PR title and description.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {step === 'configure' ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="base-branch">Base Branch</Label>
              <Input
                id="base-branch"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="main"
              />
            </div>
            <DialogFooter>
              <Button onClick={handleGenerate} disabled={loading || !base}>
                {loading ? 'Generating...' : 'Generate'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="pr-title">Title</Label>
                <Input
                  id="pr-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="feat(scope): description"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pr-body">Description</Label>
                <Textarea
                  id="pr-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={12}
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('configure')} disabled={loading}>
                Back
              </Button>
              <Button onClick={handleCreate} disabled={loading || !title || !body}>
                {loading ? 'Creating PR...' : 'Create PR'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
