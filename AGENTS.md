# AGENTS.md

Bias toward caution over speed. For trivial tasks, use judgment.

## Project Direction

- Project name: `steam-bridge`.
- This is a standalone TypeScript/Node foundation for Steam desktop CDP/SharedJSContext integration.
- Current scope is Core Steam/CDP and Runtime Bridge primitives.
- Use neutral runtime naming; the default Steam global marker is `window.__steamBridge`.
- Read `CONTEXT.md` before changing architecture or public naming.

## Coding Rules

- Self-explanatory names; no abbreviations (except common ones).
- No hardcoded special cases to pass tests/symptoms; fix root cause with smallest clean change.

## Commit policy

All commits must use Conventional Commits.

- Commit messages must describe one logical change.
- Do not mix unrelated changes in one commit.
- 50/72 Rule: 50 chars title, 72 chars body line.

## Validation

Run before finishing non-trivial changes:

```sh
npm run format
npm run typecheck
npm run test
git diff --check
```

For docs-only changes, inspect diff and run `format`.
