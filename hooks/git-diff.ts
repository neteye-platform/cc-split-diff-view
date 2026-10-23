import type { Change, ChangeStatus, Hunk } from '../types'

const STATUS: Record<string, ChangeStatus> = { A: 'added', D: 'deleted' }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Joins the output of `git diff --name-status -z --no-renames` and
 * `git diff --numstat -z --no-renames` into one list, in git's order.
 */
export function parseChanges(nameStatus: string, numstat: string): Change[] {
  const counts = new Map<string, { added: number; removed: number; isBinary: boolean }>()
  for (const record of numstat.split('\0')) {
    const [added, removed, ...path] = record.split('\t')
    if (path.length === 0) continue
    // A binary file counts as '-' on both sides.
    const isBinary = added === '-'
    counts.set(path.join('\t'), {
      added: isBinary ? 0 : Number(added),
      removed: isBinary ? 0 : Number(removed),
      isBinary,
    })
  }

  const tokens = nameStatus.split('\0')
  const changes: Change[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const path = tokens[i + 1] as string
    const count = counts.get(path) ?? { added: 0, removed: 0, isBinary: false }
    changes.push({ path, status: STATUS[(tokens[i] as string).charAt(0)] ?? 'modified', ...count })
  }
  return changes
}

/** The files of `git ls-files --others -z`, as changes. */
export function parseUntracked(output: string): Change[] {
  return output
    .split('\0')
    .filter(path => path !== '')
    .map(path => ({ path, status: 'untracked', added: 0, removed: 0, isBinary: false }))
}

/**
 * The hunks of the unified diff of one file. Everything before the first
 * `@@` (the `diff --git`, mode and `---`/`+++` lines) is skipped.
 */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }
      hunks.push(current)
      continue
    }
    if (current !== null && line !== '' && ' +-\\'.includes(line.charAt(0))) current.lines.push(line)
  }
  return hunks
}
