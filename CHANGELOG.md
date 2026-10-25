# Changelog

## 0.2.0 — release candidate

Release-standard pass. Behaviour is compatible with 0.1.0 (`models` unchanged);
the plugin row gains two host-owned volatile fields.

### Added

- **Projection report** (`report`): the host publishes which preset rows are in
  sync, which failed and why, plus capacity-ceiling notes. The settings card
  renders it, so a partial write is no longer silent.
- **Clear**:每行 a `清除` control removes the model from the table; the host
  then prunes the `modelPolicies` entry it wrote for that key.
- **Pruning ownership** (`managed`): the host remembers the keys it wrote, so it
  removes only its own policies and leaves hand-written ones alone. Keys seen in
  the table at runtime are also remembered, so rows written by 0.1.0 (which did
  not track them) are still pruned when cleared.
- **Bilingual copy**: `zh` + `en` dictionaries through `ctx.locale`, so the card
  follows the deployment language instead of hard-coding Chinese.
- **Provider-agnostic**: the card now renders for every `@deepseek-ai/dsh-llm-pi-ai`
  provider (clay included) instead of filtering on `clay`; the table already
  carries `provider` per row.
- **Tests**: `node --test test/` covers ratio exactness, projection, churn guard,
  pruning, refusal paths and the `!!js`-marker guarantee. Pure logic moved to
  `lib/policy.js` so tests need no module graph.
- `engines.dsh`, `LICENSE`, `CHANGELOG.md`, `scripts.test`.

### Changed

- Reconcile no longer caches provider decisions: the table can stay constant
  while a model's `contextWindow` changes, and a cached decision would keep the
  old ratio (which means a drifting token target). Every tick now re-resolves;
  the deep-equal churn guard still skips all writes when nothing changed.
- The auto-generated raw-JSON settings page is suppressed
  (`ctx.settings.configure({ auto: false })`) — this plugin ships its own card.
- A save retries once automatically when the host refuses it with a revision
  conflict (the host writes `report`/`managed` to the same namespace).

### Fixed

- Projection from the `loader/volatile-update` event could never succeed: the
  event is emitted inside the settings write's own HMR transaction and
  `dsh-hmr` rejects nested transactions through an `AsyncLocalStorage` flag.
  Replaced by a 1500 ms reconcile loop armed outside any transaction (0.1.0,
  found during verification; documented in the README).

### Known limits

- Presets keep their revision: a changed trigger applies to **new** sessions.
- A preset that fails to write is retried on every tick until it succeeds, but
  the table keeps the requested value; there is no per-preset override.
- `retainTokens` has no UI control yet; it is preserved when present in a row.
