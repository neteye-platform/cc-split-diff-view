import { expect, test } from 'claude-code/testing'

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type Viewport = { columns: number; rows: number }

const NARROW: Viewport = { columns: 60, rows: 40 }
const WIDE: Viewport = { columns: 200, rows: 40 }

/** Mounts the result of an Edit that replaces `before` with `after` on one line. */
const mountEdit = ($: Ctx, before: string, after: string, viewport?: Viewport) =>
  $.ui.mount({
    plugin: 'cc-split-diff-view',
    component: 'ToolResult',
    requestId: 'edit-wrap',
    surface: 'terminal',
    ...(viewport === undefined ? {} : { viewport }),
    props: {
      tool_use_id: 'toolu_w',
      tool: 'Edit',
      isErrored: false,
      output: {
        filePath: '/tmp/f.txt',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-' + before, '+' + after] }],
      },
    },
  })

type Mounted = Awaited<ReturnType<typeof mountEdit>>

/** The Code elements of the diff, with the wrap they ask for. */
const codes = async (ui: Mounted) =>
  (await ui.findAll({ type: 'Code' })).map(code => ({ source: code.text, wrap: code.props.wrap }))

/** True for the tinted pair: one Code holding both the removed and the added line. */
const isPair = (source: string) => /\n-/.test(source) && /\n\+/.test(source)

const text = (length: number, fill: string) => fill.repeat(length)

test('a short pair keeps the tinted pair, one hunk in each column', async $ => {
  const ui = await mountEdit($, 'const a = 1', 'const a = 2', NARROW)
  const found = await codes(ui)
  expect(found).toHaveLength(2)
  for (const code of found) {
    expect(isPair(code.source)).toBe(true)
    expect(code.source).toContain('const a = 1')
    expect(code.source).toContain('const a = 2')
  }
  await ui.unmount()
})

test('a pair too long for a narrow screen wraps in two cells', async $ => {
  // 50 characters: more than a column of a 60-column screen holds.
  const ui = await mountEdit($, text(50, 'a'), text(50, 'b'), NARROW)
  const found = await codes(ui)
  expect(found).toHaveLength(2)
  expect(found.some(code => isPair(code.source))).toBe(false)
  expect(found.map(code => code.wrap)).toEqual(['wrap', 'wrap'])
  expect(found[0]?.source).toMatch(/\n-a{50}$/)
  expect(found[1]?.source).toMatch(/\n\+b{50}$/)
  await ui.unmount()
})

test('the same pair keeps the tint on a wide screen', async $ => {
  const ui = await mountEdit($, text(50, 'a'), text(50, 'b'), WIDE)
  const found = await codes(ui)
  expect(found).toHaveLength(2)
  expect(found.every(code => isPair(code.source))).toBe(true)
  await ui.unmount()
})

test('a pair too long for a wide screen wraps too', async $ => {
  // 150 characters against a column of about 97.
  const ui = await mountEdit($, text(150, 'a'), text(150, 'b'), WIDE)
  const found = await codes(ui)
  expect(found.some(code => isPair(code.source))).toBe(false)
  expect(found.map(code => code.wrap)).toEqual(['wrap', 'wrap'])
  await ui.unmount()
})

test('one long line is enough to wrap the pair', async $ => {
  const ui = await mountEdit($, 'short', text(150, 'b'), WIDE)
  const found = await codes(ui)
  expect(found.some(code => isPair(code.source))).toBe(false)
  expect(found.map(code => code.wrap)).toEqual(['wrap', 'wrap'])
  await ui.unmount()
})

test('wide characters take two columns', async $ => {
  // 15 characters, 30 columns: a column of a 60-column screen holds 23.
  const ui = await mountEdit($, text(15, '漢'), text(15, '字'), NARROW)
  expect((await codes(ui)).some(code => isPair(code.source))).toBe(false)
  await ui.unmount()
})

test('an unknown width wraps every changed pair, even a short one', async $ => {
  for (const length of [1, 40, 41]) {
    const ui = await mountEdit($, text(length, 'a'), text(length, 'b'))
    const found = await codes(ui)
    expect(found.some(code => isPair(code.source))).toBe(false)
    expect(found.map(code => code.wrap)).toEqual(['wrap', 'wrap'])
    await ui.unmount()
  }
})

test('enclosed ideographs take two columns', async $ => {
  // 15 of U+1F250 are 30 columns: more than a column of a 60-column screen holds after the gutter.
  const ui = await mountEdit($, text(15, '\u{1F250}'), text(15, '\u{1F251}'), NARROW)
  expect((await codes(ui)).some(code => isPair(code.source))).toBe(false)
  await ui.unmount()
})

test('no code element truncates when the lines are long', async $ => {
  for (const viewport of [NARROW, WIDE, undefined]) {
    const ui = await mountEdit($, text(300, 'a'), text(300, 'b'), viewport)
    expect((await codes(ui)).filter(code => code.wrap === 'truncate-end')).toEqual([])
    await ui.unmount()
  }
})

test('the tool result has no frame', async $ => {
  const ui = await mountEdit($, 'const a = 1', 'const a = 2', NARROW)
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect(box.props).not.toHaveProperty('borderStyle')
    expect(box.props).not.toHaveProperty('borderDimColor')
  }
  // The rows keep the indent that puts them under the response marker.
  expect(boxes.some(box => box.props.marginLeft === 5)).toBe(true)
  await ui.unmount()
})

test('the files a Bash command updated wrap long pairs too', async ($, on) => {
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['engine drawing'] }))
  const mount = (viewport: Viewport) =>
    $.ui.mount({
      plugin: 'cc-split-diff-view',
      component: 'ToolResult',
      requestId: 'bash-wrap',
      surface: 'terminal',
      viewport,
      props: {
        tool_use_id: 'toolu_bw',
        tool: 'Bash',
        isErrored: false,
        output: {
          stdout: 'done',
          stderr: '',
          interrupted: false,
          bashEditDiff: {
            files: [{ filePath: '/w/a.txt', hunks: [{ oldStart: 1, newStart: 1, lines: ['-' + text(50, 'a'), '+' + text(50, 'b')] }] }],
            moreFiles: 0,
          },
        },
      },
    })

  // 50 characters fit the columns of a 200-column screen, not of a 60-column one.
  const wide = await mount(WIDE)
  expect((await codes(wide)).every(code => isPair(code.source))).toBe(true)
  await wide.unmount()

  const narrow = await mount(NARROW)
  const found = await codes(narrow)
  expect(found.some(code => isPair(code.source))).toBe(false)
  expect(found.map(code => code.wrap)).toEqual(['wrap', 'wrap'])
  await narrow.unmount()
})

// A tinted pair is one hunk, and the engine makes its gutter as wide as the largest number in it:
// with old line 9 against new line 10 the left text would sit a column right of the other rows.
test('a pair whose line numbers differ in digits is drawn in cells, so the columns line up', async $ => {
  const ui = await $.ui.mount({
    plugin: 'cc-split-diff-view',
    component: 'ToolResult',
    requestId: 'edit-digits',
    surface: 'terminal',
    viewport: WIDE,
    props: {
      tool_use_id: 'toolu_d',
      tool: 'Edit',
      isErrored: false,
      output: {
        filePath: '/tmp/f.txt',
        structuredPatch: [{ oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }],
      },
    },
  })
  const found = await codes(ui)
  expect(found.some(code => isPair(code.source))).toBe(false)
  expect(found).toHaveLength(2)
  await ui.unmount()
})

test('a pair whose line numbers have the same digits keeps the tint', async $ => {
  const ui = await $.ui.mount({
    plugin: 'cc-split-diff-view',
    component: 'ToolResult',
    requestId: 'edit-digits-same',
    surface: 'terminal',
    viewport: WIDE,
    props: {
      tool_use_id: 'toolu_e',
      tool: 'Edit',
      isErrored: false,
      output: {
        filePath: '/tmp/f.txt',
        structuredPatch: [{ oldStart: 12, oldLines: 1, newStart: 22, newLines: 1, lines: ['-old', '+new'] }],
      },
    },
  })
  expect((await codes(ui)).every(code => isPair(code.source))).toBe(true)
  await ui.unmount()
})
