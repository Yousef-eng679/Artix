import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onSave: (newName: string) => Promise<void>;
  title: string;
  validate?: (newName: string) => string | null;
}

export function RenameDialog({
  open,
  onOpenChange,
  currentName,
  onSave,
  title,
  validate,
}: RenameDialogProps) {
  const [name, setName] = useState(currentName);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName(currentName);
      setError('');
    }
  }, [open, currentName]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    
    if (!trimmedName) {
      setError('Name cannot be empty');
      return;
    }
    
    if (trimmedName.length > 100) {
      setError('Name must be less than 100 characters');
      return;
    }

    if (validate) {
      const validationError = validate(trimmedName);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    setIsSaving(true);
    try {
      await onSave(trimmedName);
      onOpenChange(false);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="rename-input">Name</Label>
            <Input
              id="rename-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
              placeholder="Enter a name..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isSaving) {
                  handleSave();
                }
              }}
              autoFocus
            />
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
