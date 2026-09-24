/**
 * New Session control: a button that starts one Session, or a three-window
 * menu when the workbench is configured.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'

/** Locale keys for the three panes, left to right. */
export const WINDOW_KEYS = ['window.chat', 'window.construct', 'window.review'] as const

/**
 * Brand row and capsule New Session control.
 * @param props.windowed - true when New Session is a window picker.
 * @param props.createWindow - bind a new Session to pane `index`.
 * @param props.startSession - official single-Session start.
 * @param props.t - sidebar locale seat.
 * @param props.children - button contents.
 * @param props.className - button class.
 * @param props.ariaLabel - accessible name.
 * @returns a button, or a menu-anchored button when windowed.
 */
export function NewSessionControl({
  windowed,
  createWindow,
  startSession,
  t,
  children,
  className,
  ariaLabel,
}: {
  windowed: boolean
  createWindow: (index: number) => void
  startSession: () => void
  t: SidebarRootComponentProps['t']
  children: ReactNode
  className: string
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  if (!windowed) {
    return (
      <button type="button" className={className} aria-label={ariaLabel} onClick={() => { startSession() }}>
        {children}
      </button>
    )
  }
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={WINDOW_KEYS.map((key, index) => ({ id: String(index), label: t(key) }))}
      onSelect={(id) => {
        setOpen(false)
        createWindow(Number(id))
      }}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          className={className}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          {children}
        </button>
      )}
    />
  )
}
