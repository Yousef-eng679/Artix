import React from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface WorkspaceSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export const WorkspaceSearch: React.FC<WorkspaceSearchProps> = ({
  value,
  onChange,
  placeholder = 'Search project resources...',
  className,
}) => {
  return (
    <div className={`relative flex items-center w-full ${className || ''}`}>
      <Search className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 pr-7 text-xs bg-muted/30 border-border/50 focus-visible:ring-1 focus-visible:ring-primary/40 rounded-md placeholder:text-muted-foreground/60"
        aria-label="Search resources"
      />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onChange('')}
          className="absolute right-1 h-5 w-5 rounded-sm hover:bg-transparent text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
};
