import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '@/features/platform/client';
import styles from './OfficeEditor.module.css';
import {
  officeEditorError,
  officeEditorStatus,
  type OfficeEditorCapability,
  type OfficeEditorPhase,
} from './officeEditorState';

interface DocEditor {
  destroyEditor: () => void;
}

interface OfficeConfigResponse {
  config: Record<string, unknown>;
  editor_url: string;
  can_edit: boolean;
  capability?: OfficeEditorCapability;
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
  'pdf',
]);

export function isOfficeFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && OFFICE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

const SCRIPT_TIMEOUT_MS = 45_000;
const CONFIG_TIMEOUT_MS = 30_000;
let editorScript: { src: string; promise: Promise<void> } | null = null;

function loadEditorScript(src: string): Promise<void> {
  if (window.DocsAPI) return Promise.resolve();
  const absoluteSrc = new URL(src, window.location.href).href;
  if (editorScript?.src === absoluteSrc) return editorScript.promise;

  const promise = new Promise<void>((resolve, reject) => {
    document.querySelectorAll<HTMLScriptElement>('script[data-darkspace-office-editor]').forEach((script) => script.remove());
    const script = document.createElement('script');
    script.src = absoluteSrc;
    script.async = true;
    script.dataset.darkspaceOfficeEditor = 'true';

    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = window.setTimeout(
      () => finish(new Error('The document editor took too long to load. Please try again.')),
      SCRIPT_TIMEOUT_MS,
    );
    script.onload = () => finish(window.DocsAPI
      ? undefined
      : new Error('The document editor loaded but did not start. Please try again.'));
    script.onerror = () => finish(new Error('The document editor could not be loaded. It may still be starting on the server.'));
    document.head.appendChild(script);
  });
  editorScript = { src: absoluteSrc, promise };
  void promise.catch(() => {
    if (editorScript?.promise === promise) editorScript = null;
  });
  return promise;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), milliseconds);
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * ONLYOFFICE editor for a Drive file. Saves go back to Drive as new versions
 * (automatically while editing, and when everyone closes the document).
 */
export function OfficeEditor({ itemId, title, onClose }: { itemId: string; title: string; onClose: () => void }) {
  const containerId = `office-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [error, setError] = useState('');
  const [capability, setCapability] = useState<OfficeEditorCapability | null>(null);
  const [phase, setPhase] = useState<OfficeEditorPhase>('configuring');
  const [attempt, setAttempt] = useState(0);
  const editorRef = useRef<DocEditor | null>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const destroyEditor = useCallback(() => {
    const editor = editorRef.current;
    editorRef.current = null;
    if (!editor) return;
    try {
      editor.destroyEditor();
    } catch {
      // The iframe may already have removed itself after an editor error.
    }
  }, []);

  const closeEditor = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setPhase('closing');
    destroyEditor();
    onCloseRef.current();
  }, [destroyEditor]);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let editor: DocEditor | null = null;
    let readyTimeout = 0;
    closingRef.current = false;
    setError('');
    setCapability(null);
    setPhase('configuring');

    void (async () => {
      try {
        const response = await withTimeout(
          api('office/config', { item_id: itemId }),
          CONFIG_TIMEOUT_MS,
          'The server took too long to prepare this document. Please try again.',
        );
        const body = (await response.json()) as OfficeConfigResponse;
        if (!body?.config || typeof body.editor_url !== 'string' || typeof body.can_edit !== 'boolean') {
          throw new Error('The server returned an invalid editor configuration.');
        }
        if (cancelled) return;
        setPhase('loading');
        await loadEditorScript(body.editor_url);
        if (cancelled || !window.DocsAPI) return;
        setCapability(body.capability ?? (body.can_edit ? 'edit' : 'view'));
        setPhase('opening');
        const events = {
          onAppReady: () => {
            if (!cancelled && !failed) {
              window.clearTimeout(readyTimeout);
              setPhase('ready');
            }
          },
          onDocumentReady: () => {
            if (!cancelled && !failed) {
              window.clearTimeout(readyTimeout);
              setPhase('ready');
            }
          },
          onDocumentStateChange: (event: { data?: unknown }) => {
            if (!cancelled && !failed) setPhase(event.data === true ? 'saving' : 'ready');
          },
          onError: (event: unknown) => {
            if (!cancelled) {
              failed = true;
              window.clearTimeout(readyTimeout);
              setError(officeEditorError(event));
              setPhase('failed');
            }
          },
          onRequestClose: () => {
            if (!cancelled) closeEditor();
          },
        };
        readyTimeout = window.setTimeout(() => {
          if (!cancelled && !failed) {
            failed = true;
            setError('The document editor did not finish opening. Please try again.');
            setPhase('failed');
          }
        }, SCRIPT_TIMEOUT_MS);
        editor = new window.DocsAPI.DocEditor(containerId, {
          ...body.config,
          width: '100%',
          height: '100%',
          events,
        });
        editorRef.current = editor;
      } catch (err) {
        if (!cancelled) {
          failed = true;
          window.clearTimeout(readyTimeout);
          setError(err instanceof Error ? err.message : 'The document could not be opened.');
          setPhase('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(readyTimeout);
      if (editorRef.current === editor) destroyEditor();
    };
  }, [attempt, closeEditor, containerId, destroyEditor, itemId]);

  const status = officeEditorStatus(phase, capability);
  const loading = phase === 'configuring' || phase === 'loading' || phase === 'opening';
  const isPdf = title.toLowerCase().endsWith('.pdf');

  return (
    <section className={styles.editor} aria-busy={loading} aria-label={`${title} ${isPdf ? 'PDF tool' : 'document editor'}`}>
      <div className={styles.bar}>
        <div className={styles.fileInfo}>
          <strong className={styles.title} title={title}>{title}</strong>
          <span className={styles.status} aria-live="polite">{status}</span>
        </div>
        <button type="button" className={styles.close} onClick={closeEditor} disabled={phase === 'closing'}>
          Back to details
        </button>
      </div>
      <div className={styles.workspace}>
        <div className={styles.frame}><div id={containerId} /></div>
        {loading && (
          <div className={styles.loading} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <strong>{status}</strong>
            <span>This can take a moment the first time the editor starts.</span>
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            <strong>We couldn’t open this document</strong>
            <span>{error}</span>
            <div className={styles.errorActions}>
              <button type="button" className={styles.retry} onClick={() => setAttempt((value) => value + 1)}>Try again</button>
              <button type="button" className={styles.secondary} onClick={closeEditor}>
                {isPdf ? 'Use basic PDF viewer' : 'Back to details'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
