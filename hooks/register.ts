import type { ElementTable, On } from 'claude-code'

import { splitRows } from './split-rows.js'
import type { Cell, SplitRow } from './split-rows.js'

/** Tools whose result is a diff this mod redraws. */
const TOOLS = ['Edit', 'Write']

/** Rows drawn before "… N more rows". */
const MAX_ROWS = 200

type Kit = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Code'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Draws the result block of an Edit or Write call as a split diff: removed
 * lines in the left column and added lines in the right, with line numbers.
 *
 * @param on the engine's registrar
 */
export function register(on: On) {
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, output, isErrored } = e.props
    if (!TOOLS.includes(tool) || isErrored || !isRecord(output)) return next(e)
    // An edit held for review wrote nothing, so there is no diff to show.
    if (output.staged === true) return next(e)

    const diff = splitRows(output.structuredPatch)
    // No hunks (a new file, an identical write): leave Claude Code's drawing alone.
    if (diff === null) return next(e)

    const kit: Kit = $.ui.resolve(e)
    const { Box, Text } = kit
    const path = typeof output.filePath === 'string' ? output.filePath : undefined

    const shown = diff.rows.slice(0, MAX_ROWS)
    const hidden = diff.rows.length - shown.length

    return Box({
      flexDirection: 'column',
      children: [
        // The built-in summary line, with its response marker.
        Box({
          flexDirection: 'row',
          children: [
            Text({ dimColor: true, children: ['  ⎿  '] }),
            ...summary(Text, diff.added, diff.removed),
          ],
        }),
        // The rows sit in a frame under the summary text, as the built-in diff does.
        Box({
          flexDirection: 'column',
          marginLeft: 5,
          borderStyle: 'round',
          borderDimColor: true,
          children: [
            ...shown.map(row => drawRow(kit, row, path)),
            hidden > 0 ? Text({ dimColor: true, children: ['… ' + hidden + ' more rows'] }) : null,
          ],
        }),
      ],
    })
  })
}

function drawRow(kit: Kit, row: SplitRow, path: string | undefined) {
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
  if (row.changed && row.left !== null && row.right !== null) {
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

/**
 * A removed line next to the line that replaced it. The engine draws the two as
 * one hunk, which is what makes it tint the words that changed; each column
 * then shows its own line of that hunk. Long lines are cut with an ellipsis, as
 * a column clipped to one row cannot wrap.
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
        flexDirection: 'column',
        children: Array.from({ length: 20 }, () => Text({ dimColor: true, children: ['│'] })),
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
