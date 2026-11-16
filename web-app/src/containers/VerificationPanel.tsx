import type { UIMessage } from 'ai'
import {
  IconListCheck,
  IconLoader2,
  IconPlayerStopFilled,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useVerification } from '@/stores/verification-store'
import type { VerificationRecord } from '@/lib/verifyReply'
import {
  REJECTION_LABELS,
  SOURCE_DOUBT_LABELS,
  summarizeVerification,
} from '@/lib/verifySummary'
import { verificationsOf } from '@/lib/verifyWrite'

const VERDICTS: Record<string, string> = {
  contradicted: 'Contradicted by the source',
  unsupported: 'Not supported by the sources',
}

const asText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value)

/**
 * One piece of the verifier's output: a finding, or whatever else it wrote.
 * `of`: in the record of a series, how many runs were made.
 */
function Entry({
  entry,
  of,
}: {
  entry: VerificationRecord['entries'][number]
  of?: number
}) {
  const finding = entry.finding
  if (!finding) {
    return (
      <li className="text-muted-foreground">
        <span className="font-medium">Not a finding:</span> {entry.raw}
      </li>
    )
  }
  return (
    <li>
      <div className="font-medium">
        {VERDICTS[asText(finding.verdict)] ?? asText(finding.verdict)}
        {entry.valid ? (
          <>
            {entry.sourceDoubt && (
              <span className="font-normal text-muted-foreground">
                {' '}
                (taken as unverified: {SOURCE_DOUBT_LABELS[entry.sourceDoubt]})
              </span>
            )}
            {entry.occurrences === 0 && (
              <span className="font-normal text-muted-foreground">
                {' '}
                (not marked: the quote runs across two blocks of text)
              </span>
            )}
            {entry.runs !== undefined && (
              <span className="font-normal text-muted-foreground">
                {' '}
                · reported in {entry.runs} of {of} runs
              </span>
            )}
          </>
        ) : (
          <span className="font-normal text-destructive">
            {' '}
            (discarded:{' '}
            {entry.rejections.map((r) => REJECTION_LABELS[r]).join('; ')})
          </span>
        )}
      </div>
      <blockquote className="border-l-2 pl-2 whitespace-pre-wrap">
        {asText(finding.quote)}
      </blockquote>
      {typeof finding.source === 'string' && (
        <div className="whitespace-pre-wrap text-muted-foreground">
          <span className="font-medium">Source:</span> {finding.source}
        </div>
      )}
      {typeof finding.why === 'string' && (
        <div className="text-muted-foreground">{finding.why}</div>
      )}
    </li>
  )
}

/**
 * What there is to see of a verification that left no entries: the tools the
 * verifier called, with what it gave them, and what it wrote.
 */
function Unread({ record }: { record: VerificationRecord }) {
  return (
    <div
      data-testid="verification-unread"
      className="mt-2 space-y-2 select-text"
    >
      {record.toolCalls.map((name, i) => (
        <div key={i}>
          <span className="font-medium">Tool it called:</span> {name}
          {record.toolInputs?.[i] && (
            <pre className="whitespace-pre-wrap text-muted-foreground">
              {record.toolInputs[i]}
            </pre>
          )}
        </div>
      ))}
      <div>
        <span className="font-medium">What it wrote:</span>
        {record.output.trim() ? (
          <div className="whitespace-pre-wrap text-muted-foreground">
            {record.output}
          </div>
        ) : (
          ' nothing'
        )}
      </div>
    </div>
  )
}

/**
 * What one verification found, folded under a one-line summary. `run`: its
 * number, when it is a run of a series shown under the series.
 */
export function VerificationDetails({
  record,
  run,
}: {
  record: VerificationRecord
  run?: number
}) {
  const summary = summarizeVerification(record, { marks: run === undefined })
  // The runs that were made to the end: the ones a statement can be in.
  const made = record.runs?.filter(
    (one) => one.outcome !== 'stopped' && one.outcome !== 'error'
  ).length
  const facts = [
    // The engine's own word for the model, when it gave one: the name
    // selected in the app can be that of a model that is no longer loaded.
    record.servedModel ?? record.model?.id,
    `${Math.round(record.seconds)} s`,
    record.outputTokens !== undefined &&
      `${record.outputTokens.toLocaleString('en-US')} tokens`,
  ].filter(Boolean)
  return (
    <details
      data-testid={run === undefined ? 'verification' : 'verification-run'}
      data-outcome={record.outcome}
      className="mt-2 rounded-md border px-3 py-2 text-xs"
    >
      <summary
        className={
          summary.tone === 'problem'
            ? 'cursor-pointer text-destructive'
            : 'cursor-pointer'
        }
      >
        <span className="font-medium">
          {run === undefined ? 'Verification:' : `Run ${run}:`}
        </span>{' '}
        {summary.text}
        <span className="text-muted-foreground"> · {facts.join(' · ')}</span>
      </summary>
      {record.entries.length > 0 && (
        <ol className="mt-2 list-decimal space-y-2 pl-5 select-text">
          {record.entries.map((entry, i) => (
            <Entry key={i} entry={entry} of={made} />
          ))}
        </ol>
      )}
      {record.entries.length === 0 &&
        (record.outcome === 'tool-call' || record.outcome === 'unreadable') && (
          <Unread record={record} />
        )}
      {record.runs?.map((one, i) => (
        <VerificationDetails key={i} record={one} run={i + 1} />
      ))}
    </details>
  )
}

/**
 * Among the actions of a reply: starts its verification, or stops the one
 * that is running.
 */
export function VerifyButton({
  messageId,
  onVerify,
}: {
  messageId: string
  onVerify: (messageId: string) => void
}) {
  const verifying = useVerification((state) => messageId in state.running)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      data-testid="verify-message"
      onClick={() =>
        verifying
          ? useVerification.getState().stop(messageId)
          : onVerify(messageId)
      }
      title={
        verifying ? 'Stop the verification' : 'Verify against the tool results'
      }
    >
      {verifying ? (
        <IconPlayerStopFilled size={16} />
      ) : (
        <IconListCheck size={16} />
      )}
    </Button>
  )
}

/**
 * Under a reply: the verification in progress, or the last one that was made.
 * Nothing when the reply was never verified.
 */
export function VerificationPanel({ message }: { message: UIMessage }) {
  const running = useVerification((state) => state.running[message.id])
  const fresh = useVerification((state) => state.records[message.id])
  if (running) {
    return (
      <div
        data-testid="verification-running"
        className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
      >
        <IconLoader2 size={14} className="animate-spin" />
        Verifying
        {running.series &&
          `, run ${running.series.run} of ${running.series.of}`}
        : {running.characters.toLocaleString('en-US')} characters so far
      </div>
    )
  }
  const kept = verificationsOf(
    message.metadata as Record<string, unknown> | undefined
  )
  const record = fresh ?? kept[kept.length - 1]
  return record ? <VerificationDetails record={record} /> : null
}
