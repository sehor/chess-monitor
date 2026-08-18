# Project toolchain

- Frontend JavaScript/TypeScript dependencies and scripts use `pnpm`.
- Backend Python dependencies and commands use `uv` (`uv sync`, `uv add`, and `uv run`).
- Commit `pnpm-lock.yaml` and `uv.lock` when they are present.

## Verification

- Run frontend commands through `pnpm`.
- Run backend commands through `uv run`.
