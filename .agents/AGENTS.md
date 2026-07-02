# zalo-agent-cli Project Rules

## Language
- All **English text** must use **American English (US)** spelling and conventions (e.g., "color" not "colour", "organize" not "organise"). This applies to docs, READMEs, commit messages, code comments, and responses.
- Vietnamese content in bilingual artifacts is preserved and correct — do NOT remove it unless explicitly asked.

## Git Workflow

- **Always commit to `main` first**, then update the target branch to match:
  ```bash
  git checkout main
  git commit ...
  git push origin main
  git branch -f v1.1.0-beta1 main   # force the branch pointer forward
  git push origin v1.1.0-beta1 --force-with-lease
  ```
- **Exception:** If the user explicitly says to commit to a beta/feature branch only
  (e.g. "beta branch only", "don't update main"), commit only to that branch.
- Never leave `main` behind a feature branch after work is done.
- `v1.0.5` is a release snapshot — never modify it.

## Artifacts & Documentation
- Always save long-form project documentation, implementation plans, and important artifacts to the project directory, **not** the default `brain` directory.
  - **Markdown documents** (reports, plans, guides, release notes, walkthroughs) → `agent/docs/`
  - **Generated code, scripts, media files, QR codes, images** → `agent/work/`
  - **Temporary scratch scripts** → `brain/<conversation-id>/scratch/` only
- When a document covers **both** `zalo-agent-cli` and `zalo-mcp`, copy it to `agent/docs/` in both project directories.
- Use descriptive filenames when copying docs that would otherwise collide (e.g. `walkthrough_deployment.md` not just `walkthrough.md`).
- The `agent/` directory is listed in `.gitignore` — agent output stays local and is never committed.
