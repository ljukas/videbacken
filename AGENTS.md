# Videbacken — agent instructions

Project rules, commands, architecture and gotchas live in **[CLAUDE.md](./CLAUDE.md)** — read it first; it applies to every agent, not just Claude.
Process: `docs/{feature,refactor,bugfix}-workflow.md`. Architecture decisions: `docs/adr/`.

<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
