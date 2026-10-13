import type { EngineInterface, Register } from 'claude-code'

import type { SessionStatus } from '../types'

/**
 * The collection state beside the prompt (ADR 003, decision 7).
 *
 * Reads the session's status file that the plugin's hooks write
 * (scripts/lib/session-status.js) and shows it as one dim label in the prompt
 * footer, plus one line above the prompt while the user has to act. It never
 * decides anything: with no file yet, or one it cannot read, it shows nothing.
 * The stop and resume notices stay with on_collection_state.js.
 */

// How often the file is read again between the events that also read it.
const REFRESH_MS = 10_000

const STATUS = { plugin: 'skillmeter', key: 'sessionStatus' } as const

// Footer label: an icon, the name, and at most a few words.
const LABEL: Record<string, string> = {
  recording: '● SkillMeter',
  unconfigured: '◌ SkillMeter · off here',
  paused: '◌ SkillMeter · paused',
  never_signed_in: '○ SkillMeter · signed out',
  signed_out: '○ SkillMeter · signed out',
  token_missing: '○ SkillMeter · signed out',
  revoked: '○ SkillMeter · no license',
  delivery_paused: '◐ SkillMeter · uploads paused',
}

// Band above the prompt: one line, only while the user has to act.
const BAND: Record<string, string> = {
  signed_out: 'SkillMeter stopped · /skillmeter:signin',
  token_missing: 'SkillMeter stopped · /skillmeter:signin',
  revoked: 'SkillMeter stopped · license revoked',
  delivery_paused: 'SkillMeter uploads paused · /skillmeter:signin',
}

function isStatus(value: unknown): value is SessionStatus {
  const v = value as SessionStatus | null
  return typeof v?.state === 'string' && typeof v?.reason === 'string'
}

// The plugin data directory, as scripts/lib/plugin-data-root.js resolves it:
// CLAUDE_PLUGIN_DATA, else <config>/plugins/data/<plugin>-<marketplace> from
// an installed cache layout <config>/plugins/cache/<marketplace>/<plugin>/<version>.
async function dataRoot($: EngineInterface): Promise<string | null> {
  const provided = await $.env.get('CLAUDE_PLUGIN_DATA')
  if (provided && !provided.includes('${')) return provided

  const parts = $.plugin.root.replace(/[\\/]+$/, '').split(/[\\/]/)
  const [cache, marketplace, plugin] = parts.slice(-4, -1)
  if (cache !== 'cache' || !marketplace || !plugin) return null
  const sep = $.plugin.root.includes('\\') ? '\\' : '/'
  return [...parts.slice(0, -4), 'data', `${plugin}-${marketplace}`].join(sep)
}

async function readStatus($: EngineInterface): Promise<SessionStatus | null> {
  try {
    const root = await dataRoot($)
    const id = await $.session.id()
    if (!root || !/^[A-Za-z0-9-]{1,128}$/.test(id)) return null
    const sep = root.includes('\\') ? '\\' : '/'
    const file = `${root}${sep}session-status${sep}${id}.json`
    if (!(await $.fs.exists(file))) return null
    const parsed: unknown = JSON.parse(await $.fs.read(file))
    return isStatus(parsed) ? { state: parsed.state, reason: parsed.reason } : null
  } catch {
    return null
  }
}

async function refresh($: EngineInterface) {
  const next = await readStatus($)
  const { value } = await $.state.get(STATUS)
  if (value?.state === next?.state && value?.reason === next?.reason) return
  await $.state.set(STATUS, next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // One dim label at the right of the prompt footer, beside the engine's own
  // modes. The pinned status line would carry the plugin's name; this does not.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { value } = await $.state.get(STATUS)
    const label = value ? LABEL[value.state] : undefined
    if (!label) return next(e)

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value } = await $.state.get(STATUS)
    const line = value ? BAND[value.state] : undefined
    if (!line || e.props.hasSurvey) return next(e)

    const { Text } = $.ui.resolve(e)

    return <Text color="warning">⚠ {line}</Text>
  })
}
