/** How git sees a changed file. */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked'

/** One changed file in the `/diffsplit` pane. */
export type Change = {
  path: string
  status: ChangeStatus
  added: number
  removed: number
  /** Git cannot show a text diff of the file. */
  isBinary: boolean
}

/** One hunk of a unified diff; `lines` keep their ' ', '-', '+' or '\' mark. */
export type Hunk = {
  oldStart: number
  newStart: number
  lines: string[]
}

/** A changed file with the diff git gave for it. */
export type FileDiff = Change & { hunks: Hunk[] }

/** What `git` reported when the pane was last loaded. */
export type Snapshot =
  | {
      kind: 'changes'
      files: FileDiff[]
      /** Changed files past the limit: counted, not shown. */
      hiddenFiles: number
    }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'cc-split-diff-view': {
      snapshot: Shaped<Snapshot | null>
      /** Paths of the files the person folded. */
      folded: Shaped<string[]>
    }
  }
}
