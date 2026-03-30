import { create } from 'zustand'

export interface ProbeEvent {
  type: string
  timestamp: number
  pid: number
  seq: number
  data: Record<string, unknown>
}

interface EventStore {
  events: ProbeEvent[]
  addEvent: (event: ProbeEvent) => void
  clearEvents: () => void
  setEvents: (events: ProbeEvent[]) => void
}

const MAX_EVENTS = 1000

export const useEventStore = create<EventStore>((set) => ({
  events: [],
  addEvent: (event) =>
    set((state) => ({
      events: [...state.events.slice(-MAX_EVENTS + 1), event],
    })),
  clearEvents: () => set({ events: [] }),
  setEvents: (events) => set({ events: events.slice(-MAX_EVENTS) }),
}))