import { describe, expect, it } from 'vitest'
import AiExperimentView from '../views/ai/AiExperimentView.vue'
import AiLabView from '../views/ai/AiLabView.vue'
import AiRunView from '../views/ai/AiRunView.vue'
import DriverSupplyView from '../views/DriverSupplyView.vue'
import { routes } from './index'

type ChildRoute = { path: string; name: string; component: unknown; props?: boolean }

function appShellChildren(): unknown[] {
  const appShellRoute = routes.find((r) => r.path === '/')
  return (appShellRoute as { children?: unknown[] } | undefined)?.children ?? []
}

function childNamed(name: string): ChildRoute | undefined {
  return appShellChildren().find((c) => (c as { name?: string }).name === name) as ChildRoute | undefined
}

// No router spec file existed before Task 9 (routes are otherwise only
// exercised indirectly, e.g. AppShell.spec.ts's own synthetic route list) —
// this is the minimal, focused check the brief's own test list asks for:
// "router has the route".
describe('router routes', () => {
  it('registers driver-supply at path "supply" among the AppShell (/) children', () => {
    const supplyRoute = childNamed('driver-supply')

    expect(supplyRoute).toBeDefined()
    expect(supplyRoute?.path).toBe('supply')
    expect(supplyRoute?.component).toBe(DriverSupplyView)
  })

  // Qwen Harness v0.1 (Task 7): AI Lab — /ai-lab, /ai-lab/experiments/:id,
  // /ai-lab/runs/:id, the latter two with `props: true` (same convention as
  // trip-detail's `:id`) so the views read `id` as a plain prop, not via
  // `useRoute()`.
  it('registers ai-lab at path "ai-lab"', () => {
    const route = childNamed('ai-lab')
    expect(route).toBeDefined()
    expect(route?.path).toBe('ai-lab')
    expect(route?.component).toBe(AiLabView)
  })

  it('registers ai-experiment at path "ai-lab/experiments/:id" with props: true', () => {
    const route = childNamed('ai-experiment')
    expect(route).toBeDefined()
    expect(route?.path).toBe('ai-lab/experiments/:id')
    expect(route?.component).toBe(AiExperimentView)
    expect(route?.props).toBe(true)
  })

  it('registers ai-run at path "ai-lab/runs/:id" with props: true', () => {
    const route = childNamed('ai-run')
    expect(route).toBeDefined()
    expect(route?.path).toBe('ai-lab/runs/:id')
    expect(route?.component).toBe(AiRunView)
    expect(route?.props).toBe(true)
  })
})
