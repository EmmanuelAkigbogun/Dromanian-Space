import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatMoney, type Deal, type Pipeline, type Stage } from './model';
import s from './CRM.module.css';

interface Props {
  deals: Deal[];
  stages: Stage[];
  pipelines: Pipeline[];
  pipelineId: string;
  onPipeline: (id: string) => void;
  companyName: (id: string | null) => string;
  canEdit: (deal: Deal) => boolean;
  onMove: (deal: Deal, stageId: string) => Promise<void>;
  book: string;
}

/** Deals as cards in their stage's column; drag a card to move it to another stage. */
export function DealsBoard({ deals, stages, pipelines, pipelineId, onPipeline, companyName, canEdit, onMove, book }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const columns = stages.filter((st) => st.pipeline_id === pipelineId).sort((a, b) => a.position - b.position);

  if (!pipelines.length) return <div className={s.empty}>No pipeline yet. An administrator can create one with “Stages”.</div>;

  return (
    <>
      {pipelines.length > 1 && (
        <div className={s.filters}>
          {pipelines.map((p) => (
            <button key={p.id} className={`${s.chip} ${p.id === pipelineId ? s.chipActive : ''}`} onClick={() => onPipeline(p.id)}>{p.name}</button>
          ))}
        </div>
      )}
      <div className={s.board}>
        {columns.map((stage) => {
          const inStage = deals.filter((d) => d.stage_id === stage.id);
          const total = inStage.reduce((sum, d) => sum + Number(d.value), 0);
          return (
            <section
              key={stage.id}
              className={`${s.column} ${s[`stage-${stage.color}`] ?? ''} ${over === stage.id ? s.columnOver : ''}`}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(stage.id); } }}
              onDragLeave={() => setOver((o) => (o === stage.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const deal = deals.find((d) => d.id === dragging);
                setDragging(null);
                if (deal && deal.stage_id !== stage.id) void onMove(deal, stage.id);
              }}
              aria-label={stage.name}
            >
              <header className={s.columnHead}>
                <span className={s.dot} />
                {stage.name}
                <span className={s.count}>{inStage.length}</span>
                {stage.is_won && <span className={s.badge}>Won</span>}
                {stage.is_lost && <span className={s.badge}>Lost</span>}
                <span className={s.columnTotal}>{formatMoney(total, inStage[0]?.currency)}</span>
              </header>
              <div className={s.cards}>
                {inStage.map((d) => (
                  <Link
                    key={d.id}
                    to={`/crm/deals/${d.id}${book}`}
                    className={`${s.card} ${dragging === d.id ? s.cardDragging : ''}`}
                    draggable={canEdit(d)}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragging(d.id); }}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                  >
                    <span className={s.cardName}>{d.name}</span>
                    <span className={s.cardMeta}>
                      <span>{companyName(d.company_id)}</span>
                      <strong>{formatMoney(Number(d.value), d.currency)}</strong>
                    </span>
                    {d.expected_close && <span className={s.hint}>Closes {formatDate(d.expected_close)}</span>}
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
