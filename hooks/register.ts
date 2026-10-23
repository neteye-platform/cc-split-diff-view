import type { On } from 'claude-code'

import { registerDiffSplit } from './diff-command.js'
import { TEXT_BUDGET, drawDiff, rowsWithin } from './draw.js'
import type { Kit } from './draw.js'
import { splitRows } from './split-rows.js'

/** Tools whose result is a diff this mod redraws. */
const TOOLS = ['Edit', 'Write']

/** Rows drawn before "… N more rows". */
const MAX_ROWS = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Draws the result block of an Edit or Write call as a split diff: removed
 * lines in the left column and added lines in the right, with line numbers.
 *
 * @param on the engine's registrar
 */
export function register(on: On) {
  registerDiffSplit(on)

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, output, isErrored } = e.props
    if (!TOOLS.includes(tool) || isErrored || !isRecord(output)) return next(e)
    // An edit held for review wrote nothing, so there is no diff to show.
    if (output.staged === true) return next(e)

    const diff = splitRows(output.structuredPatch)
    // No hunks (a new file, an identical write): leave Claude Code's drawing alone.
    if (diff === null) return next(e)

    const kit: Kit = $.ui.resolve(e)
    const path = typeof output.filePath === 'string' ? output.filePath : undefined

    // The same limits as the pane: rows, and the characters the engine draws of a tree.
    const { count } = rowsWithin(diff, MAX_ROWS, TEXT_BUDGET)

    return drawDiff(kit, diff, { path, maxRows: count, layout: 'tool-result' })
  })
}
