/**
 * A reply verified more than once in a row, and what the runs found put
 * together.
 *
 * Two verifications of the same reply by the same model seldom report the
 * same statements: several runs collect more of them, the mistaken ones
 * included. So nothing is filtered: every statement reported in any run is
 * marked, and the record says in how many runs each was reported. How often a
 * statement comes back is a hint to what to check first, not a proof: a
 * verifier can repeat the same mistake in every run.
 */
import type { ThreadContent, ThreadMessage } from '@janhq/core'
import { validFindings, type ValidFinding } from '@/lib/verifyFindings'
import { markFindings, withoutMarks } from '@/lib/verifyMarks'
import {
  verifyReply,
  type AskVerifier,
  type Verification,
  type VerificationOutcome,
  type VerificationRecord,
} from '@/lib/verifyReply'

/** The most runs a series can be asked for. */
export const VERIFY_REPETITIONS_MAX = 5

/** After a run that ends like this no other is made. */
const ENDS_A_SERIES: VerificationOutcome[] = ['stopped', 'error', 'no-sources']

type Entry = VerificationRecord['entries'][number]

/** A statement reported in one run or more. */
type Point = {
  /** The entry that stands for it, and the finding as it is used. */
  entry: Entry
  finding: ValidFinding
  /** In how many runs it was reported. */
  runs: number
}

/**
 * The statements the runs reported, each once, in the order they first came.
 * Two findings are about the same statement when their quotes are the same
 * text or share some of the answer: the same sentence is often quoted with a
 * few words more or less. A statement stands as contradicted when a run
 * found it so with a passage of the sources, otherwise as its first finding.
 */
function pointsOf(content: ThreadContent[], records: VerificationRecord[]) {
  const texts = withoutMarks(content).map((part) =>
    part.type === 'text' && part.text ? part.text.value : ''
  )
  const found: Array<{
    run: number
    entry: Entry
    finding: ValidFinding
    spans: Array<[part: number, start: number, end: number]>
    group: number
  }> = []
  records.forEach((record, run) => {
    for (const entry of record.entries) {
      if (!entry.valid) continue
      const [finding] = validFindings({ noFindings: false, entries: [entry] })
      const spans: Array<[number, number, number]> = []
      texts.forEach((text, part) => {
        for (
          let start = text.indexOf(finding.quote);
          start !== -1;
          start = text.indexOf(finding.quote, start + finding.quote.length)
        ) {
          spans.push([part, start, start + finding.quote.length])
        }
      })
      found.push({ run, entry, finding, spans, group: found.length })
    }
  })

  const same = (a: (typeof found)[number], b: (typeof found)[number]) =>
    a.finding.quote === b.finding.quote ||
    a.spans.some(([part, start, end]) =>
      b.spans.some(
        ([otherPart, otherStart, otherEnd]) =>
          part === otherPart && start < otherEnd && otherStart < end
      )
    )
  // Each finding joins the group of every earlier one it is the same as.
  found.forEach((item, index) => {
    for (const earlier of found.slice(0, index)) {
      if (earlier.group === item.group || !same(earlier, item)) continue
      const [kept, gone] =
        earlier.group < item.group
          ? [earlier.group, item.group]
          : [item.group, earlier.group]
      for (const other of found) if (other.group === gone) other.group = kept
    }
  })

  const points: Point[] = []
  for (const group of [...new Set(found.map((item) => item.group))]) {
    const members = found.filter((item) => item.group === group)
    const chosen =
      members.find((item) => item.finding.verdict === 'contradicted') ??
      members[0]
    points.push({
      entry: chosen.entry,
      finding: chosen.finding,
      runs: new Set(members.map((item) => item.run)).size,
    })
  }
  return points
}

/**
 * Verifies the reply that ends `path` `repetitions` times, one run after the
 * other (see `verifyReply`, which makes each). A run that is stopped or fails
 * ends the series. With one run made, the result is that run's: nothing
 * changes for a reply verified once. With more, the record is of the series:
 * its entries are the statements reported, the marks are written once for all
 * of them, and `runs` keeps the record of every run.
 */
export async function verifySeries(
  path: ThreadMessage[],
  ask: AskVerifier,
  options: NonNullable<Parameters<typeof verifyReply>[2]> & {
    repetitions: number
    /** Called as each run starts, with its number, from 1, and how many. */
    onRun?: (run: number, of: number) => void
  }
): Promise<Verification> {
  const { repetitions, onRun, ...forEachRun } = options
  const now = options.now ?? Date.now
  const made: Verification[] = []
  for (let run = 1; run <= repetitions; run++) {
    onRun?.(run, repetitions)
    const one = await verifyReply(path, ask, forEachRun)
    made.push(one)
    if (ENDS_A_SERIES.includes(one.record.outcome)) break
  }
  if (made.length === 1) return made[0]

  const runs = made.map((one) => one.record)
  const last = runs[runs.length - 1]
  const done = runs.filter((run) => !ENDS_A_SERIES.includes(run.outcome))
  const reply = path[path.length - 1]
  const points = pointsOf(reply.content, done)
  const marked = markFindings(
    reply.content,
    points.map((point) => point.finding)
  )
  const outcome: VerificationOutcome =
    points.length > 0
      ? 'findings'
      : done.every((run) => run.outcome === 'no-findings')
        ? 'no-findings'
        : 'nothing-valid'
  const sum = (values: Array<number | undefined>) =>
    values.reduce<number>((total, value) => total + (value ?? 0), 0)
  const at = runs[0].at
  return {
    record: {
      at,
      outcome,
      seconds: (now() - at) / 1000,
      maxOutputTokens: runs[0].maxOutputTokens,
      truncated: done.some((run) => run.truncated),
      model: done[done.length - 1].model,
      servedModel: done[done.length - 1].servedModel,
      inputTokens: sum(done.map((run) => run.inputTokens)),
      outputTokens: sum(done.map((run) => run.outputTokens)),
      toolCalls: [],
      output: '',
      reasoning: '',
      entries: points.map((point) => ({
        ...point.entry,
        runs: point.runs,
      })),
      marks: marked.inserted,
      ...(last.error ? { error: last.error } : {}),
      repetitions,
      runs,
    },
    ...(marked.inserted > 0 ? { markedContent: marked.content } : {}),
  }
}
