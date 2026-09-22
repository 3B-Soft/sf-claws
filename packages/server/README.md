# @sf-claws/server

Control plane + agent runtime. See `../../docs/ARCHITECTURE.md`.

```bash
cp .env.example .env
bun run dev          # bun --watch
bun run build && bun run start
bun run test
```
Routes are documented in `packages/shared/src/api.ts`; implementations in `src/http/routes/`.
