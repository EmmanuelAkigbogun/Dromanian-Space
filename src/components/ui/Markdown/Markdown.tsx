import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './Markdown.module.css';

// Renders the Markdown subset agents write (headings, lists, emphasis, code,
// tables, quotes, links) as React elements. Nothing is injected as HTML, and
// links are limited to in-app paths and http(s) URLs.

function safeHref(href: string): { internal: boolean; href: string } | null {
  const h = href.trim();
  if (/^\/(?!\/)/.test(h)) return { internal: true, href: h };
  if (/^https?:\/\//i.test(h)) return { internal: false, href: h };
  return null;
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (m[3]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const safe = safeHref(href);
      if (!safe) out.push(label);
      else if (safe.internal) out.push(<Link key={k} to={safe.href}>{label}</Link>);
      else out.push(<a key={k} href={safe.href} target="_blank" rel="noopener noreferrer">{label}</a>);
    } else out.push(<em key={k}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const content = inline(heading[2], key);
      blocks.push(level === 1 ? <h1 key={key}>{content}</h1> : level === 2 ? <h2 key={key}>{content}</h2> : <h3 key={key}>{content}</h3>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className={styles.tableWrap}>
          <table>
            <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, `${key}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const li = items.map((it, j) => <li key={j}>{inline(it, `${key}l${j}`)}</li>);
      blocks.push(ordered ? <ol key={key}>{li}</ol> : <ul key={key}>{li}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key}>{inline(quote.join(' '), key)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length === 0) {
      // A line no block rule consumed (for example a lone table row): render it as text.
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${key}p${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={`${styles.root} ${className ?? ''}`}>{blocks}</div>;
}
