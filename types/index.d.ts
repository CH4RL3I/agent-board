export type Mood = 'working' | 'waiting' | 'done' | 'failed'
export type Sprite = 'conductor' | 'builder' | 'scout' | 'mate' | 'session'
export type Entry = { id: string; label: string; mood: Mood; sprite: Sprite }
export type Board = { entries: Entry[]; resting: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { board: Board; isHidden: boolean }
  }
}
