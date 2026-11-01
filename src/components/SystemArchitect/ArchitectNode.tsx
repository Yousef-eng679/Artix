import { memo, useEffect, useState } from 'react';
import { Handle, Position, NodeProps, useReactFlow } from '@xyflow/react';
import {
  Database, Server, Monitor, Cloud, Cpu, HardDrive,
  LayoutList, ArrowUpDown, Repeat, Split,
  GitBranch, Circle, CheckCircle, ListOrdered, Layers,
  Link, Hash, Triangle, Variable, MousePointer,
  HelpCircle, Terminal, Palette,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Database, Server, Monitor, Cloud, Cpu, HardDrive,
  LayoutList, ArrowUpDown, Repeat, Split,
  GitBranch, Circle, CheckCircle, ListOrdered, Layers,
  Link, Hash, Triangle, Variable, MousePointer,
  HelpCircle, Terminal, Palette,
};

const colorMap: Record<string, string> = {
  blue: 'bg-blue-500/20 border-blue-500/50 text-blue-400',
  green: 'bg-green-500/20 border-green-500/50 text-green-400',
  purple: 'bg-purple-500/20 border-purple-500/50 text-purple-400',
  cyan: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400',
  orange: 'bg-orange-500/20 border-orange-500/50 text-orange-400',
  pink: 'bg-pink-500/20 border-pink-500/50 text-pink-400',
};

const handleStyle = {
  background: '#F59E0B',
  border: '2px solid #D97706',
  width: 12,
  height: 12,
  transition: 'all 0.2s ease',
};

function ArchitectNodeComponent({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const [isEditing, setIsEditing] = useState(false);
  const [label, setLabel] = useState((data.label as string) ?? '');

  useEffect(() => {
    if (!isEditing) {
      setLabel((data.label as string) ?? '');
    }
  }, [data.label, isEditing]);

  const commitLabel = () => {
    setIsEditing(false);
    const currentDataLabel = (data.label as string) ?? '';
    if (label !== currentDataLabel) {
      updateNodeData(id, { label });
    }
  };

  const Icon = iconMap[data.icon as string] || Database;
  const colorClass = colorMap[data.color as string] || colorMap.blue;

  return (
    <div
      className={cn(
        'architect-node px-4 py-3 rounded-lg border-2 min-w-[140px] transition-all',
        colorClass,
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
      )}
      onDoubleClick={() => setIsEditing(true)}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={handleStyle}
        className="!rounded-full hover:!shadow-[0_0_8px_#F59E0B] hover:!scale-125"
      />

      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 shrink-0" />
        {isEditing ? (
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitLabel();
              } else if (e.key === 'Escape') {
                setLabel((data.label as string) ?? '');
                setIsEditing(false);
              }
            }}
            className="h-6 text-sm p-1"
            autoFocus
          />
        ) : (
          <span className="font-medium text-sm truncate">{label}</span>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={handleStyle}
        className="!rounded-full hover:!shadow-[0_0_8px_#F59E0B] hover:!scale-125"
      />
    </div>
  );
}

export const ArchitectNode = memo(ArchitectNodeComponent);
