# Portal-1 — Vue Shell + Auth Implementation Plan

> First frontend increment. Establishes the pattern for Portal-2/3/4. New project `fleet-portal/` (sibling of `fleet-backend/`). Vue 3 + Vite + TypeScript + Tailwind + Pinia + Vue Router + axios. TDD where it pays (stores/guards/client); build+typecheck gate for the rest.

**Goal:** a running Vue dispatcher portal with dispatcher login, a token-injecting API client, an authenticated app shell (sidebar nav + topbar), and route guards — talking to the Express API's `/api/auth/dispatcher/login` and `/api/dispatcher/overview`.

## Global Constraints
- Project root: `e:\meeting-copilot\dispatch-control-tower\fleet-portal`.
- API base URL from `import.meta.env.VITE_API_URL`, default `http://localhost:3001/api`.
- Design tokens (Tailwind theme): primary `#2563eb` (blue-600) + the app's gray scale; font Inter. Reuse the palette from `decompiled/UI-AND-LOGIC.md`.
- Commit in logical units, staged to `fleet-portal/` paths only (explicit `git add`, never `git add -A`).

## Scaffold
- `npm create vite@latest fleet-portal -- --template vue-ts` (or manual). Then `npm i pinia vue-router axios` and `npm i -D tailwindcss postcss autoprefixer @vue/test-utils vitest jsdom vue-tsc`.
- `npx tailwindcss init -p`; configure `tailwind.config.js` `content` for `./index.html` + `./src/**/*.{vue,ts}`; extend theme colors `primary:{600:'#2563eb',700:'#1d4ed8',...}` and grays; add Inter via `@import` fallback stack (no CDN — system stack `Inter, ui-sans-serif, system-ui`).
- `src/assets/main.css`: `@tailwind base; @tailwind components; @tailwind utilities;`

## Files
- `src/main.ts` — createApp, use(pinia), use(router), mount; import main.css.
- `src/lib/api.ts` — axios instance:
  - `baseURL = import.meta.env.VITE_API_URL ?? "http://localhost:3001/api"`.
  - request interceptor: read token from the auth store (or `localStorage.getItem("fleet_token")`) and set `Authorization: Bearer <token>`.
  - response interceptor: on 401, call `useAuthStore().logout()` and redirect to `/login`.
- `src/stores/auth.ts` — Pinia `useAuthStore`:
  - state `{ token: string|null, dispatcher: object|null }`, init token from `localStorage`.
  - `isAuthenticated` getter (`!!token`).
  - `login(email, password)` → `POST /auth/dispatcher/login`; store `token`+`dispatcher`; persist token to `localStorage("fleet_token")`.
  - `logout()` → clear state + localStorage.
- `src/router/index.ts` — routes: `{path:"/login", component: LoginView, meta:{public:true}}`, `{path:"/", component: AppShell, children:[{path:"", name:"dashboard", component: DashboardView}]}`. `beforeEach` guard: if route not `public` and `!isAuthenticated` → redirect `/login`; if `/login` and authenticated → redirect `/`.
- `src/layouts/AppShell.vue` — sidebar (nav links: Dashboard, Drivers, Vehicles, Trips, Approvals, Messages — the last five as disabled/placeholder `router-link`s for later increments), topbar with dispatcher name + Logout button (calls `logout()` + redirect). `<router-view/>` in the content area. Tailwind-styled, primary `#2563eb`.
- `src/views/LoginView.vue` — email/password form; on submit `await auth.login(...)`, redirect `/`; show an error message on failure. Branded (logo mark + "Fleet Dispatch").
- `src/views/DashboardView.vue` — on mount `GET /dispatcher/overview`; render the status-count tiles (or a friendly empty state if the call fails). Placeholder but real API call.

## Tests (Vitest, `environment: jsdom`)
- `src/stores/auth.spec.ts`: `login` stores token + persists to localStorage (mock `api.post`); `logout` clears both; `isAuthenticated` reflects token. On login failure the store surfaces an error and stays unauthenticated.
- `src/lib/api.spec.ts`: request interceptor attaches `Authorization: Bearer <token>` when a token exists, none when it doesn't.
- `src/router/guard.spec.ts`: navigating to a protected route while unauthenticated redirects to `/login`; while authenticated, `/login` redirects to `/`.
- Configure `vitest.config.ts` (or `vite.config.ts` test block) with `environment:'jsdom'`, `globals:true`.

## Done when
`npx vitest run` green, `npx vue-tsc --noEmit` 0 errors, `npm run build` succeeds, commits scoped to `fleet-portal/`. (Portal runs against the backend at `:3001`; a live end-to-end isn't required for this increment — the build + unit tests are the gate.)
