/**
 * dsh-compaction-thresholds — host half.
 *
 * Owns one volatile settings namespace (`compaction-thresholds`) that stores a
 * per-model table of *token* trigger points, and projects that table into every
 * agent-preset row's nested `compaction-basic` plugin config as `modelPolicies`
 * ratios — the only shape the compaction backend reads.
 *
 * Why a projection instead of a direct edit: preset rows are Loader rows, not
 * settings entries (`dsh-agent-preset`'s Config declares no volatile field, so
 * `settings.describe()` omits them and `settings.mutate()` refuses them). The
 * browser therefore writes THIS plugin's namespace and this plugin applies the
 * result with `ctx.configEditor.edit()`.
 *
 * Three volatile fields, three owners:
 *   models   — the user's table (browser-written)
 *   managed  — the keys this plugin has written (host-written, drives pruning)
 *   report   — the outcome of the last projection, for the settings card
 *              (host-written; `at` only moves when the outcome changes, so an
 *              idle deployment never rewrites the file)
 *
 * Formula parity with `@deepseek-ai/dsh-compaction-basic` lives in `policy.js`.
 */
import z from '@deepseek-ai/schemastery'
import { applyPlan, findCompactionTargets, ownerKey, planPolicies, sameJson } from './policy.js'

export const name = 'compaction-thresholds'

/** Services required before the projection may run. */
export const inject = ['llm', 'configEditor']

/** Reconcile cadence; a tick compares and writes only on a difference. */
const RECONCILE_INTERVAL_MS = 1500
/** Loader rows holding an agent preset. */
const PRESET_PREFIX = 'preset-'

const tableRow = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  compactAtTokens: z.number().step(1).min(1).required(),
  retainTokens: z.number().step(1).min(1),
})

/**
 * The ONLY user-writable field is `models`; `managed` and `report` exist so the
 * card can show what actually landed and so removed rows can be pruned.
 * `.volatile()` is what makes the namespace visible in `settings.describe()`
 * (dsh-settings/lib/index.js:122-131) and what allows `settings.mutate()` to
 * accept the write (:501-508).
 */
export const Config = z.object({
  models: z.array(tableRow).default([]).volatile(),
  managed: z.array(z.string()).default([]).volatile(),
  report: z
    .object({
      at: z.number().default(0),
      synced: z.array(z.string()).default([]),
      failed: z.array(z.object({ preset: z.string().required(), message: z.string().required() })).default([]),
      notes: z.array(z.string()).default([]),
    })
    .default({ at: 0, synced: [], failed: [], notes: [] })
    .volatile(),
})

/**
 * Read a volatile cell without caring whether resolution already wrapped it.
 * @param value - resolved config field (volatile cell) or a plain value.
 * @returns the live value.
 */
function liveValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Activate the projection.
 * @param ctx - host plugin context (owns `llm`, `configEditor`, and its own row id).
 * @param config - resolved plugin config; `models`, `managed`, `report` are volatile cells.
 */
export function apply(ctx, config) {
  /** This plugin's own Loader row id, which is also the settings namespace. */
  const ownId = ctx.fiber?.entry?.options.id ?? name

  /** The current table from our own volatile field. */
  const table = () => {
    const value = liveValue(config.models)
    return Array.isArray(value) ? value : []
  }
  /**
   * Keys this plugin has observed in the table. `managed` persists the same set
   * across restarts; `seen` covers rows written by an earlier version that did
   * not track them yet, so clearing such a row still prunes its policy.
   */
  const seen = new Set()
  /** Keys this plugin has written before, for pruning. */
  const managedKeys = () => {
    const value = liveValue(config.managed)
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : []
  }
  /** The previously published projection outcome. */
  const previousReport = () => {
    const value = liveValue(config.report)
    return value !== null && typeof value === 'object'
      ? { at: 0, synced: [], failed: [], notes: [], ...value }
      : { at: 0, synced: [], failed: [], notes: [] }
  }

  /**
   * Resolve each table row against the live LLM registry.
   *
   * No cache: the provider catalog can change under a fixed table (a model's
   * `contextWindow` edit changes what a fixed ratio means), and re-resolving is
   * a cheap in-process lookup. The churn guard below still skips every write.
   * @returns one decision per resolvable row.
   */
  const resolveTable = async () => {
    const decisions = []
    for (const row of table()) {
      if (row === null || typeof row !== 'object') continue
      const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
      const model = typeof row.model === 'string' ? row.model.trim() : ''
      const compactAtTokens = Math.round(Number(row.compactAtTokens))
      if (provider.length === 0 || model.length === 0) continue
      if (!Number.isSafeInteger(compactAtTokens) || compactAtTokens < 1) continue
      const retainTokens = Number.isFinite(row.retainTokens) && row.retainTokens >= 1
        ? Math.round(Number(row.retainTokens))
        : undefined
      let info
      try {
        info = await ctx.llm.resolveModelInfo(provider, model)
      } catch (error) {
        ctx.logger.warn(`compaction-thresholds: cannot resolve ${provider}/${model}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const contextWindow = info?.context?.contextWindow
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        ctx.logger.warn(`compaction-thresholds: ${provider}/${model} advertises no contextWindow; skipped`)
        continue
      }
      decisions.push({
        provider,
        model,
        contextWindow,
        reservedTokens: Number.isSafeInteger(info.defaultMaxTokens) ? info.defaultMaxTokens : 0,
        compactAtTokens,
        ...retainTokens === undefined ? {} : { retainTokens },
      })
    }
    return decisions
  }

  /** Preset rows that actually hold a compaction backend, re-read every pass. */
  const presetEntries = () => {
    if (ctx.configEditor === undefined) return []
    return ctx.configEditor.entries().filter((entry) => {
      const id = entry.options.id
      if (typeof id !== 'string' || !id.startsWith(PRESET_PREFIX)) return false
      if (entry.fiber === undefined || entry.fiber.state !== 2) return false
      return findCompactionTargets(entry.options.config ?? {}).length > 0
    })
  }

  /** Our own Loader row, re-read after every reconcile. */
  const ownEntry = () => ctx.configEditor?.entries().find((entry) => entry.options.id === ownId)

  /**
   * Write one preset row, retrying a transaction race with a fresh entry.
   * @param id - preset row id.
   * @param decisions - resolved table.
   * @param prune - owner keys to drop.
   * @returns undefined on success, the failure message otherwise.
   */
  const writePreset = async (id, decisions, prune) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const entry = presetEntries().find((candidate) => candidate.options.id === id)
      if (entry === undefined) return '预设行在当前组合里不存在'
      const plan = planPolicies(entry.options.config ?? {}, decisions, { prune })
      if (!plan.changed) return undefined
      try {
        await ctx.configEditor.edit(entry, (current) => applyPlan(current, planPolicies(current, decisions, { prune }).patches))
        return undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A settings write commits the volatile field inside its own HMR
        // transaction; dsh-hmr rejects nested ones. The reconcile loop runs
        // outside that context, so this is only a safety net for a write that
        // raced another transaction — retry with a fresh entry.
        if (!/cannot be nested/i.test(message) || attempt === 5) return message
        await new Promise((resolve) => {
          setTimeout(resolve, 80 * (attempt + 1))
        })
      }
    }
    return '写入重试耗尽'
  }

  /**
   * Publish the outcome on our own row (managed keys + report) when it changes.
   * @param nextManaged - keys to remember for pruning.
   * @param report - outcome to show in the card.
   */
  const publish = async (nextManaged, report) => {
    const entry = ownEntry()
    if (entry === undefined) return
    const current = entry.options.config ?? {}
    if (sameJson(current.managed ?? [], nextManaged) && sameJson(current.report ?? {}, report)) return
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const fresh = ownEntry()
      if (fresh === undefined) return
      try {
        await ctx.configEditor.edit(fresh, (raw) => ({ ...raw, managed: nextManaged, report }))
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/cannot be nested/i.test(message) || attempt === 5) {
          ctx.logger.warn(`compaction-thresholds: publishing the projection report failed: ${message}`)
          return
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 80 * (attempt + 1))
        })
      }
    }
  }

  /**
   * One projection pass.
   * @returns whether the preset rows were available (the tick is read-only otherwise).
   */
  const pass = async () => {
    const entries = presetEntries()
    if (entries.length === 0) return
    const decisions = await resolveTable()
    const notes = []
    const desired = new Set(decisions.map((decision) => ownerKey(decision.provider, decision.model)))
    for (const key of desired) seen.add(key)
    // Only prune keys this plugin wrote before (or saw in the table at runtime),
    // so hand-written policies for models outside the table survive.
    const prune = new Set([...managedKeys(), ...seen].filter((key) => !desired.has(key)))
    const synced = []
    const failed = []
    for (const id of entries.map((entry) => entry.options.id)) {
      const entry = entries.find((candidate) => candidate.options.id === id)
      if (entry === undefined) continue
      const plan = planPolicies(entry.options.config ?? {}, decisions, { prune, notes })
      if (!plan.changed) {
        synced.push(id)
        continue
      }
      const message = await writePreset(id, decisions, prune)
      if (message === undefined) synced.push(id)
      else failed.push({ preset: id, message })
    }
    for (const note of new Set(notes)) ctx.logger.warn(`compaction-thresholds: ${note}`)
    const previous = previousReport()
    const outcomeChanged = !sameJson(
      { synced, failed, notes: [...new Set(notes)].sort() },
      { synced: previous.synced, failed: previous.failed, notes: previous.notes },
    )
    // Keep a key remembered while any preset still failed to drop it.
    const nextManaged = failed.length === 0
      ? [...seen].sort()
      : [...new Set([...managedKeys(), ...seen])].sort()
    await publish(nextManaged, outcomeChanged
      ? { at: Date.now(), synced, failed, notes: [...new Set(notes)].sort() }
      : previous)
  }

  let running = false
  let queued = false

  /**
   * Serialize passes so overlapping ticks cannot interleave writes.
   * @param reason - what asked for this pass (logs only).
   */
  const run = async (reason) => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      do {
        queued = false
        await pass()
      } while (queued)
    } catch (error) {
      ctx.logger.error(`compaction-thresholds: ${reason} pass failed`)
      ctx.logger.error(error)
    } finally {
      running = false
    }
  }

  // Reconcile on a timer ARMED OUTSIDE any HMR transaction.
  //
  // Why not the obvious `ctx.on('loader/volatile-update', ...)`: a settings
  // write commits the volatile field from inside its own HMR transaction, and
  // dsh-hmr guards re-entry with an AsyncLocalStorage flag
  // (`if (this.executing.getStore()) reject("HMR transactions cannot be
  // nested")`). Anything scheduled from that listener inherits the store, so
  // every `configEditor.edit()` it started would be rejected no matter how
  // long it waited. A timer armed during activation carries a clean store, so
  // the projection can open its own transaction; the pass itself writes only
  // when a preset row actually differs, so an idle tick is read-only.
  ctx.effect(() => {
    const interval = setInterval(() => {
      void run('reconcile')
    }, RECONCILE_INTERVAL_MS)
    void run('activation')
    // Hide the auto-generated raw-JSON settings page: this plugin ships its own card.
    const settings = ctx.get('settings')
    if (settings !== undefined && typeof settings.configure === 'function') {
      settings.configure({ auto: false })
    }
    return () => clearInterval(interval)
  }, 'compaction-thresholds: reconcile loop')
}
