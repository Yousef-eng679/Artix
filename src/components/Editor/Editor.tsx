import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import MonacoEditor from '@monaco-editor/react';
import { EditorToolbar } from './EditorToolbar';
import { MarkdownPreview } from './MarkdownPreview';
import { DocumentFormat, getLanguageConfig } from './languageMap';
import { useAutoSave, SaveStatus } from '@/lib/autosave';
import { getRecoverableDraft } from '@/lib/cache/draftRecovery';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { PRDGeneratorDialog } from '@/components/AI/PRDGeneratorDialog';
import { VibeCodingDialog } from '@/components/AI/VibeCodingDialog';
import { AgenticWorkflowDialog } from '@/components/AI/AgenticWorkflowDialog';

export interface Document {
  id: string;
  title: string;
  content: string;
  format: DocumentFormat;
  updated_at: string;
}

interface EditorProps {
  document: Document;
  onSave: (doc: Partial<Document>) => Promise<void>;
  onBack: () => void;
  projectId?: string;
}

export function Editor({ document, onSave, onBack, projectId }: EditorProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [title, setTitle] = useState(document.title);
  const [content, setContent] = useState(() => {
    const recovered = getRecoverableDraft(document.id, document.content);
    return recovered ?? document.content;
  });
  const [format, setFormat] = useState<DocumentFormat>(document.format);
  const [prdOpen, setPrdOpen] = useState(false);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get('vibe') === 'true') {
      setVibeOpen(true);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('vibe');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);


  const handleSave = useCallback(
    async (contentToSave: string) => {
      await onSave({
        id: document.id,
        title,
        content: contentToSave,
        format,
      });
    },
    [document.id, title, format, onSave]
  );

  const { status, triggerSave } = useAutoSave({
    delay: 1500,
    onSave: handleSave,
    documentId: document.id,
  });

  // Flush recovered local draft to Supabase on mount if one was restored
  useEffect(() => {
    const recovered = getRecoverableDraft(document.id, document.content);
    if (recovered) {
      triggerSave(recovered);
    }
  }, [document.id, document.content, triggerSave]);

  const handleContentChange = (value: string | undefined) => {
    const newContent = value ?? '';
    setContent(newContent);
    triggerSave(newContent);
  };

  const handleFormatChange = (newFormat: DocumentFormat) => {
    setFormat(newFormat);
    // Trigger save with new format
    onSave({
      id: document.id,
      format: newFormat,
    });
  };

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
  };

  const handleManualSave = () => {
    handleSave(content);
  };

  const languageConfig = getLanguageConfig(format);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col h-screen bg-editor"
    >
      <EditorToolbar
        title={title}
        content={content}
        format={format}
        saveStatus={status}
        onFormatChange={handleFormatChange}
        onTitleChange={handleTitleChange}
        onSave={handleManualSave}
        onBack={onBack}
        onGeneratePRD={projectId ? () => setPrdOpen(true) : undefined}
        onGenerateVibe={projectId ? () => setVibeOpen(true) : undefined}
        onGenerateAgentic={projectId ? () => setAgentOpen(true) : undefined}
      />

      {projectId && (
        <>
          <PRDGeneratorDialog
            open={prdOpen}
            onOpenChange={setPrdOpen}
            sourceTitle={title}
            sourceContent={content}
            sourceDocumentId={document.id}
            projectId={projectId}
          />
          <VibeCodingDialog
            open={vibeOpen}
            onOpenChange={setVibeOpen}
            sourceTitle={title}
            sourceContent={content}
            sourceDocumentId={document.id}
            projectId={projectId}
          />
          <AgenticWorkflowDialog
            open={agentOpen}
            onOpenChange={setAgentOpen}
            sourceTitle={title}
            sourceContent={content}
            sourceDocumentId={document.id}
            projectId={projectId}
          />
        </>
      )}

      <div className="flex-1 overflow-hidden">
        {format === 'markdown' ? (
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel defaultSize={50} minSize={30}>
              <MonacoEditor
                height="100%"
                language={languageConfig.monacoLanguage}
                value={content}
                onChange={handleContentChange}
                theme="vs-dark"
                loading={
                  <div className="h-full flex items-center justify-center bg-editor text-muted-foreground gap-2">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    <span className="text-sm font-medium">Loading Monaco Editor...</span>
                  </div>
                }
                options={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: 14,
                  lineHeight: 24,
                  padding: { top: 16, bottom: 16 },
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  renderLineHighlight: 'line',
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  smoothScrolling: true,
                  tabSize: 2,
                  automaticLayout: true,
                  folding: true,
                  bracketPairColorization: { enabled: true },
                }}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={50} minSize={20}>
              <MarkdownPreview content={content} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <MonacoEditor
            height="100%"
            language={languageConfig.monacoLanguage}
            value={content}
            onChange={handleContentChange}
            theme="vs-dark"
            options={{
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 14,
              lineHeight: 24,
              padding: { top: 16, bottom: 16 },
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              smoothScrolling: true,
              tabSize: 2,
              automaticLayout: true,
              folding: true,
              bracketPairColorization: { enabled: true },
            }}
          />
        )}
      </div>
    </motion.div>
  );
}
