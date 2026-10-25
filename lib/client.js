/**
 * dsh-compaction-thresholds — browser half (ModuleLoader format, no build step).
 *
 * Renders one block inside a pi-ai provider's card on Settings → Models. The
 * block lists that provider's models and lets the user type an auto-compaction
 * trigger in TOKENS; saving writes THIS plugin's own volatile settings
 * namespace (`compaction-thresholds`), whose host half projects the table into
 * the agent-preset rows as `modelPolicies` ratios and publishes the outcome
 * back into the same namespace as `report`.
 *
 * Why the host is not written directly: preset rows are Loader rows, not
 * settings entries, so the browser cannot reach them
 * (`dsh-agent-preset`'s Config declares no volatile field). The two-hop shape
 * above is the only sanctioned path and adds no new Remote namespace
 * (`dsh-api-remotes` fixes that set at build time).
 */
window.__ModuleLoader__.load({
  id: 'dsh-compaction-thresholds',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    /** Our own settings namespace (equals the Loader row id). */
    var NS = 'compaction-thresholds'
    /** Dictionary namespace owned by this plugin. */
    var LOCALE_NS = 'settings.compactionThresholds'
    /** Settings namespace of the pi-ai provider family (the seat's dispatch key). */
    var MODELS_NS = 'llm-pi-ai'
    /** The third-party seat this entry contributes into. */
    var SLOT = 'settings.models.provider-card'
    /** dsh-compaction-basic/lib/index.js:15-17 — shipped defaults. */
    var DEFAULT_THRESHOLD_RATIO = 0.8
    var DEFAULT_HEADROOM_TOKENS = 65536

    var zh = {
      title: '自动压缩触发点',
      hint: '填 token 数，插件换算成 compaction-basic 的比例；未填写的模型沿用预设里已有的值。',
      tokens: 'tokens',
      save: '保存',
      saving: '写入中…',
      clear: '清除',
      clearing: '清除中…',
      unset: '未设置',
      presetDefault: '预设默认',
      ceiling: '上限',
      window: '窗口',
      invalid: '请输入大于 0 的整数 token 数。',
      refused: '宿主拒绝了这次写入（可能和另一次配置修改撞车），已重新读取最新值，请再试一次。',
      failed: '保存失败：',
      empty: '该 provider 还没有配置任何模型。',
      readOnly: '本部署的设置为只读。',
      loading: '读取设置中…',
      over: '超过可用上限，压缩后端会把触发点截断到上限值。',
      synced: '已同步',
      notSynced: '未同步',
      notes: '提示',
    }

    var en = {
      title: 'Compaction trigger',
      hint: 'Enter a token count; the plugin converts it to the ratio compaction-basic needs. Models left blank keep the value already in the preset.',
      tokens: 'tokens',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Clear',
      clearing: 'Clearing…',
      unset: 'Not set',
      presetDefault: 'Preset default',
      ceiling: 'Ceiling',
      window: 'Window',
      invalid: 'Enter a positive whole number of tokens.',
      refused: 'The host refused this write (likely a concurrent configuration change). State was reloaded; try again.',
      failed: 'Save failed: ',
      empty: 'This provider has no configured models yet.',
      readOnly: 'Settings are read-only in this deployment.',
      loading: 'Reading settings…',
      over: 'Above the available ceiling; the compaction backend will clamp the trigger to it.',
      synced: 'Synced',
      notSynced: 'Not synced',
      notes: 'Note',
    }

    /** Format an integer with thousands separators. */
    function fmt(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
    }

    /** Format a report timestamp as a local wall-clock time. */
    function clock(at) {
      if (!(at > 0)) return ''
      try {
        return new Date(at).toLocaleTimeString()
      } catch (error) {
        return ''
      }
    }

    /** Parse a user-typed token count; undefined when it is not a positive integer. */
    function parseTokens(text) {
      if (typeof text !== 'string') return undefined
      var trimmed = text.replace(/[\s,_]/g, '')
      if (!/^[0-9]+$/.test(trimmed)) return undefined
      var value = Number(trimmed)
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    }

    /**
     * The trigger the compaction backend fires at when no policy overrides the
     * shipped ratio, mirrored from `resolveCompactSpec`.
     * @param contextWindow - adapter model window.
     * @param reservedTokens - output reservation.
     * @returns the effective shipped default in tokens.
     */
    function shippedDefault(contextWindow, reservedTokens) {
      if (!(contextWindow > 0)) return undefined
      var messageBudget = contextWindow - reservedTokens
      var pressure = messageBudget - DEFAULT_HEADROOM_TOKENS
      if (!(pressure > 0)) return undefined
      return Math.floor(Math.min(contextWindow * DEFAULT_THRESHOLD_RATIO, pressure))
    }

    /**
     * Subscribe a component to one settings form snapshot.
     * @param form - bound ConfigForm face ({ subscribe, getSnapshot }).
     * @returns the current ConfigFormSnapshot.
     */
    function useFormSnapshot(form) {
      var pair = useState(() => form.getSnapshot())
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      useEffect(() => {
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => {
          setSnapshot(form.getSnapshot())
        })
      }, [form])
      return snapshot
    }

    /** Read a form snapshot's section as an object, when it has one. */
    function sectionOf(snapshot) {
      return snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : undefined
    }

    /** The rows of our own table. */
    function tableOf(snapshot) {
      var section = sectionOf(snapshot)
      return section !== undefined && Array.isArray(section.models) ? section.models : []
    }

    /** The last published projection outcome. */
    function reportOf(snapshot) {
      var section = sectionOf(snapshot)
      var report = section === undefined ? undefined : section.report
      return report !== null && typeof report === 'object'
        ? {
          at: typeof report.at === 'number' ? report.at : 0,
          synced: Array.isArray(report.synced) ? report.synced : [],
          failed: Array.isArray(report.failed) ? report.failed : [],
          notes: Array.isArray(report.notes) ? report.notes : [],
        }
        : { at: 0, synced: [], failed: [], notes: [] }
    }

    /**
     * One model's editor row.
     * @param props - model, capacity facts, saved table row, save/clear callbacks.
     * @returns the row element.
     */
    function ModelRow(props) {
      var t = props.t
      var model = props.model
      var saved = props.saved
      var disabled = props.disabled
      var contextWindow = props.contextWindow
      var reservedTokens = props.reservedTokens
      var draft = useState('')
      var text = draft[0]
      var setText = draft[1]
      var ceiling = Math.max(contextWindow - reservedTokens - DEFAULT_HEADROOM_TOKENS, 0)
      var fallback = shippedDefault(contextWindow, reservedTokens)
      var typed = parseTokens(text)
      var over = typed !== undefined && ceiling > 0 && typed > ceiling
      var value = text.length > 0 ? text : saved === undefined ? '' : String(saved.compactAtTokens)
      var facts = [model.id, t('window') + ' ' + fmt(contextWindow), t('ceiling') + ' ' + fmt(ceiling)]
        .concat(fallback === undefined ? [] : [t('presetDefault') + ' ' + fmt(fallback)])
        .join(' · ')
      return h('div', { style: rowStyle }, [
        h('div', { key: 'id', style: idBlockStyle }, [
          h('span', { key: 'name', style: nameStyle }, model.name || model.id),
          h('span', { key: 'facts', style: idStyle }, facts),
        ]),
        h('div', { key: 'ctrl', style: controlStyle }, [
          h('input', {
            key: 'input',
            type: 'text',
            inputMode: 'numeric',
            value: value,
            disabled: disabled,
            placeholder: saved === undefined ? t('unset') : '',
            'aria-label': t('title') + ' ' + model.id,
            onChange: (event) => {
              setText(event.target.value)
            },
            style: inputStyle,
          }),
          h('span', { key: 'unit', style: unitStyle }, t('tokens')),
          h('button', {
            key: 'save',
            type: 'button',
            disabled: disabled,
            style: buttonStyle(disabled),
            onClick: () => {
              var tokens = parseTokens(value)
              if (tokens === undefined) {
                props.onStatus({ kind: 'error', message: t('invalid') })
                return
              }
              props.onSave(model.id, tokens).then((accepted) => {
                if (accepted) setText('')
              })
            },
          }, props.busy ? t('saving') : t('save')),
          saved === undefined ? null : h('button', {
            key: 'clear',
            type: 'button',
            disabled: disabled,
            style: buttonStyle(disabled),
            onClick: () => {
              props.onClear(model.id)
            },
          }, props.busy ? t('clearing') : t('clear')),
        ]),
        over ? h('div', { key: 'over', style: warnStyle }, t('over') + ' ' + t('ceiling') + ' ' + fmt(ceiling)) : null,
      ])
    }

    /**
     * The card body: reads both namespaces and renders one row per provider model.
     * @param props - forms (bound faces), provider id, locale reader, seat props.
     * @returns the block element.
     */
    function CardBody(props) {
      var t = props.t
      var forms = props.forms
      var provider = props.provider
      var ours = useFormSnapshot(forms.ours)
      var models = useFormSnapshot(forms.models)
      var statusPair = useState(null)
      var current = statusPair[0]
      var setStatus = statusPair[1]
      var busyPair = useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var catalog = sectionOf(models)
      var profile = catalog === undefined || catalog.providers === undefined ? undefined : catalog.providers[provider]
      var list = profile !== undefined && Array.isArray(profile.models) ? profile.models : []
      var table = tableOf(ours)
      var report = reportOf(ours)
      var writable = ours.status === 'ready' && ours.writable === true
      var owned = (row) => row !== null && typeof row === 'object' && row.provider === provider

      /** The latest table straight from the form, not this render's closure. */
      var latestTable = () => {
        var snapshot = forms.ours.getSnapshot()
        var section = sectionOf(snapshot)
        return section !== undefined && Array.isArray(section.models) ? section.models : []
      }

      /**
       * Write one table with a single retry on a revision conflict.
       * @param build - derives the next table from the host's current one.
       * @returns whether the host accepted it.
       */
      var writeTable = async (build) => {
        for (var attempt = 0; attempt < 2; attempt += 1) {
          var next = build(latestTable())
          var accepted = await forms.ours.mutate([{ op: 'set', path: ['models'], value: next }])
          if (accepted) return true
          await new Promise((resolve) => {
            setTimeout(resolve, 150)
          })
        }
        return false
      }

      /** Order the table like the provider's catalog. */
      var sortLikeCatalog = (rows) => {
        var order = new Map()
        for (var index = 0; index < list.length; index += 1) order.set(list[index] && list[index].id, index)
        return rows.slice().sort((left, right) => (order.get(left && left.model) ?? 0) - (order.get(right && right.model) ?? 0))
      }

      var saveRow = async (modelId, tokens) => {
        setBusy(modelId)
        setStatus(null)
        try {
          var accepted = await writeTable((rows) => {
            var previous = rows.find((row) => owned(row) && row.model === modelId)
            var entry = { provider: provider, model: modelId, compactAtTokens: tokens }
            if (previous !== undefined && Number.isFinite(previous.retainTokens)) entry.retainTokens = previous.retainTokens
            return sortLikeCatalog(rows.filter((row) => !(owned(row) && row.model === modelId)).concat([entry]))
          })
          if (!accepted) {
            setStatus({ kind: 'error', message: t('refused') })
            return false
          }
          setStatus({ kind: 'pending' })
          return true
        } catch (error) {
          var message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
          setStatus({ kind: 'error', message: t('failed') + message })
          return false
        } finally {
          setBusy(null)
        }
      }

      var clearRow = async (modelId) => {
        setBusy(modelId)
        setStatus(null)
        try {
          var accepted = await writeTable((rows) => rows.filter((row) => !(owned(row) && row.model === modelId)))
          if (!accepted) {
            setStatus({ kind: 'error', message: t('refused') })
            return
          }
          setStatus({ kind: 'pending' })
        } catch (error) {
          var message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
          setStatus({ kind: 'error', message: t('failed') + message })
        } finally {
          setBusy(null)
        }
      }

      var children = [h('div', { key: 'head', style: headStyle }, [
        h('span', { key: 'title', style: titleStyle }, t('title')),
        h('span', { key: 'ns', style: providerTagStyle }, provider + ' · ' + MODELS_NS),
      ]), h('div', { key: 'hint', style: hintStyle }, t('hint'))]

      if (ours.status === 'loading' || models.status === 'loading') children.push(h('div', { key: 'loading', style: hintStyle }, t('loading')))
      else if (list.length === 0) children.push(h('div', { key: 'empty', style: hintStyle }, t('empty')))
      else {
        var total = report.synced.length + report.failed.length
        for (var index = 0; index < list.length; index += 1) {
          var model = list[index]
          if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
          var contextWindow = Number.isFinite(model.contextWindow) ? model.contextWindow : 0
          if (contextWindow <= 0 && profile !== undefined && Number.isFinite(profile.defaultContextWindow)) contextWindow = profile.defaultContextWindow
          var reserved = Number.isFinite(model.maxTokens) ? model.maxTokens : 0
          if (reserved <= 0 && profile !== undefined && Number.isFinite(profile.defaultMaxTokens)) reserved = profile.defaultMaxTokens
          var savedRow = table.find((row) => owned(row) && row.model === model.id)
          children.push(h(ModelRow, {
            key: model.id,
            t: t,
            model: model,
            saved: savedRow,
            contextWindow: contextWindow,
            reservedTokens: reserved,
            disabled: !writable || busy !== null,
            busy: busy === model.id,
            onSave: saveRow,
            onClear: clearRow,
            onStatus: setStatus,
          }))
        }
        if (!writable) children.push(h('div', { key: 'ro', style: hintStyle }, t('readOnly')))
        // Projection outcome, as published by the host on our own row.
        if (total > 0) {
          if (report.failed.length > 0) {
            var failedText = report.failed.map((item) => item.preset + '（' + item.message + '）').join('; ')
            children.push(h('div', { key: 'report', style: errorStyle }, t('notSynced') + ' ' + report.failed.length + '/' + total + ': ' + failedText))
          } else {
            children.push(h('div', { key: 'report', style: okStyle }, t('synced') + ' ' + report.synced.length + '/' + total + (report.at > 0 ? ' · ' + clock(report.at) : '')))
          }
          for (var noteIndex = 0; noteIndex < Math.min(report.notes.length, 2); noteIndex += 1) {
            children.push(h('div', { key: 'note-' + noteIndex, style: warnStyle }, t('notes') + ': ' + report.notes[noteIndex]))
          }
        }
      }
      if (current !== null) {
        if (current.kind === 'pending') children.push(h('div', { key: 'status', style: hintStyle }, t('saving')))
        else children.push(h('div', { key: 'status', style: current.kind === 'ok' ? okStyle : errorStyle }, current.message))
      }
      return h('div', { style: cardStyle }, children)
    }

    /**
     * The seat component. The seat fires for every pi-ai provider card, so a
     * card without a resolvable provider id renders nothing.
     * @param props - owner props plus the injected face.
     * @returns the block or null.
     */
    function CompactionThresholdsCard(props) {
      if (props === null || typeof props !== 'object') return null
      var entry = props.provider
      if (entry === null || typeof entry !== 'object') return null
      var provider = typeof entry.provider === 'string' ? entry.provider : ''
      if (provider.length === 0) return null
      return h(CardBody, Object.assign({}, props, { provider: provider }))
    }

    /** Bind a ConfigForm's methods once, so the effect/subscription identity stays stable. */
    function bindForm(form) {
      return {
        subscribe: form.subscribe.bind(form),
        getSnapshot: form.getSnapshot.bind(form),
        mutate: form.mutate.bind(form),
      }
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the trigger editor into every pi-ai provider card.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'compaction-thresholds: dictionaries')
      const forms = {
        ours: bindForm(ctx.configForms.get(NS)),
        models: bindForm(ctx.configForms.get(MODELS_NS)),
      }
      ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        key: MODELS_NS,
        inject: () => ({ forms, t }),
      }, CompactionThresholdsCard)), 'compaction-thresholds: provider card')
    }

    var cardStyle = {
      marginTop: '10px',
      paddingTop: '10px',
      borderTop: '1px solid var(--dsh-border, rgba(128, 128, 128, 0.28))',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      fontSize: '12px',
    }
    var headStyle = { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }
    var titleStyle = { fontWeight: 600, fontSize: '12px' }
    var providerTagStyle = { opacity: 0.55, fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
    var hintStyle = { opacity: 0.65, fontSize: '11px', lineHeight: 1.5 }
    var rowStyle = {
      display: 'grid',
      gridTemplateColumns: 'minmax(140px, 1fr) auto',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 8px',
      borderRadius: '6px',
      background: 'var(--dsh-surface-sunken, rgba(128, 128, 128, 0.08))',
    }
    var idBlockStyle = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
    var nameStyle = { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var idStyle = { fontSize: '10px', opacity: 0.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
    var controlStyle = { display: 'flex', alignItems: 'center', gap: '6px' }
    var inputStyle = {
      width: '108px',
      padding: '3px 6px',
      fontSize: '12px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      textAlign: 'right',
      borderRadius: '4px',
      border: '1px solid var(--dsh-border, rgba(128, 128, 128, 0.4))',
      background: 'transparent',
      color: 'inherit',
    }
    var unitStyle = { fontSize: '11px', opacity: 0.6 }
    var warnStyle = { gridColumn: '1 / -1', fontSize: '10px', color: 'var(--dsh-warning, #c98a00)', lineHeight: 1.4 }
    var okStyle = { fontSize: '11px', color: 'var(--dsh-success, #1f9d55)' }
    var errorStyle = { fontSize: '11px', color: 'var(--dsh-danger, #d64545)' }
    function buttonStyle(disabled) {
      return {
        padding: '3px 10px',
        fontSize: '11px',
        borderRadius: '4px',
        border: '1px solid var(--dsh-border, rgba(128, 128, 128, 0.4))',
        background: 'transparent',
        color: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
