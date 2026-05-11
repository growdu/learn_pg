import { create } from 'zustand'

export interface PGConfig {
  host: string
  port: number
  user: string
  database: string
}

export interface PGState {
  connected: boolean
  version: string
  dataDir: string
  config: PGConfig
  setConnected: (v: boolean) => void
  setVersion: (v: string) => void
  setDataDir: (v: string) => void
  setConfig: (c: PGConfig) => void
}

export const usePGStore = create<PGState>((set) => ({
  connected: false,
  version: '',
  dataDir: '',
  config: {
    host: 'pgv-postgres',
    port: 5432,
    user: 'postgres',
    database: 'postgres',
  },
  setConnected: (v) => set({ connected: v }),
  setVersion: (v) => set({ version: v }),
  setDataDir: (v) => set({ dataDir: v }),
  setConfig: (c) => set({ config: c }),
}))