/** One side of a split row: the line's number in its file and its text. */
export type Cell = { no: number; text: string }

export type SplitRow =
  | {
      kind: 'row'
      /** The removed (or unchanged) line; null when this row only adds. */
      left: Cell | null
      /** The added (or unchanged) line; null when this row only removes. */
      right: Cell | null
      changed: boolean
    }
  | { kind: 'gap'; hidden: number }

export type SplitDiff = {
  rows: SplitRow[]
  added: number
  removed: number
  /** Digits of the largest line number, for the number gutters. */
  numberWidth: number
}

type Hunk = { oldStart: number; newStart: number; lines: string[] }

const TAB = '    '

/** The most characters the engine takes in one drawn leaf. */
const MAX_TEXT = 10_000

/**
 * A line made safe to draw: tabs laid out as spaces, every control, format and
 * invisible character dropped (a stray '\r' from a CRLF file would otherwise
 * get the whole tree refused), and cut to the engine's cap.
 */
const drawable = (text: string) =>
  text
    .replace(/\t/g, TAB)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .slice(0, MAX_TEXT)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** A tool result's `structuredPatch`, keeping only entries shaped like a hunk. */
const hunksOf = (patch: unknown): Hunk[] =>
  (Array.isArray(patch) ? patch : []).flatMap((hunk: unknown): Hunk[] => {
    if (!isRecord(hunk)) return []
    const { oldStart, newStart, lines } = hunk
    if (typeof oldStart !== 'number' || typeof newStart !== 'number') return []
    if (!Array.isArray(lines)) return []
    return [
      {
        oldStart,
        newStart,
        lines: lines.filter((line): line is string => typeof line === 'string'),
      },
    ]
  })

/**
 * Turns a tool result's `structuredPatch` (unified hunks whose lines start with
 * ' ', '-' or '+') into side-by-side rows. Each run of removed lines is paired
 * with the added lines that follow it. A side that is null has no line in that
 * row; a cell with empty text is a real blank line.
 *
 * @returns null when the patch holds no hunks, or when one side lacks a
 * trailing newline the other has (the default renderer shows that marker)
 */
export function splitRows(patch: unknown): SplitDiff | null {
  const hunks = hunksOf(patch)
  if (hunks.length === 0) return null

  const rows: SplitRow[] = []
  let added = 0
  let removed = 0
  let largest = 0
  let previousOldEnd: number | null = null

  for (const hunk of hunks) {
    if (previousOldEnd !== null) {
      const hidden = hunk.oldStart - previousOldEnd
      if (hidden > 0) rows.push({ kind: 'gap', hidden })
    }

    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    let dels: Cell[] = []
    let adds: Cell[] = []
    let previous = ''
    let oldLacksNewline = false
    let newLacksNewline = false
    const flush = () => {
      const count = Math.max(dels.length, adds.length)
      for (let i = 0; i < count; i++) {
        rows.push({
          kind: 'row',
          left: dels[i] ?? null,
          right: adds[i] ?? null,
          changed: true,
        })
      }
      dels = []
      adds = []
    }

    for (const line of hunk.lines) {
      const mark = line.charAt(0)
      const text = drawable(line.slice(1))
      if (mark === '\\') {
        // "\ No newline at end of file" refers to the line before it
        if (previous !== '+') oldLacksNewline = true
        if (previous !== '-') newLacksNewline = true
        continue
      }
      previous = mark
      if (mark === '-') {
        dels.push({ no: oldNo++, text })
        removed++
      } else if (mark === '+') {
        adds.push({ no: newNo++, text })
        added++
      } else {
        flush()
        rows.push({
          kind: 'row',
          left: { no: oldNo++, text },
          right: { no: newNo++, text },
          changed: false,
        })
      }
    }
    flush()
    if (oldLacksNewline !== newLacksNewline) return null

    previousOldEnd = oldNo
    largest = Math.max(largest, oldNo, newNo)
  }

  return { rows, added, removed, numberWidth: String(largest).length }
}
