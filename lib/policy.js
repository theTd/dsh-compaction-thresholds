/**
 * dsh-compaction-thresholds — pure policy math and preset projection.
 *
 * Kept dependency-free so `node --test` can import it without the Cordis or
 * Schemastery module graph, and so the plugin wiring in `index.js` stays about
 * lifecycle rather than arithmetic.
 *
 * Formula parity with `@deepseek-ai/dsh-compaction-basic`:
 *   thresholdTokens = floor(min(contextWindow * thresholdRatio,
 *                              (contextWindow - O) - headroomTokens))
 *   retainTokens    = floor((contextWindow - O) * retainRatio)
 * with O = the routed request's reserved output (`info.defaultMaxTokens` when
 * the session header declares no cap) and headroomTokens defaulting to 65536.
 */

/** `dsh-compaction-basic/lib/index.js:63` — headroomTokens default. */
export const DEFAULT_HEADROOM_TOKENS = 65536

/** Owner keys of a `modelPolicies` entry, spelled like the backend's own target key. */
export function ownerKey(provider, model) {
  return `${provider}/${model}`
}

/**
 * Ratio whose `floor(ratio * budget)` is exactly `tokens`.
 *
 * `tokens / budget` alone loses the last token to binary rounding
 * (`floor(1048576 * (320000 / 1048576))` can land on 319999), so nudge by half a
 * token: `budget * ((tokens + 0.5) / budget)` is `tokens + 0.5` in exact
 * arithmetic, and `floor()` then returns `tokens`.
 *
 * @param tokens - desired integer token count.
 * @param budget - context window (or message budget) the ratio multiplies.
 * @returns a ratio in (0, 1], or undefined when the target is unreachable.
 */
export function ratioForTokens(tokens, budget) {
  if (!Number.isFinite(budget) || budget <= 0) return undefined
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  if (tokens > budget) return undefined
  const ratio = tokens === budget ? 1 : (tokens + 0.5) / budget
  if (!(ratio > 0) || ratio > 1) return undefined
  return Math.floor(budget * ratio) === tokens ? ratio : undefined
}

/**
 * Deep-equality for the JSON-shaped values this plugin produces.
 * @param left - first value.
 * @param right - second value.
 * @returns whether both are structurally identical.
 */
export function sameJson(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (typeof left !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => sameJson(item, right[index]))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
}

/**
 * Locate every `compaction` group child holding a `compaction-basic` row.
 * @param config - one preset row's raw config.
 * @returns addresses plus the backend's current config object.
 */
export function findCompactionTargets(config) {
  const targets = []
  const plugins = Array.isArray(config?.plugins) ? config.plugins : []
  plugins.forEach((row, pluginIndex) => {
    if (row === null || typeof row !== 'object' || row.id !== 'compaction') return
    const children = Array.isArray(row.config) ? row.config : []
    children.forEach((child, childIndex) => {
      if (child === null || typeof child !== 'object' || child.id !== 'compaction-basic') return
      const compaction = child.config !== null && typeof child.config === 'object' ? child.config : {}
      targets.push({ pluginIndex, childIndex, compaction })
    })
  })
  return targets
}

/**
 * Validate one table row against one backend config and derive its ratios.
 * @param decision - resolved model facts plus the requested token targets.
 * @param compaction - the backend config that will receive the policy.
 * @param notes - collector for human-readable skip reasons.
 * @returns the policy patch, or undefined when the request cannot be served.
 */
export function policyFor(decision, compaction, notes) {
  const { provider, model, contextWindow, reservedTokens, compactAtTokens, retainTokens } = decision
  const label = `${provider}/${model}`
  const messageBudget = contextWindow - reservedTokens
  if (messageBudget <= 0) {
    notes.push(`${label}: 模型窗口 ${contextWindow} 装不下预留输出 ${reservedTokens}，compaction-basic 会拒绝该路由`)
    return undefined
  }
  const headroom = Number.isInteger(compaction.headroomTokens) && compaction.headroomTokens >= 0
    ? compaction.headroomTokens
    : DEFAULT_HEADROOM_TOKENS
  if (messageBudget - headroom <= 0) {
    notes.push(`${label}: 消息预算 ${messageBudget} 减去 headroom ${headroom} 后没有可用压力空间`)
    return undefined
  }
  const thresholdRatio = ratioForTokens(compactAtTokens, contextWindow)
  if (thresholdRatio === undefined) {
    notes.push(`${label}: 触发点 ${compactAtTokens} 无法映射成 (0, 1] 的比例（窗口 ${contextWindow}）`)
    return undefined
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * thresholdRatio, messageBudget - headroom))
  if (thresholdTokens !== compactAtTokens) {
    notes.push(`${label}: 触发点被压缩后端的容量上限截断为 ${thresholdTokens} tokens（W-O-headroom = ${messageBudget - headroom}）`)
  }
  const policy = { provider, model, thresholdRatio }
  if (retainTokens !== undefined) {
    const retainRatio = ratioForTokens(retainTokens, messageBudget)
    if (retainRatio === undefined) {
      notes.push(`${label}: 保留 ${retainTokens} tokens 无法映射成 (0, 1] 的比例（消息预算 ${messageBudget}）`)
      return undefined
    }
    if (retainTokens >= thresholdTokens) {
      notes.push(`${label}: 保留 ${retainTokens} tokens 必须小于触发点 ${thresholdTokens}`)
      return undefined
    }
    if (retainRatio >= thresholdRatio) {
      notes.push(`${label}: 保留比例 ${retainRatio} 必须小于触发比例 ${thresholdRatio}`)
      return undefined
    }
    policy.retainRatio = retainRatio
  }
  return policy
}

/**
 * Compute the modelPolicies each preset row should carry.
 *
 * Rules:
 * - a table row that resolves becomes (or updates) its policy entry;
 * - keys in `prune` (previously written by this plugin, no longer in the table)
 *   are removed;
 * - policies for models this plugin never touched are preserved verbatim;
 * - every other field of the backend config is preserved;
 * - an entry whose ratios are already exact is left untouched, so an unchanged
 *   preset yields `changed: false` and no write happens.
 *
 * @param config - current raw preset config.
 * @param decisions - validated per-model facts from the settings table.
 * @param options - `prune`: owner keys to drop; `notes`: skip-reason collector.
 * @returns the policy arrays to install plus whether anything differs.
 */
export function planPolicies(config, decisions, options = {}) {
  const prune = options.prune ?? new Set()
  const notes = options.notes ?? []
  const patches = []
  for (const target of findCompactionTargets(config)) {
    const existing = Array.isArray(target.compaction.modelPolicies) ? target.compaction.modelPolicies : []
    const desired = []
    for (const entry of existing) {
      if (entry === null || typeof entry !== 'object') {
        desired.push(entry)
        continue
      }
      if (prune.has(ownerKey(entry.provider, entry.model))) continue
      desired.push(entry)
    }
    for (const decision of decisions) {
      const policy = policyFor(decision, target.compaction, notes)
      if (policy === undefined) continue
      const index = desired.findIndex(
        (entry) => entry?.provider === policy.provider && entry?.model === policy.model,
      )
      if (index < 0) {
        desired.push(policy)
        continue
      }
      const merged = { ...desired[index], thresholdRatio: policy.thresholdRatio }
      if (policy.retainRatio !== undefined) merged.retainRatio = policy.retainRatio
      if (merged.retainTokens !== undefined && policy.retainRatio !== undefined) delete merged.retainTokens
      desired[index] = merged
    }
    if (sameJson(desired, existing)) continue
    patches.push({ pluginIndex: target.pluginIndex, childIndex: target.childIndex, policies: desired })
  }
  return { patches, changed: patches.length > 0, notes }
}

/**
 * Apply planned policy arrays to a preset config, cloning only on change.
 * @param config - current raw preset config.
 * @param patches - output of {@link planPolicies}.
 * @returns the complete next config (the input object when there is nothing to do).
 */
export function applyPlan(config, patches) {
  if (patches.length === 0) return config
  const next = structuredClone(config)
  for (const patch of patches) {
    const row = next.plugins[patch.pluginIndex]
    const child = { ...row.config[patch.childIndex] }
    const compaction = { ...(child.config ?? {}) }
    // An empty list means "this plugin owns nothing here" — drop the key rather
    // than leaving `modelPolicies: []` behind.
    if (patch.policies.length > 0) compaction.modelPolicies = patch.policies
    else delete compaction.modelPolicies
    child.config = compaction
    const children = [...row.config]
    children[patch.childIndex] = child
    next.plugins[patch.pluginIndex] = { ...row, config: children }
  }
  return next
}
