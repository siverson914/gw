# Model preset log

Changes to the built-in agent model lists in `src/config.ts` (`DEFAULT_AGENTS`), newest first.

`scripts/model-check.ts` runs daily and raises a desktop alert when a provider's lineup changes (its own log: `~/.local/state/gw/model-check.md`). When you act on one, record it here.

## 2026-09-24

- **Claude:** `claude-opus-5` → `claude-opus-5-5`. Fable 5.1, Sonnet 5, Haiku 4.5 unchanged.
- **Codex:** added the gpt-6 line. List is now `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`. Default `gpt-5.6-terra` → `gpt-6-sol`. Dropped `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5`.
- **Grok:** unchanged (`grok-4.6`, `grok-4.5`). Checked unauthenticated, so this may be the CLI's fallback list.
- **agy:** unchanged. Not installed here; checked against public sources only.
