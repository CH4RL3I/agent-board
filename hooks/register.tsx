import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Board, Entry, Mood, Sprite } from '../types'

// Agent board: pixel agents above the prompt, one per subagent or teammate of
// this session and one per other Claude session that is working or waiting.
// Sprites are 16x10 pixels drawn as 16x5 cells with half blocks; working
// agents bob, which is the only animation.

const board = atom({ plugin: 'agent-board', key: 'board' } as const, { entries: [], resting: 0 } as Board)
const isHidden = atom({ plugin: 'agent-board', key: 'isHidden' } as const, false)

const COLS = 16
const ROWS = 5
const SLOT = 18
const MAX_SHOWN = 8
const WAITING_FOR_MS = 30 * 60 * 1000
const DEFAULT = 0x01000000

// One char per pixel; '.' is transparent.
const MAPS: Record<Sprite, { pal: Record<string, number>; px: string[] }> = {
  conductor: {
    pal: { o: 0xe07a52, k: 0x15161d },
    px: ['...oooooooo.....', '...oooooooo.....', '...oooookoo.....', 'oooooooookoooo..', 'oooooooooooooo..', '..oooooooooo....', '..oo......oo....', '................'],
  },
  builder: {
    pal: { b: 0x6aa6ff, k: 0x15161d },
    px: ['...bbbbbbbbbb...', '...bkbbbbbbkb...', '.bbbbbbbbbbbbbb.', '.bbbbbbbbbbbbbb.', '...bbbbbbbbbb...', '...b.b....b.b...', '...b.b....b.b...', '................'],
  },
  scout: {
    pal: { c: 0x5fe0e0, k: 0x15161d, w: 0xf1ede4 },
    px: ['....cccccccc....', '..cccwwwwwwccc..', '..ccwwkwwkwwcc..', '..cccwwwwwwccc..', '....cccccccc....', '...cc......cc...', '..cc........cc..', '................'],
  },
  mate: {
    pal: { y: 0xffd23f, r: 0xef3f78, s: 0xf4dcc0, k: 0x15161d },
    px: ['......yyyy......', '...rrryyyyrrr...', '..rrrrrrrrrrrr..', '..rssssssssssr..', '..rsskssssksr...', '..rssssssssssr..', '...rrrrrrrrrr...', '................'],
  },
  session: {
    pal: { p: 0xa58cff, k: 0x15161d },
    px: ['................', '....pppppppp....', '...pppppppppp...', '...ppkppppkpp...', '...pppppppppp...', '....pppppppp....', '....p..pp..p....', '................'],
  },
}

const DIM = 0x55566a

function pixelGrid(sprite: Sprite, lift: number, mood: Mood): number[][] {
  const { pal, px } = MAPS[sprite]
  const grid: number[][] = Array.from({ length: ROWS * 2 }, () => Array(COLS).fill(-1))
  const top = 2 - lift
  px.forEach((row, y) => {
    for (let x = 0; x < COLS; x += 1) {
      const c = pal[row[x]]
      if (c !== undefined) grid[top + y][x] = mood === 'done' ? DIM : c
    }
  })
  // a status pixel pair in the top-right corner: yellow = waiting for you, green = done, red = failed
  const mark = mood === 'waiting' ? 0xffd23f : mood === 'done' ? 0x61d68a : mood === 'failed' ? 0xef3f78 : -1
  if (mark !== -1) {
    grid[0][14] = mark
    grid[0][15] = mark
    grid[1][14] = mark
    grid[1][15] = mark
  }
  return grid
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

export function cells(sprite: Sprite, lift: number, mood: Mood): string {
  const grid = pixelGrid(sprite, lift, mood)
  const words = new Uint32Array(COLS * ROWS * 3)
  for (let r = 0; r < ROWS; r += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const upper = grid[r * 2][x]
      const lower = grid[r * 2 + 1][x]
      const i = (r * COLS + x) * 3
      if (upper === -1 && lower === -1) {
        words.set([0x20, DEFAULT, DEFAULT], i)
      } else if (upper === -1) {
        words.set([0x2584, lower, DEFAULT], i)
      } else {
        words.set([0x2580, upper, lower === -1 ? DEFAULT : lower], i)
      }
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

function short(text: string, n = SLOT - 2): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function moodOf(status: string): Mood {
  if (status === 'running' || status === 'pending') return 'working'
  if (status === 'waiting' || status === 'idle') return 'waiting'
  if (status === 'failed' || status === 'killed') return 'failed'
  return 'done'
}

function spriteOf(type: string, isTeammate: boolean): Sprite {
  if (isTeammate) return 'mate'
  if (/explore|plan|guide|review|validator/i.test(type)) return 'scout'
  return 'builder'
}

type SessionFile = { pid?: number; sessionId?: string; status?: string; entrypoint?: string; statusUpdatedAt?: number; tmux?: string; name?: string; cwd?: string }

const ctx = { home: '', ownId: '', bandId: '', frame: 0, isMainWorking: false, extraDirs: [] as string[], doneAt: new Map<string, number>() }

// Session directories to read: ~/.claude/sessions, every ~/.claude-*/sessions
// (a second profile kept in its own config dir), and any directories listed in
// the extraSessionDirs option.
export async function sessionDirs($: any): Promise<string[]> {
  const dirs = [`${ctx.home}/.claude/sessions`]
  try {
    for (const f of await $.fs.list(ctx.home)) {
      if (f.kind === 'dir' && /^\.claude-.+/.test(f.name)) dirs.push(`${ctx.home}/${f.name}/sessions`)
    }
  } catch {
    // home not listable; the default directory still works
  }
  for (const d of ctx.extraDirs) dirs.push(d.startsWith('~/') ? `${ctx.home}${d.slice(1)}` : d)
  return [...new Set(dirs)]
}

async function sessions($: any): Promise<{ shown: Entry[]; resting: number }> {
  const found: SessionFile[] = []
  for (const dir of await sessionDirs($)) {
    if (!(await $.fs.exists(dir))) continue
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      try {
        found.push(JSON.parse((await $.fs.read(`${dir}/${f.name}`)) as string))
      } catch {
        // a file being rewritten right now; next poll reads it
      }
    }
  }
  const mine = found.filter(s => s.entrypoint === 'cli' && s.sessionId !== ctx.ownId && typeof s.pid === 'number')
  if (mine.length === 0) return { shown: [], resting: 0 }
  const ps = await $.process.run(['ps', '-o', 'pid=', '-p', mine.map(s => s.pid).join(',')], { timeoutMs: 3000 })
  const alive = new Set(ps.stdout.split('\n').map((l: string) => Number(l.trim())).filter(Boolean))
  const now = await $.clock.now()
  const seen = new Set<string>()
  const shown: Entry[] = []
  let resting = 0
  for (const s of mine) {
    if (!alive.has(s.pid as number) || !s.sessionId || seen.has(s.sessionId)) continue
    seen.add(s.sessionId)
    // the session's own name if it has one, else its tmux session, else the folder it runs in
    const tmuxName = (s.tmux ?? '').split(':')[0]
    const label = short(s.name || tmuxName || (s.cwd ?? '').split('/').pop() || 'session')
    if (s.status === 'busy') {
      shown.push({ id: s.sessionId, label, mood: 'working', sprite: 'session' })
    } else if (now - (s.statusUpdatedAt ?? 0) < WAITING_FOR_MS) {
      shown.push({ id: s.sessionId, label, mood: 'waiting', sprite: 'session' })
    } else {
      resting += 1
    }
  }
  return { shown, resting }
}

async function refresh($: any) {
  const now = await $.clock.now()
  const agents = await $.agent.list()
  const own: Entry[] = []
  for (const a of agents) {
    const mood = moodOf(a.status)
    if (mood === 'done' || mood === 'failed') {
      // keep a finished agent on the board for a minute, then let it go
      const at = ctx.doneAt.get(a.id) ?? now
      ctx.doneAt.set(a.id, at)
      if (now - at > 60_000) continue
    }
    own.push({ id: a.id, label: short(a.name ?? a.description ?? a.type), mood, sprite: spriteOf(a.type, Boolean(a.teammateId)) })
  }
  const { shown, resting } = await sessions($)
  const entries: Entry[] = []
  if (own.length > 0) {
    entries.push({ id: 'main', label: '♪ this session', mood: ctx.isMainWorking ? 'working' : 'waiting', sprite: 'conductor' })
  }
  entries.push(...own, ...shown)
  const before = await read($, board)
  const same = JSON.stringify(before) === JSON.stringify({ entries, resting })
  if (!same) await update($, board, () => ({ entries, resting }))
}

async function animate($: any) {
  if (!ctx.bandId || (await read($, isHidden))) return
  const { entries } = await read($, board)
  if (!entries.some(x => x.mood === 'working')) return
  ctx.frame = 1 - ctx.frame
  for (const x of entries.slice(0, MAX_SHOWN)) {
    if (x.mood !== 'working') continue
    void $.ui.blit({ requestId: ctx.bandId, key: `s-${x.id}`, cells: cells(x.sprite, ctx.frame, x.mood) })
  }
}

export const register: Register = (on, options) => {
  const raw = typeof options?.extraSessionDirs === 'string' ? options.extraSessionDirs : ''
  ctx.extraDirs = raw.split(',').map(x => x.trim()).filter(Boolean)

  on('session.start', async ($, e, next) => {
    const r = await $.process.run(['/bin/sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 3000 })
    ctx.home = r.stdout.trim()
    ctx.ownId = await $.session.id()
    await $.command.register({ name: 'agent-board', description: 'Show or hide the pixel agent board above the prompt' })
    $.clock.every(3000, () => {
      void refresh($)
    })
    // the bob: only working agents move, two frames
    $.clock.every(350, () => {
      void animate($)
    })
    void refresh($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) ctx.isMainWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) ctx.isMainWorking = false
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'agent-board' }, async $ => {
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? 'Agent board hidden. /agent-board shows it again.' : 'Agent board shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const { entries, resting } = await read($, board)
    if (entries.length === 0) return next(e)
    ctx.bandId = e.requestId
    const { Box, Text, Raster } = $.ui.resolve(e)
    const fit = Math.max(1, Math.min(MAX_SHOWN, Math.floor(e.props.bodyColumns / SLOT)))
    const shown = entries.slice(0, fit)
    const more = entries.length - shown.length
    const colour = (m: Mood) => (m === 'working' ? '#6aa6ff' : m === 'waiting' ? '#ffd23f' : m === 'failed' ? '#ef3f78' : '#61d68a')
    const word = (m: Mood) => (m === 'working' ? 'working' : m === 'waiting' ? 'waiting for you' : m === 'failed' ? 'failed' : 'done')
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          {shown.map(x => (
            <Box key={x.id} flexDirection="column" width={SLOT}>
              <Raster key={`s-${x.id}`} columns={COLS} rows={ROWS} cells={cells(x.sprite, 0, x.mood)} />
              <Text bold color={colour(x.mood)} wrap="truncate-end">{x.label}</Text>
              <Text dimColor wrap="truncate-end">{word(x.mood)}</Text>
            </Box>
          ))}
        </Box>
        {(more > 0 || resting > 0) && (
          <Text dimColor>
            {more > 0 ? `+${more} more on the board` : ''}{more > 0 && resting > 0 ? ' · ' : ''}{resting > 0 ? `${resting} other sessions idle` : ''}
          </Text>
        )}
      </Box>
    )
  })
}
