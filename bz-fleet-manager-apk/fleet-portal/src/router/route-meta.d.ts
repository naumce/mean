import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    // Routes without this flag (or set to false) require an authenticated
    // dispatcher — see src/router/guards.ts.
    public?: boolean
  }
}
