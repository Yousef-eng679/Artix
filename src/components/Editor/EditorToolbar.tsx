import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { DocumentFormat, formatOptions, languageMap } from './languageMap';
import { SaveStatus } from '@/lib/autosave';
import { exportDocument, ExportFormat } from '@/lib/documentExport';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Save, 
  Download, 
  FileText, 
  Check, 
  Loader2, 
  AlertCircle,
  ArrowLeft,
  FileDown,
  FileCode,
  FileType,
  Sparkles,
  Wand2,
  Bot,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface EditorToolbarProps {
  title: string;
  content: string;
  format: DocumentFormat;
  saveStatus: SaveStatus;
  onFormatChange: (format: DocumentFormat) => void;
  onTitleChange: (title: string) => void;
  onSave: () => void;
  onBack: () => void;
  onGeneratePRD?: () => void;
  onGenerateVibe?: () => void;
  onGenerateAgentic?: () => void;
  showPreview?: boolean;
  onTogglePreview?: () => void;
}

const SaveIndicator = ({ status }: { status: SaveStatus }) => {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={status}
        initial={{ opacity: 0, y: -5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 5 }}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md",
          status === 'saving' && "text-muted-foreground",
          status === 'saved' && "text-success",
          status === 'error' && "text-destructive",
          status === 'idle' && "text-muted-foreground/50"
        )}
      >
        {status === 'saving' && (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Saving...</span>
          </>
        )}
        {status === 'saved' && (
          <>
            <Check className="h-3 w-3" />
            <span>Saved</span>
          </>
        )}
        {status === 'error' && (
          <>
            <AlertCircle className="h-3 w-3" />
            <span>Error</span>
          </>
        )}
        {status === 'idle' && (
          <span className="text-muted-foreground/40">Auto-save enabled</span>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export function EditorToolbar({
  title,
  content,
  format,
  saveStatus,
  onFormatChange,
  onTitleChange,
  onSave,
  onBack,
  onGeneratePRD,
  onGenerateVibe,
  onGenerateAgentic,
  showPreview = true,
  onTogglePreview,
}: EditorToolbarProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (exportAs: ExportFormat) => {
    setIsExporting(true);
    try {
      await exportDocument({ title, content, format, exportAs });
      toast.success(`Exported as ${exportAs.toUpperCase()}`);
    } catch (error) {
      console.error('Export failed:', error);
      toast.error('Failed to export document');
    } finally {
      setIsExporting(false);
    }
  };

  const nativeExtension = format === 'markdown' ? '.md' : format === 'xml' ? '.xml' : '.txt';

  return (
    <div className="flex items-center justify-between h-14 px-4 border-b border-border bg-card/50 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            className="bg-transparent border-none text-foreground font-medium text-sm focus:outline-none focus:ring-0 w-48 truncate"
            placeholder="Untitled Document"
          />
        </div>

        <Select value={format} onValueChange={(value) => onFormatChange(value as DocumentFormat)}>
          <SelectTrigger className="w-32 h-8 text-xs bg-secondary border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {formatOptions.map((f) => (
              <SelectItem key={f} value={f}>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-primary">{languageMap[f].icon}</span>
                  {languageMap[f].label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {format === 'markdown' && onTogglePreview && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onTogglePreview}
            className={cn(
              "h-8 px-2.5 text-xs gap-1.5 transition-colors border",
              showPreview
                ? "bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
                : "text-muted-foreground border-border/50 hover:text-foreground hover:bg-muted"
            )}
            title={showPreview ? "Hide Preview" : "Show Preview"}
            aria-label="Toggle markdown preview"
          >
            {showPreview ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Preview</span>
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <SaveIndicator status={saveStatus} />
        
        <Button
          variant="ghost"
          size="sm"
          onClick={onSave}
          className="text-muted-foreground hover:text-foreground"
        >
          <Save className="h-4 w-4 mr-1.5" />
          Save
        </Button>

        {onGeneratePRD && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onGeneratePRD}
            className="text-primary hover:text-primary"
          >
            <Sparkles className="h-4 w-4 mr-1.5" />
            Generate PRD
          </Button>
        )}

        {onGenerateVibe && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onGenerateVibe}
            className="text-primary hover:text-primary"
          >
            <Wand2 className="h-4 w-4 mr-1.5" />
            Vibe Prompt
          </Button>
        )}

        {onGenerateAgentic && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onGenerateAgentic}
            className="text-primary hover:text-primary"
          >
            <Bot className="h-4 w-4 mr-1.5" />
            Agentic Flow
          </Button>
        )}
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              disabled={isExporting}
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-1.5" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Export format
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleExport('pdf')} className="gap-2">
              <FileDown className="h-4 w-4 text-red-400" />
              <span>PDF Document</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport('html')} className="gap-2">
              <FileCode className="h-4 w-4 text-orange-400" />
              <span>HTML File</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleExport('native')} className="gap-2">
              <FileType className="h-4 w-4 text-blue-400" />
              <span>Native ({nativeExtension})</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
