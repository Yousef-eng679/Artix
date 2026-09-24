import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface CloseTabConfirmDialogProps {
  open: boolean;
  tabTitle?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const CloseTabConfirmDialog: React.FC<CloseTabConfirmDialogProps> = ({
  open,
  tabTitle,
  onConfirm,
  onCancel,
}) => {
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-semibold text-foreground">
              {tabTitle ? `"${tabTitle}"` : 'This resource'}
            </span>{' '}
            has unsaved changes. Closing this tab before auto-save completes may discard recent edits.
            Are you sure you want to close it?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep Tab Open</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Close Tab
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
