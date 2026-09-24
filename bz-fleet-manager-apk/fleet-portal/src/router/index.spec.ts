import { describe, expect, it } from 'vitest'
import DriverSupplyView from '../views/DriverSupplyView.vue'
import { routes } from './index'

// No router spec file existed before Task 9 (routes are otherwise only
// exercised indirectly, e.g. AppShell.spec.ts's own synthetic route list) —
// this is the minimal, focused check the brief's own test list asks for:
// "router has the route".
describe('router routes', () => {
  it('registers driver-supply at path "supply" among the AppShell (/) children', () => {
    const appShellRoute = routes.find((r) => r.path === '/')
    const children = (appShellRoute as { children?: unknown[] } | undefined)?.children ?? []
    const supplyRoute = children.find((c) => (c as { name?: string }).name === 'driver-supply') as
      | { path: string; name: string; component: unknown }
      | undefined

    expect(supplyRoute).toBeDefined()
    expect(supplyRoute?.path).toBe('supply')
    expect(supplyRoute?.component).toBe(DriverSupplyView)
  })
})
