import type { ElementTable } from 'claude-code'

import type { Hunk } from '../types'
import { drawable, splitRows } from './split-rows.js'
import type { Cell, SplitDiff, SplitRow } from './split-rows.js'

export type Kit = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Code'>

/**
 * Where a split diff sits. The rows are the same everywhere; only what
 * surrounds them differs.
 */
const LAYOUTS = {
  /** Under a tool call in the transcript: the summary line with the built-in's response marker; the rows sit under it, indented. */
  'tool-result': { lead: '  ⎿  ', indent: 5 },
  /** In the pane: no summary (the file's row has the counts), the rule between the columns alone. */
  pane: { lead: null, indent: 0 },
} as const

export type DiffLayout = keyof typeof LAYOUTS

/**
 * Characters of diff text drawn in one tree. The engine draws only the first
 * 100000 and cuts the rest, the "… more rows" with it; the margin is for the
 * text around the diff.
 */
export const TEXT_BUDGET = 80_000

/** Lines of the rule between the columns; a row that wraps past it shows a gap in the rule. */
const RULE_LENGTH = 16

/** Columns the separator between the two columns takes. */
const SEPARATOR_WIDTH = 1

/**
 * Characters of text that count as fitting a column when the width is not
 * known: none. The tinted pair is clipped to one row and cuts what does not
 * fit with an ellipsis, so without a width every changed pair wraps.
 */
const UNKNOWN_ROOM = 0

/**
 * Columns the engine's diff spends before a line's text: the line number,
 * padded to the widest number of the diff, a space and the marker (`12 -text`,
 * as the built-in's own rows show), plus one column as a margin. The margin
 * makes this over-count by one, which only sends a line to the wrapping
 * drawing a column early.
 */
const gutterWidth = (numberWidth: number) => numberWidth + 3

/**
 * Characters of text that fit one row of a column, or a lower bound of it.
 *
 * `width` is the columns the rows have, the layout's indent already taken off.
 * The two columns are 50% each of the row next to a one-column separator, so
 * the room of each is half of what the separator leaves, rounded down; the
 * engine's own rounding of the shrink can differ by a column, which the
 * gutter's margin covers. Without a width no line is trusted to fit.
 */
export function textRoom(width: number | undefined, numberWidth: number): number {
  if (width === undefined) return UNKNOWN_ROOM
  const column = Math.floor((width - SEPARATOR_WIDTH) / 2)
  return Math.max(0, column - gutterWidth(numberWidth))
}

/**
 * Columns a line takes on the screen. East Asian wide characters and emoji
 * take two; anything else counts one, which is right for the text a diff
 * holds. Combining marks count one too, a harmless over-count. Tabs were laid
 * out as spaces before the line got here.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      // Enclosed ideographs (1F200) and everything above: emoji, symbols, the CJK planes.
      code >= 0x1f200
    width += isWide ? 2 : 1
  }
  return width
}

/** Characters of a one-line hunk header (`@@ -12,1 +12,1 @@` and the mark). */
const HEADER_LENGTH = 22

/**
 * The characters of text a row puts in the tree. The engine draws only the
 * first 100000 of a tree, so a long diff has to be counted before it is drawn.
 */
function rowChars(row: SplitRow) {
  if (row.kind === 'gap') return 60
  const text = (cell: Cell | null) => (cell === null ? 1 : HEADER_LENGTH + cell.text.length)
  // A changed pair is drawn as one hunk in each column.
  if (row.changed && row.left !== null && row.right !== null) {
    return 2 * (HEADER_LENGTH + row.left.text.length + row.right.text.length) + RULE_LENGTH
  }
  return text(row.left) + text(row.right) + RULE_LENGTH
}

/**
 * How many of the first rows of a diff fit in `maxRows` rows and `maxChars`
 * characters of text, and the characters those rows take.
 */
export function rowsWithin(diff: SplitDiff, maxRows: number, maxChars: number) {
  let count = 0
  let chars = 0
  for (const row of diff.rows.slice(0, maxRows)) {
    const next = chars + rowChars(row)
    if (next > maxChars) break
    chars = next
    count++
  }
  return { count, chars }
}

export type DiffOptions = {
  /** The file's path, for the language of the highlighting. */
  path: string | undefined
  /** Rows drawn before "… N more rows". */
  maxRows: number
  layout: DiffLayout
  /**
   * Columns across the surface the diff is drawn into, the layout's indent
   * included; it tells which changed lines fit one row of a column. Absent,
   * every changed pair wraps.
   */
  columns?: number
}

/**
 * A split diff: the removed lines in the left column and the added ones in the
 * right, with line numbers, under a "Added 3 lines, removed 1 line" summary
 * where the layout has one. Every place that draws a diff goes through here.
 */
export function drawDiff(kit: Kit, diff: SplitDiff, { path, maxRows, layout, columns }: DiffOptions) {
  const { Box, Text } = kit
  const { lead, indent } = LAYOUTS[layout]
  // The rows start after the indent, and there is no frame to take columns of its own.
  const width = columns === undefined ? undefined : columns - indent

  return Box({
    flexDirection: 'column',
    children: [
      lead === null
        ? null
        : Box({
            flexDirection: 'row',
            children: [Text({ dimColor: true, children: [lead] }), ...summary(Text, diff.added, diff.removed)],
          }),
      Box({
        flexDirection: 'column',
        marginLeft: indent,
        children: drawRows(kit, diff, path, maxRows, width),
      }),
    ],
  })
}

/**
 * What fits of a file's hunks in the rows and characters left: the split rows,
 * or, for what has no split form (a final newline on one side only), the lines
 * of git's own diff. Either way `count` rows and `chars` characters are spent.
 */
export type Fit =
  | { kind: 'split'; diff: SplitDiff; count: number; chars: number }
  | { kind: 'unified'; lines: string[]; total: number; count: number; chars: number }

/**
 * The one place that shares the row and character budgets out, for the split
 * rows and the unified lines alike. Lines are made drawable as the split rows
 * are: tabs laid out, control characters dropped, cut at the engine's limit.
 */
export function fitHunks(hunks: readonly Hunk[], maxRows: number, maxChars: number): Fit {
  const diff = splitRows(hunks)
  if (diff !== null) return { kind: 'split', diff, ...rowsWithin(diff, maxRows, maxChars) }

  const all = hunks.flatMap(hunk => [`@@ -${hunk.oldStart} +${hunk.newStart} @@`, ...hunk.lines].map(drawable))
  const lines: string[] = []
  let chars = 0
  for (const line of all.slice(0, maxRows)) {
    // The line break is a character of the source too.
    if (chars + line.length + 1 > maxChars) break
    chars += line.length + 1
    lines.push(line)
  }
  return { kind: 'unified', lines, total: all.length, count: lines.length, chars }
}

/**
 * Draws a fit: the split diff in the pane's layout, or git's own diff, in the
 * engine's drawing, with "… N more rows" after what was cut. `columns` is the
 * width the fit has, when the caller knows it (see `DiffOptions`).
 */
export function drawFit(kit: Kit, fit: Fit, path: string | undefined, columns?: number) {
  if (fit.kind === 'split') {
    return drawDiff(kit, fit.diff, { path, maxRows: fit.count, layout: 'pane', ...(columns === undefined ? {} : { columns }) })
  }

  const { Box, Text, Code } = kit
  const hidden = fit.total - fit.count
  return Box({
    flexDirection: 'column',
    children: [
      fit.count === 0
        ? null
        : Code({ source: fit.lines.join('\n'), format: 'diff', wrap: 'wrap', ...(path === undefined ? {} : { path }) }),
      hidden > 0 ? Text({ dimColor: true, children: ['… ' + hidden + ' more rows'] }) : null,
    ],
  })
}

/**
 * The rows of a split diff, ready to sit in a column, with "… N more rows"
 * after the first `maxRows`. `width` is the columns the rows have, if known.
 */
function drawRows(kit: Kit, diff: SplitDiff, path: string | undefined, maxRows: number, width: number | undefined) {
  const shown = diff.rows.slice(0, maxRows)
  const hidden = diff.rows.length - shown.length
  const room = textRoom(width, diff.numberWidth)
  return [
    ...shown.map(row => drawRow(kit, row, path, room)),
    hidden > 0 ? kit.Text({ dimColor: true, children: ['… ' + hidden + ' more rows'] }) : null,
  ]
}

/** `room` is the characters of text that fit one row of a column (see `textRoom`). */
function drawRow(kit: Kit, row: SplitRow, path: string | undefined, room: number) {
  const { Box, Text } = kit
  if (row.kind === 'gap') {
    // The label sits in both columns, so a wide screen doesn't leave the right one blank.
    const label = () => Text({ dimColor: true, children: ['⋯ ' + row.hidden + ' unchanged lines'] })
    // A blank line above and below sets the label apart; an empty 1-wide Box takes the separator's place so the columns line up.
    const column = { width: '50%', flexShrink: 1, paddingY: 1 } as const
    return Box({
      flexDirection: 'row',
      children: [Box({ ...column, children: [label()] }), Box({ width: 1, flexShrink: 0 }), Box({ ...column, children: [label()] })],
    })
  }
  // The tinted pair is clipped to one row, so only a pair that fits it, and whose numbers have as many digits, can use it; any other wraps in cells.
  // The pair is one hunk, whose gutter is as wide as its largest number: when the two numbers differ in digits
  // (9 and 10), the text of the left column would sit a column to the right of the other rows.
  if (
    row.changed &&
    row.left !== null &&
    row.right !== null &&
    String(row.left.no).length === String(row.right.no).length &&
    fits(row.left, room) &&
    fits(row.right, room)
  ) {
    return drawPair(kit, row.left, row.right, path)
  }
  return Box({
    flexDirection: 'row',
    alignItems: 'stretch',
    children: [
      drawCell(kit, row.left, row.changed ? 'removed' : 'same', path),
      separator(kit),
      drawCell(kit, row.right, row.changed ? 'added' : 'same', path),
    ],
  })
}

function drawCell(
  { Box, Text, Code }: Kit,
  cell: Cell | null,
  kind: 'removed' | 'added' | 'same',
  path: string | undefined,
) {
  const column = { width: '50%', flexShrink: 1, flexDirection: 'row' } as const

  // Nothing on this side of the row: keep the column, draw nothing in it.
  if (cell === null) return Box({ ...column, children: [Text({ children: [' '] })] })

  // One-line hunk through the engine's diff renderer, so gutter, marker and
  // add/remove colors are exactly the built-in diff's.
  const n = cell.no
  const header =
    kind === 'removed' ? `@@ -${n},1 +${n},0 @@` : kind === 'added' ? `@@ -${n},0 +${n},1 @@` : `@@ -${n},1 +${n},1 @@`
  const sign = kind === 'removed' ? '-' : kind === 'added' ? '+' : ' '

  return Box({
    ...column,
    children: [
      Code({
        source: header + '\n' + sign + cell.text,
        format: 'diff',
        wrap: 'wrap',
        ...(path === undefined ? {} : { path }),
      }),
    ],
  })
}

/** True when the line fits one row of a column, with `room` characters for its text. */
const fits = (cell: Cell, room: number) => displayWidth(cell.text) <= room

/**
 * A removed line next to the line that replaced it. The engine draws the two as
 * one hunk, which is what makes it tint the words that changed; each column
 * then shows its own line of that hunk. A column clipped to one row cannot wrap
 * and would cut a long line with an ellipsis, so `drawRow` calls this only for
 * a pair that fits one row; a longer pair is drawn in wrapping cells, without
 * the word tint.
 */
function drawPair(kit: Kit, left: Cell, right: Cell, path: string | undefined) {
  const { Box, Code } = kit
  const hunk = () =>
    Code({
      source: `@@ -${left.no},1 +${right.no},1 @@\n-${left.text}\n+${right.text}`,
      format: 'diff',
      wrap: 'truncate-end',
      ...(path === undefined ? {} : { path }),
    })
  const column = { width: '50%', flexShrink: 1, height: 1, overflow: 'hidden' } as const
  return Box({
    flexDirection: 'row',
    children: [
      Box({ ...column, children: [hunk()] }),
      separator(kit),
      Box({
        ...column,
        children: [Box({ position: 'absolute', top: -1, left: 0, right: 0, children: [hunk()] })],
      }),
    ],
  })
}

/**
 * A dim vertical rule between the columns. It stretches to the row's height
 * (wrapped lines make rows taller), so it draws a tall line out of flow and
 * lets the clipped box cut it to the row.
 */
function separator({ Box, Text }: Kit) {
  return Box({
    width: 1,
    flexShrink: 0,
    overflow: 'hidden',
    children: [
      Box({
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 1,
        // One node: the glyphs wrap at the box's one column, a line each.
        children: [Text({ dimColor: true, children: ['│'.repeat(RULE_LENGTH)] })],
      }),
    ],
  })
}

/** "Added 3 lines, removed 1 line", the counts bold, as the built-in diff words it. */
function summary(Text: Kit['Text'], added: number, removed: number) {
  const noun = (n: number) => (n > 1 ? ' lines' : ' line')
  const parts: ReturnType<Kit['Text']>[] = []
  if (added > 0) {
    parts.push(Text({ children: ['Added '] }), Text({ bold: true, children: [String(added)] }))
    parts.push(Text({ children: [noun(added) + (removed > 0 ? ', ' : '')] }))
  }
  if (removed > 0) {
    parts.push(Text({ children: [added === 0 ? 'Removed ' : 'removed '] }))
    parts.push(Text({ bold: true, children: [String(removed)] }), Text({ children: [noun(removed)] }))
  }
  return parts
}
