import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Hook to manage project workspace navigation via URL query parameters.
 *
 * History rules:
 * - openDocument(id): PUSH history (?doc=<id>)
 * - openDesign(id): PUSH history (?design=<id>)
 * - openOverview(): REPLACE history (clears doc, design, action)
 */
export function useWorkspaceNavigation() {
  const [searchParams, setSearchParams] = useSearchParams();

  const openOverview = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('doc');
    nextParams.delete('design');
    nextParams.delete('action');
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const openDocument = useCallback(
    (docId: string) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('doc', docId);
      nextParams.delete('design');
      nextParams.delete('action');
      setSearchParams(nextParams);
    },
    [searchParams, setSearchParams]
  );

  const openDesign = useCallback(
    (designId: string) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('design', designId);
      nextParams.delete('doc');
      nextParams.delete('action');
      setSearchParams(nextParams);
    },
    [searchParams, setSearchParams]
  );

  return {
    openOverview,
    openDocument,
    openDesign,
  };
}
