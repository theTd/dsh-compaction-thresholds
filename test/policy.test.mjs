import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPlan,
  planPolicies,
  ratioForTokens,
  sameJson,
} from '../lib/policy.js'

/** A preset shaped like the shipped web presets, with the plugin's own block already present. */
function preset() {
  return {
    id: 'standard',
    order: 1,
    plugins: [
      {
        id: 'tool-bash',
        name: '@deepseek-ai/dsh-tool-bash',
        disabled: { __jsExpr: "process.platform === 'win32'" },
      },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          {
            id: 'compaction-basic',
            name: '@deepseek-ai/dsh-compaction-basic',
            config: { thresholdRatio: 0.305176 },
          },
          {
            id: 'tool-result-pruner',
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
            config: { thresholdChars: 8192 },
          },
        ],
      },
    ],
  }
}

const FLASH = {
  provider: 'clay',
  model: 'deepseek-flash',
  contextWindow: 1048576,
  reservedTokens: 384000,
  compactAtTokens: 320000,
}

test('ratioForTokens reproduces the typed token count exactly', () => {
  const cases = [
    [320000, 1048576],
    [200000, 1000000],
    [1, 1048576],
    [999, 1000],
    [1000, 1000],
  ]
  for (const [tokens, budget] of cases) {
    const ratio = ratioForTokens(tokens, budget)
    assert.ok(ratio > 0 && ratio <= 1, `ratio in range for ${tokens}/${budget}`)
    assert.equal(Math.floor(budget * ratio), tokens, `floor(${budget} * ratio) === ${tokens}`)
  }
  assert.equal(ratioForTokens(1048577, 1048576), undefined, 'tokens above the window are unrepresentable')
  assert.equal(ratioForTokens(0, 1048576), undefined)
  assert.equal(ratioForTokens(1, 0), undefined)
})

test('planPolicies adds a policy and leaves every sibling untouched', () => {
  const config = preset()
  const { patches, changed } = planPolicies(config, [FLASH])
  assert.equal(changed, true)
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0].policies, [
    { provider: 'clay', model: 'deepseek-flash', thresholdRatio: 0.3051762580871582 },
  ])
  const next = applyPlan(config, patches)
  const basic = next.plugins[1].config[0].config
  assert.equal(basic.thresholdRatio, 0.305176, 'the shipped global ratio survives')
  assert.deepEqual(basic.modelPolicies, patches[0].policies)
  assert.deepEqual(next.plugins[1].config[1].config, { thresholdChars: 8192 }, 'pruner untouched')
  assert.deepEqual(next.plugins[0].disabled, { __jsExpr: "process.platform === 'win32'" }, '!!js marker preserved')
  assert.equal(config.plugins[1].config[0].config.modelPolicies, undefined, 'input object is not mutated')
})

test('planPolicies is idempotent, so an idle reconcile writes nothing', () => {
  const once = applyPlan(preset(), planPolicies(preset(), [FLASH]).patches)
  const second = planPolicies(once, [FLASH])
  assert.equal(second.changed, false)
  assert.equal(second.patches.length, 0)
  assert.equal(applyPlan(once, second.patches), once, 'no patches means the same object')
})

test('planPolicies prunes only keys it owns', () => {
  const seeded = applyPlan(preset(), planPolicies(preset(), [FLASH]).patches)
  // A hand-written policy for a model outside the table must survive.
  seeded.plugins[1].config[0].config.modelPolicies.push({
    provider: 'clay',
    model: 'hand-written',
    thresholdRatio: 0.5,
  })
  const { patches } = planPolicies(seeded, [], { prune: new Set(['clay/deepseek-flash']) })
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0].policies, [
    { provider: 'clay', model: 'hand-written', thresholdRatio: 0.5 },
  ])
})

test('pruning the last policy drops the key instead of leaving an empty list', () => {
  const seeded = applyPlan(preset(), planPolicies(preset(), [FLASH]).patches)
  const { patches } = planPolicies(seeded, [], { prune: new Set(['clay/deepseek-flash']) })
  const next = applyPlan(seeded, patches)
  assert.equal('modelPolicies' in next.plugins[1].config[0].config, false)
  assert.deepEqual(next.plugins[1].config[0].config, { thresholdRatio: 0.305176 })
})

test('planPolicies keeps existing policy keys it does not own', () => {
  const seeded = applyPlan(preset(), planPolicies(preset(), [FLASH]).patches)
  seeded.plugins[1].config[0].config.modelPolicies = [{
    provider: 'clay',
    model: 'deepseek-flash',
    thresholdRatio: 0.5,
    retainRatio: 0.1,
    summarizationModel: 'cheap',
  }]
  const { patches } = planPolicies(seeded, [FLASH])
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0].policies[0], {
    provider: 'clay',
    model: 'deepseek-flash',
    thresholdRatio: 0.3051762580871582,
    retainRatio: 0.1,
    summarizationModel: 'cheap',
  })
})

test('planPolicies refuses an unreachable target instead of writing a broken config', () => {
  const notes = []
  // retain at or above the trigger is rejected by dsh-compaction-basic at load.
  const retainTooBig = planPolicies(preset(), [{ ...FLASH, retainTokens: 400000 }], { notes })
  assert.equal(retainTooBig.changed, false)
  assert.ok(notes.some((note) => note.includes('必须小于触发点')), 'explains the retain conflict')

  // A target above the window can never be expressed as a ratio.
  const aboveWindow = planPolicies(preset(), [{ ...FLASH, compactAtTokens: 2000000 }], { notes: [] })
  assert.equal(aboveWindow.changed, false)

  // The capacity ceiling caps a reachable-but-too-late target, and says so.
  const cappedNotes = []
  const capped = planPolicies(preset(), [{ ...FLASH, compactAtTokens: 900000 }], { notes: cappedNotes })
  assert.equal(capped.changed, true)
  assert.ok(cappedNotes.some((note) => note.includes('截断')), 'warns about the ceiling')
})

test('sameJson compares JSON-shaped values structurally', () => {
  assert.equal(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), false)
  assert.equal(sameJson([], []), true)
  assert.equal(sameJson([1, 2], [2, 1]), false)
  assert.equal(sameJson(null, {}), false)
})
