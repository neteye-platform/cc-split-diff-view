import { expect, test } from 'claude-code/testing'

import { parseChanges, parseHunks, parseUntracked } from '../hooks/git-diff.js'
import { splitRows } from '../hooks/split-rows.js'

test('joins name-status and numstat into one list', async () => {
  const nameStatus = ['M', 'src/a.ts', 'A', 'new file.ts', 'D', 'gone.ts', 'M', 'logo.png', ''].join('\0')
  const numstat = ['3\t1\tsrc/a.ts', '10\t0\tnew file.ts', '0\t7\tgone.ts', '-\t-\tlogo.png', ''].join('\0')

  expect(parseChanges(nameStatus, numstat)).toEqual([
    { path: 'src/a.ts', status: 'modified', added: 3, removed: 1, isBinary: false },
    { path: 'new file.ts', status: 'added', added: 10, removed: 0, isBinary: false },
    { path: 'gone.ts', status: 'deleted', added: 0, removed: 7, isBinary: false },
    { path: 'logo.png', status: 'modified', added: 0, removed: 0, isBinary: true },
  ])
})

test('an empty diff has no changes', async () => {
  expect(parseChanges('', '')).toEqual([])
})

test('lists untracked files', async () => {
  expect(parseUntracked(['a.txt', 'dir/b c.txt', ''].join('\0'))).toEqual([
    { path: 'a.txt', status: 'untracked', added: 0, removed: 0, isBinary: false },
    { path: 'dir/b c.txt', status: 'untracked', added: 0, removed: 0, isBinary: false },
  ])
})

const diff = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  ' tail',
  '@@ -20 +20,2 @@ function x() {',
  '-gone',
  '+one',
  '+two',
  '\\ No newline at end of file',
  '',
].join('\n')

test('reads hunks and skips the file header', async () => {
  expect(parseHunks(diff)).toEqual([
    { oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new', ' tail'] },
    { oldStart: 20, newStart: 20, lines: ['-gone', '+one', '+two', '\\ No newline at end of file'] },
  ])
})

test('a diff with no hunk (binary, mode change) gives none', async () => {
  expect(parseHunks('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toEqual([])
})

test('hunks from git feed the split view', async () => {
  const rows = splitRows(parseHunks(diff.replace('\\ No newline at end of file\n', '')))
  expect(rows?.added).toBe(3)
  expect(rows?.removed).toBe(2)
})

test('a missing final newline on one side has no split form', async () => {
  expect(splitRows(parseHunks(diff))).toBeNull()
})
