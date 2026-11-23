import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import './monacoSetup';
import MonacoEditor from '@monaco-editor/react';
import { EditorToolbar } from './EditorToolbar';
import { MarkdownPreview } from './MarkdownPreview';
import { DocumentFormat, getLanguageConfig } from './languageMap';
import { useAutoSave } from '@/lib/autosave';
import { clearDraft, getRecoverableDraft } from '@/lib/cache/draftRecovery';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';
import { StaleBufferError } from '@/lib/local/errors';
import { motion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  project_id?: string | null;
  folder_id?: string | null;
  local_revision?: number;
}

interface EditorProps {
  document: Document;
  onSave: (doc: Partial<Document> & { expectedLocalRevision?: number }) => Promise<unknown>;
  onSaveAsCopy?: (copy: {
    title: string;
    content: string;
    format: DocumentFormat;
  }) => Promise<unknown>;
  onBack: () => void;
  projectId?: string;
}

export function Editor({ document, onSave, onSaveAsCopy, onBack, projectId }: EditorProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [title, setTitle] = useState(document.title);
  const [content, setContent] = useState(() => {
    const recovered = getRecoverableDraft(document.id, document.content);
    return recovered ?? document.content;
  });
  const [format, setFormat] = useState<DocumentFormat>(document.format);
  const [staleRemoteDoc, setStaleRemoteDoc] = useState<Document | null>(null);
  const [showPreview, setShowPreview] = useState(() => {
    try {
      const stored = localStorage.getItem('artix.editor.showPreview');
      return stored !== null ? stored === 'true' : true;
    } catch {
      return true;
    }
  });
  const [prdOpen, setPrdOpen] = useState(false);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  // Track base revision & snapshot from which the current local buffer was derived
  const baseRef = useRef({
    localRevision: document.local_revision,
    updatedAt: document.updated_at,
    title: document.title,
    content: document.content,
    format: document.format,
  });

  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const formatRef = useRef(format);
  const staleRef = useRef<Document | null>(null);
  const latestPropDocRef = useRef(document);
  latestPropDocRef.current = document;

  const isBufferDirty = useCallback(() => {
    return (
      contentRef.current !== baseRef.current.content ||
      titleRef.current !== baseRef.current.title ||
      formatRef.current !== baseRef.current.format
    );
  }, []);

  const handleTogglePreview = useCallback(() => {
    setShowPreview((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('artix.editor.showPreview', String(next));
      } catch {
        // Silently ignore storage errors (e.g. private browsing or quota limits)
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (searchParams.get('vibe') === 'true') {
      setVibeOpen(true);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('vibe');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const cancelSaveRef = useRef<() => void>(() => {});

  const handleSave = useCallback(
    async (contentToSave: string) => {
      if (staleRef.current) {
        return;
      }

      const currentTitle = titleRef.current;
      const currentFormat = formatRef.current;
      const expectedLocalRevision = baseRef.current.localRevision;

      try {
        const res = (await onSave({
          id: document.id,
          title: currentTitle,
          content: contentToSave,
          format: currentFormat,
          ...(expectedLocalRevision !== undefined ? { expectedLocalRevision } : {}),
        })) as Partial<Document> | undefined;

        baseRef.current = {
          localRevision: res?.local_revision ?? baseRef.current.localRevision,
          updatedAt: res?.updated_at ?? baseRef.current.updatedAt,
          title: currentTitle,
          content: contentToSave,
          format: currentFormat,
        };
      } catch (err: any) {
        if (err instanceof StaleBufferError || err?.code === 'STALE_BUFFER') {
          cancelSaveRef.current();
          staleRef.current = latestPropDocRef.current;
          setStaleRemoteDoc(latestPropDocRef.current);
        }
        throw err;
      }
    },
    [document.id, onSave],
  );

  const { status, triggerSave, cancelSave } = useAutoSave({
    delay: 1500,
    onSave: handleSave,
    documentId: document.id,
  });
  cancelSaveRef.current = cancelSave;

  // Flush recovered local draft on mount if one was restored
  const didCheckRecoveryRef = useRef(false);
  useEffect(() => {
    if (didCheckRecoveryRef.current) return;
    didCheckRecoveryRef.current = true;
    if (contentRef.current !== document.content) {
      triggerSave(contentRef.current);
    }
  }, [document.content, triggerSave]);

  // Reconcile incoming remote / cross-tab updates against clean vs dirty local buffer
  useEffect(() => {
    const revisionChanged =
      document.local_revision !== undefined &&
      baseRef.current.localRevision !== undefined &&
      document.local_revision !== baseRef.current.localRevision;
    const payloadDiffersFromBase =
      document.content !== baseRef.current.content ||
      document.title !== baseRef.current.title ||
      document.format !== baseRef.current.format;

    if (!revisionChanged && !payloadDiffersFromBase) {
      if (document.local_revision !== undefined) {
        baseRef.current.localRevision = document.local_revision;
      }
      baseRef.current.updatedAt = document.updated_at;
      return;
    }

    if (!isBufferDirty() && !staleRef.current) {
      contentRef.current = document.content;
      titleRef.current = document.title;
      formatRef.current = document.format;
      setContent(document.content);
      setTitle(document.title);
      setFormat(document.format);
      baseRef.current = {
        localRevision: document.local_revision,
        updatedAt: document.updated_at,
        title: document.title,
        content: document.content,
        format: document.format,
      };
    } else {
      cancelSave();
      staleRef.current = document;
      setStaleRemoteDoc(document);
    }
  }, [
    document,
    document.local_revision,
    document.updated_at,
    document.title,
    document.content,
    document.format,
    isBufferDirty,
    cancelSave,
  ]);

  const handleLoadRemote = useCallback(() => {
    const target = staleRef.current || latestPropDocRef.current;
    cancelSave();
    clearDraft(document.id);
    dirtyTracker.markClean(document.id);

    contentRef.current = target.content;
    titleRef.current = target.title;
    formatRef.current = target.format;
    setContent(target.content);
    setTitle(target.title);
    setFormat(target.format);

    baseRef.current = {
      localRevision: target.local_revision,
      updatedAt: target.updated_at,
      title: target.title,
      content: target.content,
      format: target.format,
    };
    staleRef.current = null;
    setStaleRemoteDoc(null);
  }, [document.id, cancelSave]);

  const handleKeepMine = useCallback(async () => {
    const target = staleRef.current || latestPropDocRef.current;
    baseRef.current.localRevision = target.local_revision;
    baseRef.current.updatedAt = target.updated_at;
    staleRef.current = null;
    setStaleRemoteDoc(null);
    await handleSave(contentRef.current);
  }, [handleSave]);

  const handleSaveMineAsCopy = useCallback(async () => {
    if (!onSaveAsCopy) return;
    await onSaveAsCopy({
      title: `${titleRef.current} (Copy)`,
      content: contentRef.current,
      format: formatRef.current,
    });
    handleLoadRemote();
  }, [onSaveAsCopy, handleLoadRemote]);

  const handleContentChange = (value: string | undefined) => {
    const newContent = value ?? '';
    contentRef.current = newContent;
    setContent(newContent);
    if (!staleRef.current) {
      triggerSave(newContent);
    }
  };

  const handleFormatChange = (newFormat: DocumentFormat) => {
    formatRef.current = newFormat;
    setFormat(newFormat);
    if (!staleRef.current) {
      const expectedLocalRevision = baseRef.current.localRevision;
      onSave({
        id: document.id,
        format: newFormat,
        ...(expectedLocalRevision !== undefined ? { expectedLocalRevision } : {}),
      })
        .then((res: any) => {
          baseRef.current.format = newFormat;
          if (res?.local_revision !== undefined) {
            baseRef.current.localRevision = res.local_revision;
          }
          if (res?.updated_at) {
            baseRef.current.updatedAt = res.updated_at;
          }
        })
        .catch((err: any) => {
          if (err instanceof StaleBufferError || err?.code === 'STALE_BUFFER') {
            cancelSave();
            staleRef.current = latestPropDocRef.current;
            setStaleRemoteDoc(latestPropDocRef.current);
          }
        });
    }
  };

  const handleTitleChange = (newTitle: string) => {
    titleRef.current = newTitle;
    setTitle(newTitle);
    if (!staleRef.current) {
      triggerSave(contentRef.current);
    }
  };

  const handleManualSave = () => {
    if (!staleRef.current) {
      handleSave(contentRef.current);
    }
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
        showPreview={showPreview}
        onTogglePreview={handleTogglePreview}
      />

      {staleRemoteDoc && (
        <div
          data-testid="stale-buffer-banner"
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-amber-500/40 bg-amber-500/10 text-sm text-foreground"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              Remote updates arrived while you have unsaved edits. Auto-save is paused to prevent overwriting remote work.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleLoadRemote}>
              Load remote (discard mine)
            </Button>
            <Button size="sm" variant="default" onClick={handleKeepMine}>
              Keep mine
            </Button>
            {onSaveAsCopy && (
              <Button size="sm" variant="secondary" onClick={handleSaveMineAsCopy}>
                Save mine as copy
              </Button>
            )}
          </div>
        </div>
      )}

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
        {format === 'markdown' && showPreview ? (
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
        )}
      </div>
    </motion.div>
  );
}
