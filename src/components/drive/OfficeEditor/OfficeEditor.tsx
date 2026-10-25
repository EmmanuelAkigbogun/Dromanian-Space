import { useEffect, useId, useState } from 'react';
import { api } from '@/features/platform/client';
import styles from './OfficeEditor.module.css';

interface DocEditor {
  destroyEditor: () => void;
}

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => DocEditor };
  }
}

const OFFICE_EXTENSIONS = new Set([
  'docx', 'docm', 'dotx', 'odt', 'rtf', 'txt', 'doc',
  'xlsx', 'xlsm', 'xltx', 'ods', 'csv', 'xls',
  'pptx', 'pptm', 'potx', 'odp', 'ppsx', 'ppt',
]);

export function isOfficeFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && OFFICE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

let editorScript: Promise<void> | null = null;

function loadEditorScript(src: string): Promise<void> {
  if (window.DocsAPI) return Promise.resolve();
  editorScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      editorScript = null;
      reject(new Error('The document editor could not be loaded. It may still be starting on the server.'));
    };
    document.head.appendChild(script);
  });
  return editorScript;
}

/**
 * ONLYOFFICE editor for a Drive file. Saves go back to Drive as new versions
 * (automatically while editing, and when everyone closes the document).
 */
export function OfficeEditor({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const containerId = `office-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [error, setError] = useState('');
  const [canEdit, setCanEdit] = useState<boolean | null>(null);

  useEffect(() => {
    let editor: DocEditor | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api('office/config', { item_id: itemId });
        const body = (await response.json()) as { config: Record<string, unknown>; editor_url: string; can_edit: boolean };
        await loadEditorScript(body.editor_url);
        if (cancelled || !window.DocsAPI) return;
        setCanEdit(body.can_edit);
        editor = new window.DocsAPI.DocEditor(containerId, { ...body.config, width: '100%', height: '100%' });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The document could not be opened.');
      }
    })();
    return () => {
      cancelled = true;
      editor?.destroyEditor();
    };
  }, [itemId, containerId]);

  return (
    <section className={styles.editor}>
      <div className={styles.bar}>
        <span className={styles.status}>
          {error ? 'Editor unavailable' : canEdit === null ? 'Opening…' : canEdit ? 'Editing · changes save to Drive as new versions' : 'View only'}
        </span>
        <button type="button" className={styles.close} onClick={onClose}>
          Close editor
        </button>
      </div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : <div className={styles.frame}><div id={containerId} /></div>}
    </section>
  );
}
