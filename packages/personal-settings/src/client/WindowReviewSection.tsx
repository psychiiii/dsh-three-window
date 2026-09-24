/**
 * The 「窗口与评审」 settings page: a read-only view of this project's hook
 * files, and the editor for the review perspective.
 *
 * The hook block renders; it never edits. It has no input, no save button, and
 * no call that could write: the only Host calls behind it are
 * `workspaceFiles.list` and `workspaceFiles.readBytes`, and that service
 * publishes no mutation at all. Changing a hook means editing the file the
 * page names.
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { resolvePerspective } from '@psychiiii/dsh-three-window-review/prompts'
import type { ReviewKey } from './locales.ts'
import type { ReviewSettingsState } from './settings-store.ts'
import type { HooksState, ProjectOption } from './workspace-hooks-store.ts'
import {
  DSH_HOOK_EVENT_EFFECTS,
  type DshHookEvent, type DshHookEventEffects, type HookCommandView, type HookEventView,
  type HookFileStem, type HookFileView, type HookGroupView, type WindowHookView,
} from './hook-view.ts'
import css from './WindowReviewSection.module.css'

/** Registration-side face for the page. */
export interface WindowReviewInjected {
  hooks: {
    /** Global reviewer settings, shared with the review dock. */
    reviewSettings: SnapshotStore<ReviewSettingsState>
    /** The selected project's hook files. */
    windowHooks: SnapshotStore<HooksState>
  }
  /** Follow the settings mirror. */
  loadSettings: () => Promise<void>
  /** Persist the perspective against the revision the editor was filled from. */
  savePerspective: (perspective: string, expectedRevision?: number) => Promise<boolean>
  /** Read one project's hook files; omit the path to reuse the current choice. */
  loadHooks: (path?: string) => Promise<void>
  /** The text a blank perspective sends. */
  defaultPerspective: string
}

export type WindowReviewSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'personalReview'>
  & InjectFace<WindowReviewInjected>

type Translate = WindowReviewSectionProps['t']

/** Anchor the perspective block's cross-reference scrolls to. */
export const HOOK_BLOCK_ID = 'personal-window-review-hooks'

const WHEN_KEY: Record<DshHookEvent, ReviewKey> = {
  SessionStart: 'windows.hooks.when.SessionStart',
  UserPromptSubmit: 'windows.hooks.when.UserPromptSubmit',
  PreToolUse: 'windows.hooks.when.PreToolUse',
  PostToolUse: 'windows.hooks.when.PostToolUse',
  Stop: 'windows.hooks.when.Stop',
  SubagentStart: 'windows.hooks.when.SubagentStart',
  SubagentStop: 'windows.hooks.when.SubagentStop',
}

const EXIT_KEY: Record<DshHookEventEffects['blocking'], ReviewKey> = {
  'none': 'windows.hooks.exit.none',
  'reject-turn': 'windows.hooks.exit.rejectTurn',
  'deny-tool': 'windows.hooks.exit.denyTool',
  'block-result': 'windows.hooks.exit.blockResult',
  'steer-continue': 'windows.hooks.exit.steerContinue',
}

const STEM_KEY: Record<HookFileStem, ReviewKey> = {
  chat: 'windows.hooks.window.chat',
  construct: 'windows.hooks.window.construct',
  review: 'windows.hooks.window.review',
  default: 'windows.hooks.window.default',
}

const EFFECTIVE_NONE_KEY = {
  'absent': 'windows.hooks.effective.none.absent',
  'window-invalid': 'windows.hooks.effective.none.windowInvalid',
  'default-invalid': 'windows.hooks.effective.none.defaultInvalid',
} as const satisfies Record<string, ReviewKey>

const MATCHER_SUBJECT_KEY = {
  'tool-name': 'windows.hooks.matcher.tool',
  'session-source': 'windows.hooks.matcher.source',
  'subagent-type': 'windows.hooks.matcher.subagent',
  'discarded': 'windows.hooks.matcher.discarded',
} as const satisfies Record<DshHookEventEffects['matcherSubject'], ReviewKey>

function matcherLine(t: Translate, event: DshHookEvent, group: HookGroupView): string {
  const matcher = JSON.stringify(group.matcher ?? '')
  switch (group.matcherState) {
    case 'absent': return t('windows.hooks.matcher.absent')
    case 'match-all': return t('windows.hooks.matcher.all', { matcher })
    case 'discarded': return t('windows.hooks.matcher.discarded', { matcher })
    case 'honored': return t(MATCHER_SUBJECT_KEY[DSH_HOOK_EVENT_EFFECTS[event].matcherSubject], { matcher })
  }
}

/** Whether an injection verdict is one the reader has to act on. */
function injectionIsBroken(hook: HookCommandView): boolean {
  return hook.injection.kind === 'event-ignores-context'
    || hook.injection.kind === 'event-name-mismatch'
    || hook.injection.kind === 'event-name-missing'
}

function injectionLine(t: Translate, event: DshHookEvent, hook: HookCommandView): string {
  switch (hook.injection.kind) {
    case 'declared': return t('windows.hooks.inject.declared')
    case 'undetermined': return t('windows.hooks.inject.undetermined', { event })
    case 'event-ignores-context': return t('windows.hooks.inject.eventIgnores', { event })
    case 'event-has-no-context-channel': return t('windows.hooks.inject.noChannel')
    case 'event-name-missing': return t('windows.hooks.inject.nameMissing')
    case 'event-name-mismatch':
      return t('windows.hooks.inject.nameMismatch', { declared: hook.injection.declared, event })
  }
}

function HookRow({ t, event, group, hook }: {
  t: Translate
  event: DshHookEvent
  group: HookGroupView
  hook: HookCommandView
}): ReactNode {
  const broken = injectionIsBroken(hook)
  return (
    <div className={css.hook} data-hook-row="" data-hook-event={event} data-hook-broken={String(broken)}>
      <span data-hook-sentence="">{t('windows.hooks.hook.sentence', { when: t(WHEN_KEY[event]), event })}</span>
      <code className={css.command} data-hook-command="">{hook.command}</code>
      <span className={broken ? css.warn : css.note} data-hook-inject={hook.injection.kind}>
        {injectionLine(t, event, hook)}
      </span>
      <span
        className={group.matcherState === 'discarded' ? css.warn : css.note}
        data-hook-matcher={group.matcherState}
      >
        {matcherLine(t, event, group)}
      </span>
      <span className={css.note} data-hook-exit={DSH_HOOK_EVENT_EFFECTS[event].blocking}>
        {t(EXIT_KEY[DSH_HOOK_EVENT_EFFECTS[event].blocking])}
        {hook.declaresBlocking ? ` ${t('windows.hooks.exit.declared')}` : ''}
      </span>
      <span className={css.note} data-hook-timeout="">
        {hook.timeoutSec === undefined
          ? t('windows.hooks.hook.timeout.none')
          : t('windows.hooks.hook.timeout', { seconds: hook.timeoutSec })}
      </span>
    </div>
  )
}

function EventRows({ t, view }: { t: Translate; view: HookEventView }): ReactNode {
  return (
    <div data-hook-event-block={view.event}>
      {view.groups.map(group => group.hooks.map(hook => (
        <HookRow key={`${view.event}-${String(group.index)}-${String(hook.index)}`} t={t} event={view.event} group={group} hook={hook} />
      )))}
    </div>
  )
}

function FileBody({ t, file }: { t: Translate; file: HookFileView }): ReactNode {
  const [open, setOpen] = useState(false)
  if (file.status === 'missing') {
    return <p className={css.note} data-hook-file-missing="">{t('windows.hooks.file.missing')}</p>
  }
  if (file.status === 'unreadable') {
    return <p className={css.warn} data-hook-file-unreadable="">{t('windows.hooks.file.unreadable', { error: file.error })}</p>
  }
  const raw = (
    <>
      <div>
        <Button variant="outline" size="sm" data-hook-raw-toggle="" onClick={() => { setOpen(value => !value) }}>
          {open ? t('windows.hooks.file.raw.hide') : t('windows.hooks.file.raw.show')}
        </Button>
      </div>
      {open && <pre className={css.raw} data-hook-raw="">{file.raw}</pre>}
    </>
  )
  if (file.status === 'invalid') {
    return (
      <>
        <p className={css.warn} data-hook-file-invalid="">{t('windows.hooks.file.invalid')}</p>
        <p className={css.warn} data-hook-file-error="">{t('windows.hooks.file.invalid.raw', { error: file.error })}</p>
        <p className={css.warn} data-hook-file-where="">
          {file.location === undefined
            ? t('windows.hooks.file.invalid.nowhere', { path: file.path })
            : t('windows.hooks.file.invalid.where', {
              path: file.path,
              line: file.location.line,
              column: file.location.column,
            })}
        </p>
        {raw}
      </>
    )
  }
  const configured = file.events.filter(view => view.groups.some(group => group.hooks.length > 0))
  return (
    <>
      {configured.length === 0
        ? <p className={css.note} data-hook-file-empty="">{t('windows.hooks.file.empty')}</p>
        : configured.map(view => <EventRows key={view.event} t={t} view={view} />)}
      {raw}
    </>
  )
}

function WindowCard({ t, row }: { t: Translate; row: WindowHookView }): ReactNode {
  return (
    <section className={css.window} data-hook-window={row.window} data-hook-effective={row.effective}>
      <span className={css.windowTitle}>{t(STEM_KEY[row.window])}</span>
      <span className={css.note} data-hook-file-path="">{t('windows.hooks.file.path', { path: row.file.path })}</span>
      <span
        className={row.effective === 'none' ? css.warn : css.note}
        data-hook-effective-note=""
      >
        {row.effective === 'window' && t('windows.hooks.effective.window')}
        {row.effective === 'default' && t('windows.hooks.effective.default')}
        {row.effective === 'none' && row.noneReason !== undefined && t(EFFECTIVE_NONE_KEY[row.noneReason])}
      </span>
      <FileBody t={t} file={row.file} />
    </section>
  )
}

function DefaultCard({ t, file }: { t: Translate; file: HookFileView | undefined }): ReactNode {
  if (file === undefined) return null
  return (
    <section className={css.window} data-hook-window="default">
      <span className={css.windowTitle}>{t(STEM_KEY.default)}</span>
      <span className={css.note} data-hook-file-path="">{t('windows.hooks.file.path', { path: file.path })}</span>
      <span className={css.note}>{t('windows.hooks.default.note')}</span>
      <FileBody t={t} file={file} />
    </section>
  )
}

function ProjectSelector({ t, state, loadHooks }: {
  t: Translate
  state: HooksState
  loadHooks: (path?: string) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState('')
  const options: readonly ProjectOption[] = state.options
  return (
    <div className={css.selector} data-hook-selector="">
      <label>
        {t('windows.hooks.project.pick')}
        {' '}
        <select
          className={css.select}
          data-hook-project-select=""
          value={state.selected ?? ''}
          onChange={(event) => { void loadHooks(event.target.value) }}
        >
          {state.selected === null && <option value="">—</option>}
          {options.map(option => (
            <option key={option.path} value={option.path}>{option.path}</option>
          ))}
        </select>
      </label>
      <input
        className={css.text}
        data-hook-project-input=""
        placeholder={t('windows.hooks.project.manual')}
        value={draft}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <Button
        variant="outline"
        size="sm"
        data-hook-project-apply=""
        onClick={() => { if (draft.trim().length > 0) void loadHooks(draft.trim()) }}
      >
        {t('windows.hooks.project.apply')}
      </Button>
      <Button variant="outline" size="sm" data-hook-refresh="" onClick={() => { void loadHooks() }}>
        {t('windows.hooks.refresh')}
      </Button>
    </div>
  )
}

function HookBlock({ t, state, loadHooks }: {
  t: Translate
  state: HooksState
  loadHooks: (path?: string) => Promise<void>
}): ReactNode {
  const fallback = state.files.find(file => file.stem === 'default')
  return (
    <div className={css.block} id={HOOK_BLOCK_ID} data-window-review-hooks="">
      <h3 className={css.heading}>{t('windows.hooks.title')}</h3>
      <p className={css.note} data-hook-readonly="">{t('windows.hooks.readonly')}</p>
      {state.scopeProject !== null && state.scopeProject !== state.selected && (
        <p className={css.warn} role="alert" data-hook-scope-mismatch="">
          {t('windows.hooks.scope.mismatch', { project: state.scopeProject })}
        </p>
      )}
      <ProjectSelector t={t} state={state} loadHooks={loadHooks} />
      {state.badPath !== null && (
        <p className={css.warn} role="alert" data-hook-project-error="">
          {t('windows.hooks.project.relative', { path: state.badPath })}
        </p>
      )}
      <p className={css.note} data-hook-project="">
        {state.selected === null
          ? t('windows.hooks.project.none')
          : t('windows.hooks.project', { path: state.selected })}
      </p>
      {state.status === 'loading' && <p className={css.note} data-hook-loading="">{t('windows.hooks.loading')}</p>}
      {state.status === 'error' && state.error !== null && (
        <p className={css.warn} data-hook-error="">{t('windows.hooks.error', { error: state.error })}</p>
      )}
      {state.status === 'no-scope' && <p className={css.warn} data-hook-no-scope="">{t('windows.hooks.scope.none')}</p>}
      {state.scopeSessionId !== null && (
        <p className={css.note} data-hook-scope="">{t('windows.hooks.scope', { session: state.scopeSessionId })}</p>
      )}
      {state.status === 'ready' && state.directory !== null && (
        <p className={css.note} data-hook-dir="">{t('windows.hooks.dir', { path: state.directory })}</p>
      )}
      {state.status === 'ready' && !state.directoryPresent && state.directory !== null && (
        <p className={css.note} data-hook-dir-missing="">{t('windows.hooks.dir.missing', { path: state.directory })}</p>
      )}
      {state.status === 'ready' && state.directoryPresent && !state.listed && (
        <p className={css.note} data-hook-unlisted="">{t('windows.hooks.unlisted')}</p>
      )}
      {state.strayNames.length > 0 && (
        <p className={css.note} data-hook-stray="">{t('windows.hooks.stray', { names: state.strayNames.join(', ') })}</p>
      )}
      {state.status === 'ready' && state.directoryPresent && (
        <>
          {state.windows.map(row => <WindowCard key={row.window} t={t} row={row} />)}
          <DefaultCard t={t} file={fallback} />
        </>
      )}
      <div data-hook-caveats="">
        <span className={css.windowTitle}>{t('windows.hooks.caveat.title')}</span>
        <ul className={css.list}>
          <li className={css.note} data-hook-caveat="runtime">{t('windows.hooks.caveat.runtime')}</li>
          <li className={css.note} data-hook-caveat="window">{t('windows.hooks.caveat.window')}</li>
          <li className={css.note} data-hook-caveat="cwd">{t('windows.hooks.caveat.cwd')}</li>
        </ul>
      </div>
    </div>
  )
}

function PerspectiveBlock({ t, settings, savePerspective, defaultPerspective }: {
  t: Translate
  settings: ReviewSettingsState
  savePerspective: (perspective: string, expectedRevision?: number) => Promise<boolean>
  defaultPerspective: string
}): ReactNode {
  const [draft, setDraft] = useState(settings.perspective)
  const [filledFrom, setFilledFrom] = useState(settings.revision)
  const [saved, setSaved] = useState(false)
  if (settings.revision !== filledFrom) {
    setFilledFrom(settings.revision)
    setDraft(settings.perspective)
    setSaved(false)
  }
  const effective = resolvePerspective(draft)
  const isDefault = effective === defaultPerspective
  return (
    <div className={css.block} data-window-review-perspective="">
      <h3 className={css.heading}>{t('windows.perspective.title')}</h3>
      <p className={css.note} data-perspective-what="">{t('windows.perspective.what')}</p>
      <p className={css.warn} data-perspective-warn="">{t('windows.perspective.warn')}</p>
      <p className={css.note} data-perspective-protocol="">{t('windows.perspective.protocol')}</p>
      <p className={css.note} data-perspective-scope="">{t('windows.perspective.scope')}</p>
      <p className={css.note} data-perspective-per-project="">
        {t('windows.perspective.perProject')}
        {' '}
        <Button
          variant="outline"
          size="sm"
          data-perspective-per-project-jump=""
          onClick={() => {
            const block = document.getElementById(HOOK_BLOCK_ID)
            // jsdom has no layout, so the scroll is best-effort everywhere.
            block?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
          }}
        >
          {t('windows.perspective.perProject.jump')}
        </Button>
      </p>
      <p className={css.note} data-perspective-lock="">{t('windows.perspective.notLocked')}</p>
      {settings.status === 'loading' && <p className={css.note} data-perspective-loading="">{t('windows.perspective.loading')}</p>}
      {settings.status === 'unavailable' && (
        <p className={css.warn} data-perspective-unavailable="">{t('windows.perspective.unavailable')}</p>
      )}
      <label>
        {t('windows.perspective.label')}
        <textarea
          className={css.textarea}
          data-perspective-input=""
          disabled={!settings.writable}
          placeholder={t('windows.perspective.placeholder')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setSaved(false) }}
        />
      </label>
      <p className={css.note} data-perspective-current={isDefault ? 'default' : 'custom'}>
        {isDefault ? t('windows.perspective.current.default') : t('windows.perspective.current.custom')}
      </p>
      <p className={css.note} data-perspective-effective-label="">{t('windows.perspective.effective')}</p>
      <pre className={css.raw} data-perspective-effective="">{effective}</pre>
      {!settings.writable && settings.status === 'ready' && (
        <p className={css.warn} data-perspective-readonly="">{t('windows.perspective.readonly')}</p>
      )}
      {settings.error !== null && (
        <p className={css.warn} data-perspective-error="">{t('windows.perspective.error', { error: settings.error })}</p>
      )}
      {saved && settings.error === null && (
        <p className={css.note} data-perspective-saved="">{t('windows.perspective.saved')}</p>
      )}
      <div className={css.actions}>
        <Button
          variant="primary"
          size="sm"
          data-perspective-save=""
          disabled={!settings.writable || settings.status === 'saving'}
          onClick={() => {
            void savePerspective(draft, settings.revision).then((ok) => { setSaved(ok) })
          }}
        >
          {settings.status === 'saving' ? t('windows.perspective.saving') : t('windows.perspective.save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-perspective-reset=""
          disabled={!settings.writable || settings.status === 'saving'}
          onClick={() => {
            setDraft('')
            setSaved(false)
            void savePerspective('', settings.revision).then((ok) => { setSaved(ok) })
          }}
        >
          {t('windows.perspective.reset')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The settings page body: hook translation above, perspective editor below.
 * @param props - slot runtime, locale, and the page's injected face.
 */
export function WindowReviewSection({
  t, useReviewSettings, useWindowHooks, loadSettings, loadHooks, savePerspective, defaultPerspective,
}: WindowReviewSectionProps): ReactNode {
  const settings = useReviewSettings(snapshot => snapshot)
  const hooks = useWindowHooks(snapshot => snapshot)
  const [started, setStarted] = useState(false)
  if (!started) {
    setStarted(true)
    void loadSettings()
    void loadHooks()
  }
  return (
    <div className={css.root} data-personal-window-review="">
      <HookBlock t={t} state={hooks} loadHooks={loadHooks} />
      <PerspectiveBlock
        t={t}
        settings={settings}
        savePerspective={savePerspective}
        defaultPerspective={defaultPerspective}
      />
    </div>
  )
}
