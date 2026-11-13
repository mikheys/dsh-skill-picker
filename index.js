/**
 * @local/dsh-skill-picker — Host half (v2).
 *
 * Two scopes:
 *  - `defaults`: skills hidden for every chat (including future ones);
 *  - per-session overrides: hide extra skills for one chat, or re-enable a
 *    globally hidden one just for that chat.
 *
 * Enforcement is per Agent: same-name runtime shadows are registered in the
 * Agent's own scope, so the model-facing catalog loses them. Hidden skills stay
 * user-invocable — typing `/name` in the message still loads the real body,
 * which the shadow carries over from the preset catalog.
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'skill-picker'
export const inject = ['skills', 'webServer']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'skill-picker')
const STATE_PATH = join(STATE_DIR, 'selections.json')
const DICTIONARY_URL = new URL('./russian.json', import.meta.url)
const API_BASE = '/skill-picker/api'
const MAX_BODY_BYTES = 64 * 1024

/** sessionId -> disposer that removes that Agent's shadow registrations. */
const shadows = new Map()
let dictionaryCache = null

/* ------------------------------------------------------------------ state */

function emptyState() {
  return { version: 2, defaults: [], sessions: {} }
}

function uniqueNames(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))]
}

function normalizeState(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  state.defaults = uniqueNames(raw.defaults ?? raw.hidden)
  const sessions = raw.sessions
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return state
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (Array.isArray(value)) {
      // version 1 shape: a plain hidden list per session
      const hidden = uniqueNames(value)
      if (hidden.length > 0) state.sessions[sessionId] = { hidden, enabled: [] }
      continue
    }
    if (!value || typeof value !== 'object') continue
    const hidden = uniqueNames(value.hidden)
    const enabled = uniqueNames(value.enabled)
    if (hidden.length > 0 || enabled.length > 0) state.sessions[sessionId] = { hidden, enabled }
  }
  return state
}

async function loadState() {
  try {
    return normalizeState(JSON.parse(await fsp.readFile(STATE_PATH, 'utf8')))
  } catch {
    return emptyState()
  }
}

async function saveState(state) {
  await fsp.mkdir(STATE_DIR, { recursive: true })
  const tmp = `${STATE_PATH}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 1) + '\n', 'utf8')
  await fsp.rename(tmp, STATE_PATH)
}

function sessionOverride(state, sessionId) {
  const value = state.sessions?.[sessionId]
  return {
    hidden: uniqueNames(value?.hidden),
    enabled: uniqueNames(value?.enabled),
  }
}

/** Effective hidden set of one chat: global defaults, plus chat extras, minus chat re-enables. */
function effectiveHidden(state, sessionId) {
  const session = sessionOverride(state, sessionId)
  const result = new Set([...state.defaults, ...session.hidden])
  for (const name of session.enabled) result.delete(name)
  return [...result].sort()
}

function setSessionOverride(state, sessionId, hidden, enabled) {
  const nextHidden = uniqueNames(hidden)
  const nextEnabled = uniqueNames(enabled).filter((name) => state.defaults.includes(name))
  if (nextHidden.length === 0 && nextEnabled.length === 0) delete state.sessions[sessionId]
  else state.sessions[sessionId] = { hidden: nextHidden, enabled: nextEnabled }
}

async function dictionary() {
  if (dictionaryCache) return dictionaryCache
  try {
    dictionaryCache = JSON.parse(await fsp.readFile(DICTIONARY_URL, 'utf8'))
  } catch {
    dictionaryCache = {}
  }
  return dictionaryCache
}

/* ----------------------------------------------------------------- agents */

function liveAgent(ctx, sessionId) {
  if (!sessionId) return undefined
  try {
    return ctx.get('agents')?.get?.(sessionId)
  } catch {
    return undefined
  }
}

function presetIdFor(ctx, sessionId, agent) {
  const presets = ctx.get('agentPresets')
  try {
    if (agent && presets?.presetForSession) return presets.presetForSession(agent.session)
  } catch {
    /* ignore */
  }
  try {
    return ctx.get('sessions')?.get?.(sessionId)?.header?.agentPreset
  } catch {
    return undefined
  }
}

/** Run one read inside the session preset's scope, so Agent-layer shadows do not affect it. */
async function withPresetScope(ctx, sessionId, agent, fn) {
  const presets = ctx.get('agentPresets')
  const presetId = presetIdFor(ctx, sessionId, agent)
  let lease
  try {
    if (presets?.acquireScope) lease = await presets.acquireScope(presetId)
  } catch {
    lease = undefined
  }
  try {
    return await fn(lease?.key)
  } finally {
    if (lease) {
      try {
        await (lease[Symbol.asyncDispose]?.() ?? lease[Symbol.dispose]?.())
      } catch {
        /* already released */
      }
    }
  }
}

async function catalogFor(ctx, sessionId, agent, cwd) {
  const skills = ctx.get('skills')
  if (!skills?.snapshot) return { skills: [], complete: false }
  return withPresetScope(ctx, sessionId, agent, async (scope) =>
    skills.snapshot({
      ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
      ...(scope === undefined ? {} : { scope }),
    }),
  )
}

/**
 * Runtime shadows for one Agent: same name, model-hidden, user-invocable with
 * the real body, registered inside the Agent's own scope.
 */
function shadowPluginFor(entries) {
  function skillPickerShadows(ctx) {
    for (const entry of entries) {
      try {
        ctx.skills.register(entry)
      } catch {
        /* duplicate or unsupported registration stays non-fatal */
      }
    }
  }
  skillPickerShadows.inject = ['skills']
  return skillPickerShadows
}

function disposeShadows(sessionId) {
  const dispose = shadows.get(sessionId)
  if (!dispose) return
  shadows.delete(sessionId)
  try {
    dispose()
  } catch {
    /* the Agent scope may already be unwound */
  }
}

async function applyHidden(ctx, sessionId, hidden) {
  const agent = liveAgent(ctx, sessionId)
  disposeShadows(sessionId)
  if (!agent) return { applied: false, reason: 'no-live-agent', count: 0, withBody: 0 }
  const names = uniqueNames(hidden)
  if (names.length === 0) return { applied: true, reason: 'nothing-hidden', count: 0, withBody: 0 }
  if (typeof agent.ctx?.plugin !== 'function') return { applied: false, reason: 'agent-scope-unavailable', count: 0, withBody: 0 }
  const skills = ctx.get('skills')
  if (!skills?.snapshot) return { applied: false, reason: 'no-skills', count: 0, withBody: 0 }
  const cwd = agent.session?.header?.cwd
  const entries = []
  let withBody = 0
  try {
    await withPresetScope(ctx, sessionId, agent, async (scope) => {
      const view = {
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
        ...(scope === undefined ? {} : { scope }),
      }
      const snapshot = await skills.snapshot(view)
      const byName = new Map((snapshot.skills ?? []).map((skill) => [skill.name, skill]))
      for (const skillName of names) {
        const summary = byName.get(skillName)
        if (!summary) continue
        let definition
        try {
          definition = await skills.get(skillName, view)
        } catch {
          definition = undefined
        }
        const content = typeof definition?.content === 'string' ? definition.content : ''
        if (content.length > 0) withBody += 1
        const registration = {
          name: skillName,
          description: `${summary.description} — скрыт из каталога модели для этой задачи`,
          content: content.length > 0 ? content : `Навык «${skillName}» скрыт из каталога модели для этой задачи.`,
          source: 'runtime',
          ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
          ...(definition?.resourceBase === undefined ? {} : { resourceBase: definition.resourceBase }),
          ...(definition?.metadata === undefined ? {} : { metadata: definition.metadata }),
          invocation: { modelInvocable: false, userInvocable: content.length > 0 },
        }
        entries.push(registration)
      }
    })
  } catch (error) {
    return { applied: false, reason: String(error?.message ?? error), count: 0, withBody: 0 }
  }
  if (entries.length === 0) return { applied: true, reason: 'unknown-names', count: 0, withBody: 0 }
  let fiber
  try {
    fiber = agent.ctx.plugin(shadowPluginFor(entries))
  } catch (error) {
    return { applied: false, reason: String(error?.message ?? error), count: 0, withBody: 0 }
  }
  shadows.set(sessionId, () => {
    try {
      fiber?.dispose?.()
    } catch {
      /* Agent scope already unwound */
    }
  })
  return { applied: true, reason: 'ok', count: entries.length, withBody }
}

/** Apply the stored selection to every live Agent (used by a global change). */
async function applyAllLive(ctx) {
  const state = await loadState()
  let applied = 0
  let failed = 0
  let agents = []
  try {
    agents = ctx.get('agents')?.list?.() ?? []
  } catch {
    agents = []
  }
  for (const agent of agents) {
    const sessionId = agent?.session?.id
    if (!sessionId) continue
    const result = await applyHidden(ctx, sessionId, effectiveHidden(state, sessionId))
    if (result.applied) applied += 1
    else failed += 1
  }
  return { applied, failed, agents: agents.length }
}

/* -------------------------------------------------------------------- HTTP */

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(String(origin)).host === String(req.headers.host ?? '')
  } catch {
    return false
  }
}

function fence(req, res) {
  if (originAllowed(req)) return false
  sendJson(res, 403, { ok: false, summary: 'foreign origin is not allowed' })
  return true
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      throw new Error('request body is too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function jsonContentType(req) {
  return String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase() === 'application/json'
}

async function catalogPayload(ctx, sessionId, cwd) {
  const state = await loadState()
  const agent = liveAgent(ctx, sessionId)
  const snapshot = await catalogFor(ctx, sessionId, agent, cwd)
  const dict = await dictionary()
  const session = sessionOverride(state, sessionId)
  const defaults = new Set(state.defaults)
  const effective = new Set(effectiveHidden(state, sessionId))
  const skills = (snapshot.skills ?? []).map((skill) => {
    const russian = dict[skill.name]
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse ?? null,
      modelInvocable: skill.invocation?.modelInvocable !== false,
      source: skill.source,
      provider: skill.provider,
      category: russian?.category ?? 'Прочее',
      title: russian?.title ?? skill.name,
      descriptionRu: russian?.description ?? null,
      globallyHidden: defaults.has(skill.name),
      chatHidden: effective.has(skill.name),
      chatReenabled: session.enabled.includes(skill.name),
    }
  })
  return {
    ok: true,
    sessionId,
    agentLive: Boolean(agent),
    complete: snapshot.complete !== false,
    defaults: state.defaults,
    session,
    effectiveHidden: [...effective].sort(),
    skills,
  }
}

function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer?.register) return

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/catalog`,
        handler: async (req, res) => {
          if (fence(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          try {
            const url = new URL(String(req.url ?? ''), 'http://localhost')
            const sessionId = url.searchParams.get('sessionId') ?? ''
            const cwd = url.searchParams.get('cwd') ?? undefined
            if (!sessionId) {
              sendJson(res, 400, { ok: false, summary: 'sessionId is required' })
              return
            }
            sendJson(res, 200, await catalogPayload(ctx, sessionId, cwd))
          } catch (error) {
            sendJson(res, 500, { ok: false, summary: String(error?.message ?? error) })
          }
        },
      }),
    `skill-picker: GET ${API_BASE}/catalog`,
  )

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/selection`,
        handler: async (req, res) => {
          if (fence(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          if (!jsonContentType(req)) {
            sendJson(res, 415, { ok: false, summary: 'content-type must be application/json' })
            return
          }
          try {
            const body = JSON.parse(await readJsonBody(req))
            const scope = body?.scope === 'global' ? 'global' : 'chat'
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
            if (scope === 'chat' && !sessionId) {
              sendJson(res, 400, { ok: false, summary: 'sessionId is required for the chat scope' })
              return
            }
            const state = await loadState()
            if (scope === 'global') {
              state.defaults = uniqueNames(body?.hidden)
              for (const [id, override] of Object.entries(state.sessions)) {
                override.enabled = uniqueNames(override.enabled).filter((name) => state.defaults.includes(name))
                if (override.hidden.length === 0 && override.enabled.length === 0) delete state.sessions[id]
              }
              await saveState(state)
              const applied = await applyAllLive(ctx)
              sendJson(res, 200, {
                ok: true,
                scope: 'global',
                defaults: state.defaults,
                applied,
              })
              return
            }
            setSessionOverride(state, sessionId, body?.hidden, body?.enabled)
            await saveState(state)
            const result = await applyHidden(ctx, sessionId, effectiveHidden(state, sessionId))
            sendJson(res, 200, {
              ok: true,
              scope: 'chat',
              session: sessionOverride(state, sessionId),
              effectiveHidden: effectiveHidden(state, sessionId),
              applied: result,
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, summary: String(error?.message ?? error) })
          }
        },
      }),
    `skill-picker: POST ${API_BASE}/selection`,
  )

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/debug`,
        handler: async (req, res) => {
          if (fence(req, res)) return
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          const skills = ctx.get('skills')
          let sample
          try {
            const list = await skills.list({})
            const name = list[0]?.name
            const body = name === undefined ? undefined : await skills.get(name, {})
            sample = {
              name: name ?? null,
              bodyChars: typeof body?.content === 'string' ? body.content.length : 0,
              resourceBaseKind: body?.resourceBase?.kind ?? null,
            }
          } catch (error) {
            sample = { error: String(error?.message ?? error) }
          }
          sendJson(res, 200, {
            ok: true,
            hasSnapshot: typeof skills?.snapshot === 'function',
            hasGet: typeof skills?.get === 'function',
            sample,
            liveAgents: (ctx.get('agents')?.list?.() ?? []).length,
            shadows: [...shadows.keys()].length,
          })
        },
      }),
    `skill-picker: GET ${API_BASE}/debug`,
  )
}

/* ------------------------------------------------------------------- entry */

export function apply(ctx) {
  registerRoutes(ctx)

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    if (!sessionId) return
    return (async () => {
      try {
        const state = await loadState()
        const hidden = effectiveHidden(state, sessionId)
        if (hidden.length > 0) await applyHidden(ctx, sessionId, hidden)
      } catch {
        /* best-effort */
      }
    })()
  })

  ctx.on('agent/disposed', (payload) => {
    const sessionId = payload?.agent?.session?.id
    if (sessionId) disposeShadows(sessionId)
  })

  // Re-apply after HMR/reinstall to Agents that already exist.
  void (async () => {
    try {
      await applyAllLive(ctx)
    } catch {
      /* best-effort */
    }
  })()
}

/** Test hook: the state file location. */
export const __internal = { STATE_PATH, API_BASE }
