# @sf-claws/server

Control plane + agent runtime. See `../../docs/ARCHITECTURE.md`.

```bash
cp .env.example .env
npm run dev          # tsx watch
npm run build && npm start
npm test
```
Routes are documented in `packages/shared/src/api.ts`; implementations in `src/http/routes/`.
