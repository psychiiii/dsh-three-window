/**
 * The latest review run in the review dock: its progress while it runs, how
 * it ended, how much of the report the coordinator's summary cites, and the
 * original report in a wide dialog. The conclusion itself is only in the
 * conversation (Owner decision): this panel says how the run went, not what
 * it found.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconDeliverDocRegular, Input, MarkdownText, Modal, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  dropoutCause, findingIds, renderReportMarkdown,
} from '@psychiiii/dsh-three-window-review/report-markdown'
import type { ReviewPanelState, SeatDropout } from '@psychiiii/dsh-three-window-review/types'
import css from './ReviewDock.module.css'

type T = PropsLocale<'personalReview'>['t']

/** Uncited ids listed by name before the rest are counted. */
const UNCITED_SHOWN = 30

/** How long a jumped-to finding stays highlighted. */
const JUMP_HIGHLIGHT_MS = 2400

function statusText(panel: ReviewPanelState, t: T): string | undefined {
  const run = panel.run
  if (run === null) return undefined
  const dropped = (rows: readonly SeatDropout[]): string => rows
    .map(row => t('run.dropped.item', { seat: row.seatId, cause: t(`cause.${dropoutCause(row)}`) }))
    .join(t('run.dropped.sep'))
  switch (run.status) {
    case 'running': {
      const line = run.roundDone === undefined
        ? t('run.first', { round: String(run.round), max: String(run.maxRounds) })
        : run.continuing
          ? t('run.next', { done: String(run.roundDone), round: String(run.round) })
          : t('run.wrap', { done: String(run.roundDone) })
      return run.dropped.length === 0 ? line : `${line} ${t('run.dropped', { list: dropped(run.dropped), n: String(run.remaining) })}`
    }
    case 'complete':
      return t('run.complete')
    case 'partial': {
      const rows = panel.report?.dropouts ?? run.dropped
      return t('run.partial', {
        n: String(rows.length),
        list: rows.map(row => t('run.partial.item', {
          seat: row.seatId, round: String(row.round), cause: t(`cause.${dropoutCause(row)}`),
        })).join(t('run.dropped.sep')),
      })
    }
    case 'failed':
      return t('run.failed')
    case 'cancelled':
      return t('run.cancelled')
  }
}

/** The list item of finding `id` in the rendered report, if any. */
function findingItem(root: HTMLElement, id: string): HTMLElement | undefined {
  for (const strong of Array.from(root.querySelectorAll('li strong'))) {
    if (strong.textContent === id) return strong.closest('li') ?? undefined
  }
  return undefined
}

/**
 * The latest run's line in the review dock, and its original-report dialog.
 * @param props.panel - the `personalReview` projection.
 * @param props.t - locale.
 */
export function ReviewRunPanel({ panel, t }: { panel: ReviewPanelState; t: T }): ReactNode {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<{ id: string; seq: number } | undefined>(undefined)
  const [jump, setJump] = useState('')
  const [missing, setMissing] = useState<string | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const report = panel.report
  const ids = useMemo(() => (report === null ? [] : findingIds(report)), [report])
  const uiLanguage = t('report.language')
  const markdown = useMemo(
    () => (report === null ? '' : renderReportMarkdown(report, { audience: 'dialog', language: report.language ?? uiLanguage })),
    [report, uiLanguage],
  )
  const labels = useMemo(() => ({
    code: { copyLabel: t('md.copy'), copiedLabel: t('md.copied'), toolbarLabels: { codeLabel: t('md.code'), wrapLabel: t('md.wrap'), unwrapLabel: t('md.unwrap') } },
    footnotes: t('md.footnotes'),
  }), [t])

  useEffect(() => {
    if (!open || target === undefined) return undefined
    // The dialog body is portaled in the same commit; look it up once it is attached.
    let item: HTMLElement | undefined
    let clear: ReturnType<typeof setTimeout> | undefined
    const find = setTimeout(() => {
      const root = bodyRef.current
      item = root === null ? undefined : findingItem(root, target.id)
      if (item === undefined) {
        setMissing(target.id)
        return
      }
      setMissing(undefined)
      if (typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'center' })
      item.setAttribute('data-review-jumped', '')
      clear = setTimeout(() => { item?.removeAttribute('data-review-jumped') }, JUMP_HIGHLIGHT_MS)
    })
    return () => {
      clearTimeout(find)
      if (clear !== undefined) clearTimeout(clear)
      item?.removeAttribute('data-review-jumped')
    }
  }, [open, target])

  const status = statusText(panel, t)
  if (status === undefined && report === null) return null
  const openAt = (id: string | undefined): void => {
    setMissing(undefined)
    setTarget(id === undefined ? undefined : { id, seq: (target?.seq ?? 0) + 1 })
    setOpen(true)
  }
  const cited = new Set(panel.cited)
  const uncited = ids.filter(id => !cited.has(id))
  const goTo = (): void => {
    // An issue number (F3) or one of its wordings (F3.1).
    const match = /^\s*[Ff]?(\d+)(?:\.(\d+))?\s*$/u.exec(jump)
    if (match === null) return
    openAt(`F${String(Number(match[1]))}${match[2] === undefined ? '' : `.${String(Number(match[2]))}`}`)
  }

  return (
    <div data-review-run={panel.run?.status ?? 'none'}>
      {status !== undefined && (
        // Set apart and in the run's colour, with dsh's moving highlight while it
        // matters (Owner: the status must stand out); a cancelled run stays plain.
        <div className={css.status} data-review-status={panel.run?.status}>
          <TextShimmer active={panel.run?.status !== 'cancelled'}>{status}</TextShimmer>
        </div>
      )}
      {report !== null && ids.length > 0 && (
        <div className={css.meta} data-review-coverage={`${String(panel.cited.length)}/${String(ids.length)}`}>
          {t('coverage', { cited: String(panel.cited.length), total: String(ids.length) })}
          {' '}
          {uncited.length === 0
            ? t('coverage.all')
            : (
              <>
                {t('coverage.missing')}
                {uncited.slice(0, UNCITED_SHOWN).map(id => (
                  <button key={id} type="button" className={css.idChip} data-review-uncited={id} onClick={() => { openAt(id) }}>
                    {id}
                  </button>
                ))}
                {uncited.length > UNCITED_SHOWN && ` ${t('coverage.more', { n: String(uncited.length) })}`}
              </>
            )}
        </div>
      )}
      {report !== null && (
        <>
          <Button
            variant="outline"
            size="sm"
            icon={<IconDeliverDocRegular size={14} />}
            className={css.rawButton}
            data-review-raw-open=""
            onClick={() => { openAt(undefined) }}
          >
            {t('raw.summary')}
          </Button>
          <Modal
            open={open}
            onClose={() => { setOpen(false) }}
            title={t('raw.title')}
            closeLabel={t('modal.close')}
            className={css.rawDialog ?? ''}
          >
            <form
              className={css.jump}
              data-review-jump=""
              onSubmit={(event) => { event.preventDefault(); goTo() }}
            >
              <label className={css.jumpLabel}>
                {t('raw.jump.label')}
                <Input
                  value={jump}
                  placeholder={t('raw.jump.placeholder')}
                  onChange={(event) => { setJump(event.target.value) }}
                  data-review-jump-input=""
                />
              </label>
              <Button type="submit" variant="outline" size="sm">{t('raw.jump.go')}</Button>
              {missing !== undefined && <span className={css.meta} data-review-jump-missing="">{t('raw.jump.none', { id: missing })}</span>}
            </form>
            <div className={css.rawBody} data-review-raw="" ref={bodyRef}>
              <MarkdownText text={markdown} labels={labels} />
            </div>
          </Modal>
        </>
      )}
    </div>
  )
}
