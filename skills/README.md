# Agent Skills

[Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) that give an
AI coding agent the context to build on Somnia and DreamDEX. Each skill is a
folder with a `SKILL.md` (name + description + instructions).

| Skill | Use it for |
| --- | --- |
| [`somnia`](somnia) | Connecting to Somnia: chain IDs, RPCs, native SOMI gas, USDso decimals, SIWE. |
| [`dreamdex-bot`](dreamdex-bot) | Building/​debugging trading bots on DreamDEX: the core API, the order-placement gotchas, session keys, and edge measurement. |

**Using them:** point an agent (e.g. Claude Code) at this repo, or copy a skill
folder into your agent's skills directory. The `dreamdex-bot` skill references the
kit's `packages/core` API and the `docs/` for detail, so it works best alongside
the rest of the repo.
