import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { type Column, type CrmRecord, type Kind } from './model';
import { Avatar, PropertyList } from './ui';
import s from './CRM.module.css';

/** HubSpot's record preview: a side panel to read and edit a row without leaving the list. */
export function Preview({ kind, record, columns, editable, suggestions, onSave, onClose, book }: {
  kind: Kind; record: CrmRecord; columns: Column[]; editable: boolean; suggestions: Record<string, string[]>;
  onSave: (record: CrmRecord, column: Column, value: unknown) => Promise<void>; onClose: () => void; book: string;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,select,textarea')) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <>
      <div className={s.drawerScrim} onClick={onClose} aria-hidden="true" />
      <aside className={s.drawer} role="dialog" aria-label={`${record.name} preview`}>
        <header className={s.drawerHead}>
          <span className={s.eyebrow}>{kind === 'companies' ? 'Company' : kind === 'contacts' ? 'Contact' : 'Deal'} preview</span>
          <button className={s.ghost} onClick={onClose} aria-label="Close preview">✕</button>
        </header>
        <div className={s.drawerIdentity}>
          <Avatar name={record.name} kind={kind} size="lg" />
          <h2>{record.name}</h2>
          <Link className={s.primary} to={`/crm/${kind}/${record.id}${book}`}>View record</Link>
        </div>
        <div className={s.drawerBody}>
          <PropertyList record={record} columns={columns} editable={editable} suggestions={suggestions} onSave={onSave} />
        </div>
      </aside>
    </>
  );
}
