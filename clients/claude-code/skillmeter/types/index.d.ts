// The session status the plugin's hooks write (scripts/lib/session-status.js)
// and hooks/status.tsx shows: a collection state and its reason (ADR 003).
export type SessionStatus = {
  state: string
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    skillmeter: { sessionStatus: SessionStatus | null }
  }
}
