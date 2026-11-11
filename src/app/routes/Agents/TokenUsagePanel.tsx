import s from '@/features/platform/Platform.module.css';
import a from './Agents.module.css';
import { tokenUsagePresentation } from './tokenUsage';

const tokenFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

interface UsageMeterProps {
  label: string;
  detail: string;
  used: number;
  limit: number | null;
}

function UsageMeter({ label, detail, used, limit }: UsageMeterProps) {
  const usage = tokenUsagePresentation(used, limit);
  const limitText = usage.limit === null
    ? 'No limit set'
    : `${tokenFormatter.format(usage.used)} of ${tokenFormatter.format(usage.limit)} tokens`;
  const percentText = usage.percentage === null ? null : `${Math.round(usage.percentage)}%`;

  return (
    <div className={a.usageMetric}>
      <div className={a.usageMetricHeader}>
        <div>
          <strong>{label}</strong>
          <span>{detail}</span>
        </div>
        <div className={a.usageValue}>
          <strong>{tokenFormatter.format(usage.used)}</strong>
          <span>tokens</span>
        </div>
      </div>
      {usage.limit === null ? (
        <div className={`${a.usageTrack} ${a.usageTrackNeutral}`} aria-hidden="true" />
      ) : (
        <div
          className={a.usageTrack}
          role="progressbar"
          aria-label={`${label}: ${limitText}`}
          aria-valuemin={0}
          aria-valuemax={usage.limit}
          aria-valuenow={Math.min(usage.used, usage.limit)}
          aria-valuetext={`${limitText}, ${percentText}`}
        >
          <span
            className={`${a.usageFill} ${usage.tone === 'warning' ? a.usageWarning : usage.tone === 'exceeded' ? a.usageExceeded : ''}`}
            style={{ width: `${usage.visualPercentage}%` }}
          />
        </div>
      )}
      <div className={a.usageCaption}>
        <span>{usage.limit === null ? 'No limit set' : limitText}</span>
        {percentText ? <span>{percentText}</span> : null}
      </div>
    </div>
  );
}

export function TokenUsagePanel({
  userDayTokens,
  userDayLimit,
  workspaceMonthTokens,
  workspaceMonthLimit,
  onConfigure,
}: {
  userDayTokens: number;
  userDayLimit: number | null;
  workspaceMonthTokens: number;
  workspaceMonthLimit: number | null;
  onConfigure?: () => void;
}) {
  return (
    <section className={a.usagePanel} aria-labelledby="agent-token-usage-title">
      <header className={a.usageHeader}>
        <div>
          <div className={s.eyebrow}>Token usage</div>
          <h2 id="agent-token-usage-title">AI usage</h2>
        </div>
        {onConfigure ? (
          <button type="button" className={s.button} onClick={onConfigure}>Set limits</button>
        ) : null}
      </header>
      <div className={a.usageGrid}>
        <UsageMeter label="Your usage today" detail="Resets daily" used={userDayTokens} limit={userDayLimit} />
        <UsageMeter
          label="Workspace this month"
          detail="Shared by all members"
          used={workspaceMonthTokens}
          limit={workspaceMonthLimit}
        />
      </div>
      <p className={a.usageFootnote}>
        A running agent can temporarily reserve tokens. The total is reconciled to provider-reported usage when the run finishes.
      </p>
    </section>
  );
}
