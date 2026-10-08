import { expect, test } from 'claude-code/testing'

import { splitRows } from '../hooks/split-rows.js'

const patch = [
  {
    oldStart: 10,
    oldLines: 4,
    newStart: 10,
    newLines: 5,
    lines: [' keep', '-old one', '-old two', '+new one', '+new two', '+new three', ' tail'],
  },
  { oldStart: 40, oldLines: 1, newStart: 41, newLines: 1, lines: ['-x', '+y'] },
]

test('pairs removed lines with the added lines that follow them', async () => {
  const diff = splitRows(patch)
  expect(diff).not.toBeNull()
  expect(diff?.added).toBe(4)
  expect(diff?.removed).toBe(3)

  const rows = diff?.rows ?? []
  // keep, (old one|new one), (old two|new two), (-|new three), tail, gap, (x|y)
  expect(rows).toHaveLength(7)
  expect(rows[1]).toEqual({
    kind: 'row',
    left: { no: 11, text: 'old one' },
    right: { no: 11, text: 'new one' },
    changed: true,
  })
  expect(rows[3]).toEqual({
    kind: 'row',
    left: null,
    right: { no: 13, text: 'new three' },
    changed: true,
  })
})

test('numbers lines from each hunk and reports the lines skipped between hunks', async () => {
  const rows = splitRows(patch)?.rows ?? []
  expect(rows[5]).toEqual({ kind: 'gap', hidden: 26 })
  expect(rows[6]).toEqual({
    kind: 'row',
    left: { no: 40, text: 'x' },
    right: { no: 41, text: 'y' },
    changed: true,
  })
})

test('returns null when there is nothing to draw', async () => {
  expect(splitRows([])).toBeNull()
  expect(splitRows(undefined)).toBeNull()
  expect(splitRows([{ oldStart: 'a', newStart: 1, lines: [] }])).toBeNull()
})

test('lays tabs out as spaces and drops control characters', async () => {
  const rows = splitRows([{ oldStart: 1, newStart: 1, lines: ['-a\tb\r', '+c\u200bd'] }])?.rows ?? []
  expect(rows[0]).toEqual({
    kind: 'row',
    left: { no: 1, text: 'a    b' },
    right: { no: 1, text: 'cd' },
    changed: true,
  })
})

test('returns null when only one side lacks a trailing newline', async () => {
  const lines = ['-foo', '\\ No newline at end of file', '+foo']
  expect(splitRows([{ oldStart: 1, newStart: 1, lines }])).toBeNull()
})

test('keeps the split when both sides lack a trailing newline', async () => {
  const lines = ['-foo', '\\ No newline at end of file', '+bar', '\\ No newline at end of file']
  expect(splitRows([{ oldStart: 1, newStart: 1, lines }])?.rows).toHaveLength(1)
})
