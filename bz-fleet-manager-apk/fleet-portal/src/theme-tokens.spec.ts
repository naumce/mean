import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guard: pages must use the semantic tokens (bg-surface, text-ink, border-line...)
// so dark mode flips. Static gray/white/black classes do not flip, in templates
// or in script class maps; literal hex colours in templates do not either.
// Reads source with fs; nothing is mounted.

const SRC = __dirname
const VUE_ROOTS = ['views', 'layouts', 'components', 'nightshift']
const VUE_FILES = ['App.vue']
const LIB_ROOT = 'lib'

/** Files exempt from the hex rule, each with the reason. Paths are relative to src, posix style. */
const ALLOWLIST: Record<string, string> = {
  'components/broker/BrokerGrid.vue': 'own .bb-* palette with a dark override',
}

const CLASS_RULES: Array<{ name: string; re: RegExp; vueOnly?: boolean }> = [
  { name: 'bg-white', re: /\bbg-white\b/ },
  { name: 'static gray/slate/zinc/neutral', re: /\b(bg|text|border|ring|divide|placeholder)-(gray|slate|zinc|neutral)-\d{2,3}\b/ },
  { name: 'text-black', re: /\btext-black\b/ },
  { name: 'text-primary-N (use text-brand-ink)', re: /\btext-primary-\d{2,3}\b/, vueOnly: true },
]
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/

function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full, ext)
    return name.endsWith(ext) && !name.endsWith('.spec.ts') ? [full] : []
  })
}

function isAllowed(rel: string): boolean {
  return Object.keys(ALLOWLIST).some((k) => (k.endsWith('/') ? rel.startsWith(k) : rel === k))
}

/** 0-based line indexes inside the top-level <template> block (script/style excluded). */
function templateRange(lines: string[]): [number, number] {
  const start = lines.findIndex((l) => /^<template[\s>]/.test(l))
  if (start < 0) return [0, -1]
  let end = lines.length - 1
  for (let i = lines.length - 1; i > start; i--) if (/^<\/template>/.test(lines[i])) { end = i; break }
  return [start, end]
}

function violationsFor(file: string): string[] {
  const rel = relative(SRC, file).split(sep).join('/')
  const isVue = file.endsWith('.vue')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const [from, to] = isVue ? templateRange(lines) : [0, -1]
  const out: string[] = []
  lines.forEach((line, i) => {
    // Class rules run on every line (script class maps included).
    for (const r of CLASS_RULES) if ((!r.vueOnly || isVue) && r.re.test(line)) out.push(`${rel}:${i + 1} ${r.name}`)
    // The hex rule is template-only: script legitimately holds map/canvas colours.
    if (isVue && i >= from && i <= to && !isAllowed(rel) && HEX.test(line)) out.push(`${rel}:${i + 1} literal hex colour`)
  })
  return out
}

describe('theme tokens', () => {
  it('no static white/gray/black classes or template hex colours in the app source', () => {
    const files = [
      ...VUE_ROOTS.flatMap((r) => walk(join(SRC, r), '.vue')),
      ...VUE_FILES.map((f) => join(SRC, f)),
      ...walk(join(SRC, LIB_ROOT), '.ts'),
    ]
    const found = files.flatMap(violationsFor)
    expect(found, `\n${found.length} violations:\n${found.join('\n')}\n`).toEqual([])
  })

  it('coloured text and light chips have a dark-mode pair', () => {
    const HUE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
    const textRe = new RegExp(`^(?:hover:)?text-(?:${HUE})-[3-7]00$`)
    const solidRe = new RegExp(`^bg-(?:${HUE})-[4-7]00$`)
    const chipRe = new RegExp(`^bg-(?:${HUE})-(?:50|100|200)$`)
    const strRe = /(["'`])((?:(?!\1).)*?)\1/g
    const files = [...walk(SRC, '.vue'), ...walk(SRC, '.ts')]
    const found: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file).split(sep).join('/')
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(strRe)) {
          const toks = m[2].split(/\s+/).filter(Boolean)
          const solid = toks.some((t) => solidRe.test(t))
          const darkText = toks.some((t) => t.startsWith('dark:text-'))
          const darkBg = toks.some((t) => t.startsWith('dark:bg-'))
          for (const t of toks) {
            if (textRe.test(t) && !solid && !darkText) found.push(`${rel}:${i + 1} ${t}`)
            if (chipRe.test(t) && !darkBg) found.push(`${rel}:${i + 1} ${t}`)
          }
        }
      })
    }
    expect(found, `\n${found.length} violations:\n${found.join('\n')}\n`).toEqual([])
  })
})
