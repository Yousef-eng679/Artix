import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/common/standaloneStrings';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/xml/register';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import loader from '@monaco-editor/loader';

const globalScope = globalThis as typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, _label: string) => Worker;
  };
};

if (!globalScope.MonacoEnvironment) {
  globalScope.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
}

loader.config({ monaco });

export { monaco };
