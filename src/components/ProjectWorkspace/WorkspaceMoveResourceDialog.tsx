import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Folder, HardDrive } from 'lucide-react';
import { WorkspaceFolder } from '@/types/workspace';

export interface WorkspaceMoveResourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceTitle: string;
  currentFolderId: string | null;
  folders: WorkspaceFolder[];
  onMove: (targetFolderId: string | null) => Promise<void>;
}

export function WorkspaceMoveResourceDialog({
  open,
  onOpenChange,
  resourceTitle,
  currentFolderId,
  folders,
  onMove,
}: WorkspaceMoveResourceDialogProps) {
  const [selectedValue, setSelectedValue] = useState<string>(
    currentFolderId ?? '__root__'
  );
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setSelectedValue(currentFolderId ?? '__root__');
      setError('');
    }
  }, [open, currentFolderId]);

  const handleMove = async () => {
    const targetFolderId = selectedValue === '__root__' ? null : selectedValue;
    if (targetFolderId === currentFolderId) {
      onOpenChange(false);
      return;
    }

    setIsMoving(true);
    setError('');
    try {
      await onMove(targetFolderId);
      onOpenChange(false);
    } catch {
      setError('Failed to move resource. Please try again.');
    } finally {
      setIsMoving(false);
    }
  };

  const isCurrentSelection =
    (selectedValue === '__root__' && currentFolderId === null) ||
    selectedValue === currentFolderId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move &ldquo;{resourceTitle}&rdquo;</DialogTitle>
        </DialogHeader>

        <div className="py-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Select a destination folder or move to project root:
          </p>

          <RadioGroup
            value={selectedValue}
            onValueChange={setSelectedValue}
            className="space-y-1.5 max-h-60 overflow-y-auto pr-1"
          >
            {/* Root Option */}
            <div
              className={`flex items-center space-x-3 p-2 rounded-lg border transition-colors cursor-pointer ${
                selectedValue === '__root__'
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/40 hover:bg-accent/30'
              }`}
              onClick={() => setSelectedValue('__root__')}
            >
              <RadioGroupItem value="__root__" id="target-root" />
              <Label
                htmlFor="target-root"
                className="flex items-center gap-2 text-xs font-medium cursor-pointer flex-1"
              >
                <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Project Root</span>
                {currentFolderId === null && (
                  <span className="text-[10px] text-muted-foreground ml-auto">(Current)</span>
                )}
              </Label>
            </div>

            {/* Folders */}
            {folders.map((f) => (
              <div
                key={f.id}
                className={`flex items-center space-x-3 p-2 rounded-lg border transition-colors cursor-pointer ${
                  selectedValue === f.id
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border/40 hover:bg-accent/30'
                }`}
                onClick={() => setSelectedValue(f.id)}
              >
                <RadioGroupItem value={f.id} id={`target-${f.id}`} />
                <Label
                  htmlFor={`target-${f.id}`}
                  className="flex items-center gap-2 text-xs font-medium cursor-pointer flex-1"
                >
                  <Folder className="h-3.5 w-3.5 text-amber-400" />
                  <span className="truncate">{f.name}</span>
                  {currentFolderId === f.id && (
                    <span className="text-[10px] text-muted-foreground ml-auto">(Current)</span>
                  )}
                </Label>
              </div>
            ))}
          </RadioGroup>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMoving}>
            Cancel
          </Button>
          <Button onClick={handleMove} disabled={isMoving || isCurrentSelection}>
            {isMoving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
