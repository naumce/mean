<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { BoardCellPaste, BoardColumn, BoardLoad, BoardViewState, LoadLock } from '../../lib/api'
import AgentPill from '../agent/AgentPill.vue'
import AgentSwitch from '../agent/AgentSwitch.vue'
import { useSheetStore } from '../../nightshift/stores/sheet'
import { useBrokerBoardStore } from '../../stores/brokerBoard'
import { cellOf, columnId } from './boardColumns'
import { EMPTY_VIEW, fillFor, setUnmerged, type FillTarget } from './boardView'
import { boardCsv } from './csv'
import { groupKeys, groupRows, type GroupField, type GroupItem } from './grouping'
import { fromTsv, planPaste, toTsv } from './tsv'
import { useBoardTable } from './useBoardTable'
import { useGridSelection, type CellLine } from './useGridSelection'

// Their sheet, cell for cell, on a real table engine. Two <tr> per load, the
// checkbox spanning both, a sticky header, a thousand loads scrolling — and
// since slice 2B: a selection rectangle, inline editing, clipboard, fills and
// per-column merge, in the handoff's own colors.
const props = withDefaults(
  defineProps<{
    layout: BoardColumn[]
    loads: BoardLoad[]
    search?: string
    viewportHeight?: number
    showFilters?: boolean
    statusFilter?: string
    view?: BoardViewState
    /** Column ids to group by, outermost first. */
    groupBy?: string[]
    /** How many leading columns stay put while the board scrolls sideways.
     *  Their sheet pins BOL# so a dispatcher keeps their place. */
    frozen?: number
    /** `sheet` is their Excel, colour for colour — the reason this view
     *  exists. `studio` is the same grid in our own palette, for the boss's
     *  screen and for anyone who finds an orange board hard at 3am. Only the
     *  colours change; every width, rule and behaviour is identical. */
    look?: 'sheet' | 'studio'
    /** Read-only boards (a shared link, a busy save) keep every other
     *  behaviour and refuse to open an editor. */
    editable?: boolean
    /** Locks held by OTHER people, by load id: a badge on the row and no editor there. */
    locks?: Record<string, LoadLock>
  }>(),
  { search: '', viewportHeight: 0, showFilters: false, statusFilter: undefined, view: () => EMPTY_VIEW, groupBy: () => [], frozen: 1, look: 'sheet', editable: true, locks: () => ({}) },
)
const emit = defineEmits<{
  (e: 'update:selectedIds', ids: string[]): void
  (e: 'edit', write: BoardCellPaste): void
  (e: 'paste', cells: BoardCellPaste[]): void
  (e: 'view', next: BoardViewState): void
  (e: 'notice', text: string): void
  (e: 'delete-rows', ids: string[]): void
  (e: 'edit-start', loadId: string): void
  (e: 'edit-end', loadId: string): void
  /** Night Shift on the Board, Task 6: the AGENT pill was clicked. Another
   *  implementer's drawer listens for this on BrokerBoardView; this
   *  component only names the load, same as every other emit here. */
  (e: 'open-agent', loadId: string): void
}>()

// Night Shift on the Board, Task 6: the switch's own reload-on-conflict. The
// switch's POST is refused with 409 STALE_VERSION when the row moved under
// it (nightShift.ts's `setSwitch`, spec §7.4) — nothing patches this board's
// `loads` prop for a refused write (unlike a successful flip, which the
// worker's own `load_changed` frame already re-reads through the board's
// existing realtime path), so the switch's `stale` event re-requests exactly
// this row, the same "patch this id" action brokerBoard.ts's own conflict
// panel uses.
const brokerBoard = useBrokerBoardStore()
function onAgentStale(loadId: string): void {
  void brokerBoard.patchRows([loadId])
}

const t = useBoardTable(toRef(props, 'loads'), toRef(props, 'layout'))
watch(() => props.search, (s) => { t.globalFilter.value = s ?? '' }, { immediate: true })
watch(t.selectedIds, (ids) => emit('update:selectedIds', ids))
// The status filter is a distinct channel from both the search box (global
// filter, every column) and the per-column filter row (one column each) —
// TanStack's filtered row model ANDs all three together for free. 'all' (or
// unset) clears it: `equals`'s autoRemove treats undefined as "no filter".
const applyStatusFilter = () => {
  const v = props.statusFilter
  t.table.getColumn('status')?.setFilterValue(v && v !== 'all' ? v : undefined)
}
watch(() => props.statusFilter, applyStatusFilter, { immediate: true })
// Fix round 1, Finding 2 (HIGH): turning the filter row off must not leave
// the board invisibly narrowed by a filter value nobody can see or clear
// anymore. `resetColumnFilters()` clears every column filter — including
// `status`, which isn't part of the (visible) filter row at all and is
// driven by the separate status `<select>` — so re-apply it immediately
// after from the same source of truth (`props.statusFilter`) the other
// watch uses, rather than trying to carve `status` out of the reset itself.
watch(() => props.showFilters, (on) => {
  if (on) return
  t.table.resetColumnFilters()
  applyStatusFilter()
})

const rows = computed(() => {
  // `void props.loads` is load-bearing. TanStack memoizes its row models and
  // the Vue adapter feeds them a getter, so replacing the loads array updates
  // the row model on the next READ but never notified this component's render
  // effect: after an inline edit the store held "$4,000.00", `getRowModel()`
  // returned it when probed, and the cell on screen still showed the old
  // value until something else forced a re-render. Depending on the prop
  // directly is the dependency the adapter does not give us.
  void props.loads
  return t.table.getRowModel().rows
})
// NIT 9: the bulk bar has to say how much of the selection the current
// search/filters are hiding, and only the grid knows which rows survive
// them. The selection itself is deliberately NOT narrowed (a dispatcher
// built that set on purpose) — the view just labels the gap.
const visibleIds = computed(() => rows.value.map((r) => r.id))
const scroller = ref<HTMLElement | null>(null)

const isUrl = (v: string): boolean => /^https?:\/\//i.test(v)
// Review Finding 2 (MEDIUM): built via the shared columnId(c, index) — the
// same disambiguation buildColumns() uses — instead of re-deriving the id
// inline, so two `extra` columns sharing a label never collide here either.
const layoutById = computed(() => new Map(props.layout.map((c, index) => [columnId(c, index), c])))
const col = (id: string): BoardColumn => layoutById.value.get(id)!
/** Who holds the row, if it is not us (spec §7.3): the badge and the refusal. */
const lockedBy = (l: BoardLoad): string | null => props.locks?.[l.id]?.by ?? null

// Task 11 ruling: once an org has a connected sheet binding, the switch
// moves to the sheet's own Night Shift column — the AGENT column here
// becomes read-only for it. A lock still wins on the title (more specific
// and more urgent than "go edit your sheet"); the binding is only read here,
// never loaded here — whichever view mounts this grid loads it once
// (BrokerBoardView.vue, alongside its own other mount-time loads).
const sheetStore = useSheetStore()
const sheetBound = computed(() => sheetStore.binding?.status === 'connected')
const SHEET_BOUND_REASON = 'Change it in the Night Shift column of your sheet'
const agentSwitchDisabled = (l: BoardLoad): boolean => !!lockedBy(l) || sheetBound.value
const agentSwitchDisabledReason = (l: BoardLoad): string | undefined => (lockedBy(l) ? undefined : (sheetBound.value ? SHEET_BOUND_REASON : undefined))
/** The record's value for a cell whose text disagrees with it (spec §10).
 *  The text is never changed; the dot says what the record holds. */
const recordHint = (l: BoardLoad, colIdStr: string): string | null => {
  const key = col(colIdStr).key
  if (key === 'update') return l.record?.update ?? null
  if (key === 'appt') return l.record?.appt ?? null
  return null
}
const textOf = (l: BoardLoad, colIdStr: string, line: CellLine): string =>
  cellOf(line === 'top' ? l.top : l.bottom, col(colIdStr))

// --- Which columns of a load are split into two lines ----------------------
//
// Their sheet splits some columns (CUSTOMER over CARRIER, the tracking link
// over the carrier's phone) and spans the rest across both lines. The DEFAULT
// is therefore derived from the data — a column with something on the carrier
// line is split — and the board looks right the moment it loads, with nothing
// stored. `view.merges` only ever records a dispatcher's own decision, which
// then answers for that load completely (see setUnmerged).
const cols = computed(() => t.table.getVisibleLeafColumns())
const derivedUnmerged = (l: BoardLoad): string[] =>
  l.bottom === null ? [] : props.layout.map((c, i) => columnId(c, i)).filter((id) => cellOf(l.bottom, col(id)) !== '')
const unmergedFor = (l: BoardLoad): string[] => props.view.merges?.[l.id] ?? derivedUnmerged(l)
const isSplit = (l: BoardLoad, colIdStr: string): boolean => unmergedFor(l).includes(colIdStr)
const isExpanded = (l: BoardLoad): boolean => unmergedFor(l).length > 0

// --- Grouping ---------------------------------------------------------------
//
// TanStack sorts and filters; the group walk is ours, because a group row on
// this board carries the money totalled across it and a load spans two
// physical lines. The result is FLAT - group headers and loads in one list -
// which is the only shape a virtualizer can measure.
const collapsed = ref<Record<string, boolean>>({})
const groupFields = computed<GroupField[]>(() =>
  props.groupBy.flatMap((id) => {
    // CARRIER is the one groupable field that is NOT a column of its own: it
    // is the second line of CUSTOMER. Looking it up in the layout first found
    // nothing and silently dropped the grouping, so it is handled before the
    // lookup rather than inside it.
    if (id === 'carrier') return [{ id, label: 'CARRIER', read: (l: BoardLoad) => l.bottom?.customer ?? '' }]
    const c = layoutById.value.get(id)
    if (!c) return []
    return [{ id, label: c.label, read: (l: BoardLoad) => cellOf(l.top, c) }]
  }),
)
const flat = computed<GroupItem[]>(() => groupRows(rows.value.map((r) => r.original), groupFields.value, collapsed.value))
/** The loads in DISPLAY order. A selection's row index counts these, so the
 *  arrow keys step from load to load and never land on a group header. */
const loadItems = computed(() => flat.value.filter((i): i is Extract<GroupItem, { kind: 'load' }> => i.kind === 'load'))
const rowByLoadId = computed(() => new Map(rows.value.map((r) => [r.id, r])))
/** Where a load sits in the selection's coordinate space. */
const loadPosition = computed(() => new Map(loadItems.value.map((i, position) => [i.load.id, position])))
const toggleGroup = (key: string) => { collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] } }
const collapseAll = () => { collapsed.value = Object.fromEntries(groupKeys(flat.value).map((k) => [k, true])) }
const expandAll = () => { collapsed.value = {} }

// Final review finding 4 (IMPORTANT): a load is ONE <tr> when nothing is
// split and TWO when something is, so a flat height per load over-estimated a
// board of single-line loads by 2×. `unitHeight` is one <tr>.
//
// These are the ONLY row heights, and CSS is made to obey them (`--bb-line`
// below) rather than the other way round. Two reasons they are whole numbers
// and pinned rather than measured:
//
//  1. A line used to be 17.25px — Tailwind's `leading-tight` is 1.25 × 13px =
//     16.25px, plus a 1px border. Three loads out of every four therefore
//     ended on a quarter-pixel, and the browser rounded their 1px separator
//     away: the board showed a border between some loads and none between
//     others, which is exactly as confusing as it sounds.
//  2. The virtualizer was told 22/29 while the DOM rendered 17.25, so the
//     scrollbar promised half again as much board as existed.
// Measured in a browser, not guessed: the tallest thing on a line is the AGENT
// pill (16px line-height + 2px padding each side + the 1px rule), so 21 and 27
// ARE the natural heights. Setting --bb-line to the same numbers makes the
// height explicit rather than emergent, and keeps the virtualizer honest.
const LINE_PX = { tight: 21, theirs: 27 } as const
const unitHeight = computed(() => LINE_PX[t.density.value === 'tight' ? 'tight' : 'theirs'])
const rowHeight = computed(() => unitHeight.value * 2)
const sizeOfItem = (item: GroupItem | undefined): number =>
  !item ? unitHeight.value : item.kind === 'group' ? unitHeight.value : (isExpanded(item.load) ? 2 : 1) * unitHeight.value
const virtualizer = useVirtualizer(computed(() => ({
  count: flat.value.length,
  getScrollElement: () => scroller.value,
  estimateSize: (index: number) => sizeOfItem(flat.value[index]),
  overscan: 12,
  // jsdom has no layout; a caller may pin the viewport so every row renders.
  ...(props.viewportHeight ? { initialRect: { width: 1200, height: props.viewportHeight } } : {}),
})))
// ...and `estimateSize` is NOT a dependency of virtual-core's measurement
// memo, so changing density (or splitting a load) alone never re-measured:
// the virtualizer kept positioning and padding with the old cache. `measure()`
// clears the item-size cache and bumps `itemSizeCacheVersion`, which IS one.
watch(rowHeight, () => virtualizer.value.measure())
watch(() => props.view.merges, () => virtualizer.value.measure(), { deep: true })
watch([() => props.groupBy, collapsed], () => virtualizer.value.measure(), { deep: true })
// Filtering, searching or collapsing makes the board SHORTER. The scroller
// keeps its old scrollTop, which can now be past the end of the content — the
// virtualizer then has no rows in view and the board renders blank, which
// reads as "the filter deleted everything". Clamp back into range whenever the
// number of rendered items drops.
watch(() => flat.value.length, (now, before) => {
  if (now >= (before ?? 0)) return
  // Order matters and one pass is not enough: the scroller only shrinks once
  // the virtualizer has re-measured AND the padding spacers have been
  // re-rendered with the new total. Measure, then clamp on the next few
  // frames until scrollTop is back inside the content.
  virtualizer.value.measure()
  let tries = 3
  const clamp = () => {
    const el = scroller.value
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    if (el.scrollTop > max) el.scrollTop = max
    if (--tries > 0) requestAnimationFrame(clamp)
  }
  nextTick(() => requestAnimationFrame(clamp))
})
const totalSize = computed(() => virtualizer.value.getTotalSize())
// Review Finding 3, reverted on the coordinator's ruling after fix round 1:
// bypass whenever the measured viewport is zero OR the explicit
// `viewportHeight` prop is set — jsdom has no ResizeObserver and every element
// reports offsetHeight 0, so the real virtualizer measurement collapses to a
// zero-height viewport and getVirtualItems() comes back empty even though
// there are rows to show. The moment a real measurement produces even one
// item, the bypass turns back off and true virtualization engages.
const rawItems = computed(() => virtualizer.value.getVirtualItems())
const bypassVirtualizer = computed(() => props.viewportHeight > 0 || (flat.value.length > 0 && rawItems.value.length === 0))
const items = computed(() =>
  bypassVirtualizer.value
    ? flat.value.map((_, index) => ({ index, start: 0, end: 0, size: rowHeight.value, key: String(index) }))
    : rawItems.value,
)
const padTop = computed(() => (bypassVirtualizer.value || !items.value.length ? 0 : items.value[0].start))
const padBottom = computed(() => (bypassVirtualizer.value || !items.value.length ? 0 : virtualizer.value.getTotalSize() - items.value[items.value.length - 1].end))


// --- The selection rectangle ----------------------------------------------
const sel = useGridSelection(computed(() => loadItems.value.length), computed(() => cols.value.length))
// A sort, a filter or a search changes what (row, column) MEANS. Following a
// cell that may no longer be on the board is guesswork; dropping the
// selection is honest and is what a spreadsheet does on a re-sort.
watch([() => t.sorting.value, () => t.globalFilter.value, () => t.columnOrder.value, () => t.columnVisibility.value, () => props.groupBy], () => sel.clear(), { deep: true })
const loadAt = (r: number): BoardLoad | undefined => loadItems.value[r]?.load
const readCell = (r: number, c: number): string => {
  const load = loadAt(r)
  const id = cols.value[c]?.id
  return load && id ? textOf(load, id, 'top') : ''
}
const stats = computed(() => sel.stats(readCell))
const anchorLabel = computed(() => {
  const a = sel.anchor.value
  if (!a) return ''
  const load = loadAt(a.r)
  const id = cols.value[a.c]?.id
  if (!load || !id) return ''
  const name = load.bottom?.loadNo || load.top.bol || `row ${a.r + 1}`
  return `${col(id).label} · ${name}${a.line === 'bottom' ? ' (line 2)' : ''}`
})

function onCellDown(r: number, c: number, line: CellLine, ev: MouseEvent) {
  if (ev.button !== 0) return
  if (ev.shiftKey) sel.extendTo(r, c)
  else { sel.start(r, c, line); sel.dragging.value = true }
  scroller.value?.focus()
}
const onCellEnter = (r: number, c: number) => { if (sel.dragging.value) sel.extendTo(r, c) }
const endDrag = () => { sel.dragging.value = false }

// --- Inline editing --------------------------------------------------------
// Fix round 1, Finding 1 (MEDIUM): `baseVersion` means "the version this edit
// was based on" — the version whose content the dispatcher actually saw and
// typed against. That is `openEditor`'s moment, not `commitEdit`'s: `edit-start`
// fires synchronously but `loadLocks.held[loadId]` is only set once
// `acquireLoadLock` resolves, and in that gap a `load_changed` frame can patch
// this row (brokerBoard.ts's `holds()` guard sees no hold yet) and bump
// `load.version` out from under an editor that is already open. Re-reading
// `load.version` at commit time then sends the NEW version — past the
// server's stale-version check — and a colleague's concurrent change is
// silently overwritten instead of raising the conflict panel. Capturing the
// version here, once, and sending exactly that, is the fix: it makes the
// write describe the state the dispatcher actually saw.
// A4-R9: the dirty-check that decides whether to emit at all used to compare
// the draft against a FRESH read of the row's text at commit time — the same
// mistake `baseVersion` had, one line down. A `load_changed` frame can patch
// this cell while the editor sits open and untouched, and re-reading the live
// text then finds a "difference" the dispatcher never typed, raising a
// conflict for an edit that was not one. `shown` is the text the dispatcher
// was actually looking at when they started — captured once, here, next to
// `baseVersion`, for the same reason: an edit is a change THEY made, measured
// from what they were shown, not from what the row says now.
const editing = ref<{ r: number; c: number; line: CellLine; baseVersion: number; shown: string } | null>(null)
const draft = ref('')
// A template ref declared inside a v-for collects EVERY match into an array,
// so `editInput.value.focus()` threw and the editor opened without the caret
// in it. Exactly one editor exists at a time, so a function ref keeps the
// single element — and Vue calls it with null on unmount, which clears it.
const editInput = ref<HTMLInputElement | null>(null)
const bindEditor = (el: unknown) => { editInput.value = (el as HTMLInputElement | null) ?? null }
const isEditing = (r: number, c: number, line: CellLine): boolean =>
  !!editing.value && editing.value.r === r && editing.value.c === c && editing.value.line === line

async function openEditor(r: number, c: number, line: CellLine, seed?: string) {
  if (!props.editable) return
  const load = loadAt(r)
  const id = cols.value[c]?.id
  if (!load || !id) return
  // The agent's own column is its status, never a cell; the server refuses it
  // too, but a cursor that never appears says so without a round trip.
  if (col(id).key === 'agent' || col(id).key === 'profit') return
  const by = lockedBy(load)
  if (by) { emit('notice', `${by} is editing this load`); return }
  emit('edit-start', load.id)
  const shown = textOf(load, id, line)
  editing.value = { r, c, line, baseVersion: load.version, shown }
  draft.value = seed ?? shown
  await nextTick()
  editInput.value?.focus()
  if (seed === undefined) editInput.value?.select()
}

function commitEdit(move: 'down' | 'right' | null) {
  const e = editing.value
  if (!e) return
  const load = loadAt(e.r)
  const id = cols.value[e.c]?.id
  editing.value = null
  // Compared against `e.shown` — the text captured when this editor opened —
  // not a fresh read of the live row (see `editing` above). The live row can
  // have moved under an open, untouched editor; what the dispatcher changed
  // is measured from what they saw, not from what is on screen now.
  if (load && id && draft.value !== e.shown) {
    const column = col(id)
    // The version captured when this editor opened (see `editing` above),
    // not a fresh read of `load.version` here — the row may already carry a
    // newer version than the one this edit was based on.
    emit('edit', { loadId: load.id, row: e.line, key: column.key, source: column.source ?? column.label, value: draft.value, baseVersion: e.baseVersion })
  }
  if (load) emit('edit-end', load.id)
  if (move === 'down') sel.move(1, 0)
  if (move === 'right') sel.move(0, 1)
  scroller.value?.focus()
}
const cancelEdit = () => { const e = editing.value; editing.value = null; if (e) { const l = loadAt(e.r); if (l) emit('edit-end', l.id) } scroller.value?.focus() }

// --- Keyboard: movement, editing, clipboard --------------------------------
const PRINTABLE = /^[\w\d\s$.,\-/#&'()+:]$/

async function onKeydown(ev: KeyboardEvent) {
  if (editing.value) return
  const a = sel.anchor.value
  const meta = ev.ctrlKey || ev.metaKey
  if (meta && ev.key.toLowerCase() === 'a') { ev.preventDefault(); return sel.selectAll() }
  if (meta && ev.key.toLowerCase() === 'c') { ev.preventDefault(); return copyRange() }
  if (meta && ev.key.toLowerCase() === 'v') return // the paste event carries the data
  if (ev.key === 'Escape') { ev.preventDefault(); closeMenus(); return sel.clear() }
  if (!a) return
  const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
  if (step[ev.key]) {
    ev.preventDefault()
    return sel.move(step[ev.key][0], step[ev.key][1], ev.shiftKey)
  }
  if (ev.key === 'Tab') { ev.preventDefault(); return sel.move(0, ev.shiftKey ? -1 : 1) }
  if (ev.key === 'Enter' || ev.key === 'F2') { ev.preventDefault(); return openEditor(a.r, a.c, a.line) }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); return clearRange() }
  if (!meta && ev.key.length === 1 && PRINTABLE.test(ev.key)) { ev.preventDefault(); return openEditor(a.r, a.c, a.line, ev.key) }
}

/** The rectangle as TSV, read from the line each row actually shows. */
function rangeText(): string[][] {
  const s = sel.range.value
  if (!s) return []
  const out: string[][] = []
  for (let r = s.r1; r <= s.r2; r += 1) {
    const load = loadAt(r)
    if (!load) continue
    const line: string[] = []
    for (let c = s.c1; c <= s.c2; c += 1) {
      const id = cols.value[c]?.id
      line.push(id ? textOf(load, id, 'top') : '')
    }
    out.push(line)
  }
  return out
}

async function copyRange() {
  const text = toTsv(rangeText())
  if (!text) return
  try {
    await navigator.clipboard?.writeText(text)
    emit('notice', `${sel.cells.value.length} cells copied`)
  } catch {
    // A browser that refuses clipboard access (no permission, an insecure
    // origin) must not look like a copy that worked.
    emit('notice', 'This browser would not let the page copy — use Ctrl+C again after clicking the grid')
  }
}

/** Cells for a block of text laid down from the anchor. */
function pasteCellsFrom(matrix: string[][]): BoardCellPaste[] {
  const a = sel.anchor.value
  if (!a) return []
  const plan = planPaste(matrix, { r: a.r, c: a.c }, { rows: loadItems.value.length, cols: cols.value.length })
  if (plan.clipped) emit('notice', 'The board ends before that paste did — the rest was not pasted')
  return plan.targets.flatMap((tg) => {
    const load = loadAt(tg.r)
    const id = cols.value[tg.c]?.id
    if (!load || !id) return []
    const column = col(id)
    if (column.key === 'agent' || column.key === 'profit') return []
    const line: CellLine = a.line === 'bottom' && isSplit(load, id) ? 'bottom' : 'top'
    return [{ loadId: load.id, row: line, key: column.key, source: column.source ?? column.label, value: tg.value, baseVersion: load.version }]
  })
}

function onPaste(ev: ClipboardEvent) {
  if (editing.value || !props.editable) return
  const text = ev.clipboardData?.getData('text/plain') ?? ''
  if (!text) return
  ev.preventDefault()
  const cells = pasteCellsFrom(fromTsv(text))
  if (cells.length) emit('paste', cells)
}

function clearRange() {
  if (!props.editable) return
  const cells = pasteCellsFrom(rangeText().map((line) => line.map(() => '')))
  if (cells.length) emit('paste', cells)
}

// --- Fills and merge -------------------------------------------------------
const fillOf = (loadId: string, colIdStr: string, line: CellLine): string | undefined =>
  fillFor(props.view, loadId, colIdStr, line === 'top' ? 1 : 2)

/** Merge or unmerge every column in the selection, for every load in it. The
 *  button says which, read from the anchor: a dispatcher looking at a split
 *  cell expects "Merge". */
const anchorIsSplit = computed(() => {
  const a = sel.anchor.value
  const load = a ? loadAt(a.r) : null
  const id = a ? cols.value[a.c]?.id : null
  return !!load && !!id && isSplit(load, id)
})
function toggleMerge() {
  const s = sel.range.value
  if (!s) return
  const unmerge = !anchorIsSplit.value
  let next = props.view
  for (let r = s.r1; r <= s.r2; r += 1) {
    const load = loadAt(r)
    if (!load) continue
    const current = new Set(unmergedFor(load))
    for (let c = s.c1; c <= s.c2; c += 1) {
      const id = cols.value[c]?.id
      if (!id) continue
      if (unmerge) current.add(id)
      else current.delete(id)
    }
    next = setUnmerged(next, load.id, [...current])
  }
  emit('view', next)
}

function fillSelection(color: string | null, target: 'cell' | 'row' | 'col') {
  if (color) lastRowColor.value = color
  const s = sel.range.value
  if (!s) return
  // B3: `withFill` takes a `readonly FillTarget[]` — the right promise for
  // a function that never mutates its argument, and the wrong type for the
  // local this builds up. Mutable here, readonly at the boundary.
  const targets: FillTarget[] = []
  for (let r = s.r1; r <= s.r2; r += 1) {
    const load = loadAt(r)
    if (!load) continue
    if (target === 'row') { targets.push({ kind: 'row', loadId: load.id }); continue }
    for (let c = s.c1; c <= s.c2; c += 1) {
      const id = cols.value[c]?.id
      if (!id) continue
      if (target === 'col') targets.push({ kind: 'col', colId: id })
      else targets.push({ kind: 'cell', loadId: load.id, colId: id, line: 1 }, ...(isSplit(load, id) ? [{ kind: 'cell' as const, loadId: load.id, colId: id, line: 2 as const }] : []))
    }
  }
  // Imported lazily to keep the top of the file about rendering; the helper
  // is pure and immutable, so this composes with whatever the store holds.
  import('./boardView').then(({ withFill }) => emit('view', withFill(props.view, targets, color)))
}

/** What the dispatcher can see, as a file: the columns they left visible, in
 *  their order, and the rows the search and filters left — never the whole
 *  database behind them. (The .xlsx export is the server's, in their own
 *  layout; this one is the view.) */
function exportCsv(): string {
  const columns = cols.value.map((c) => ({ label: col(c.id).label }))
  const lines = loadItems.value.map(({ load }) => ({
    top: cols.value.map((c) => textOf(load, c.id, 'top')),
    bottom: isExpanded(load) ? cols.value.map((c) => (isSplit(load, c.id) ? textOf(load, c.id, 'bottom') : '')) : null,
  }))
  return boardCsv(columns, lines)
}

// --- The row's own menu -----------------------------------------------------
//
// Right-click a load: paint it, split or join the cell, copy, or delete. The
// same actions the toolbar has, at the row the cursor is on — which is where
// a dispatcher is already looking.
const rowMenu = ref<{ r: number; c: number; x: number; y: number } | null>(null)
function openRowMenu(r: number, c: number, line: CellLine, ev: MouseEvent) {
  ev.preventDefault()
  // Right-clicking outside the current selection moves it, the way a
  // spreadsheet does — acting on a row you did not point at is a surprise.
  if (!sel.isSelected(r, c)) sel.start(r, c, line)
  rowMenu.value = { r, c, x: ev.clientX, y: ev.clientY }
}
function fillFromRowMenu(color: string | null, target: 'cell' | 'row') {
  fillSelection(color, target)
  rowMenu.value = null
}
function mergeFromRowMenu() {
  toggleMerge()
  rowMenu.value = null
}
async function copyFromRowMenu() {
  await copyRange()
  rowMenu.value = null
}
function deleteFromRowMenu() {
  const s = sel.range.value
  if (!s) return
  const ids = [...new Set(Array.from({ length: s.r2 - s.r1 + 1 }, (_, i) => loadAt(s.r1 + i)?.id).filter((id): id is string => !!id))]
  rowMenu.value = null
  if (ids.length) emit('delete-rows', ids)
}

// --- The value filter popover ----------------------------------------------
//
// Excel's filter: every value in the column, how many rows hold it, and a tick
// beside each. The counts come off the FACETED row model, so they respect the
// other columns' filters and the search but not this column's own — otherwise
// unticking a value would make it vanish from the list that unticked it.
const filterMenu = ref<{ ci: number; x: number; y: number } | null>(null)
const filterSearch = ref('')
function openFilterMenu(ci: number, ev: MouseEvent) {
  ev.stopPropagation()
  filterSearch.value = ''
  filterMenu.value = filterMenu.value?.ci === ci ? null : { ci, x: ev.clientX, y: ev.clientY }
}
const filterColumn = computed(() => (filterMenu.value ? cols.value[filterMenu.value.ci] : null))
const filterValues = computed<Array<{ value: string; count: number; on: boolean }>>(() => {
  const column = filterColumn.value
  if (!column) return []
  const c = col(column.id)
  const counts = new Map<string, number>()
  for (const row of column.getFacetedRowModel().rows) {
    const text = cellOf(row.original.top, c)
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  const chosen = column.getFilterValue()
  const on = (v: string) => (Array.isArray(chosen) ? (chosen as string[]).includes(v) : true)
  const needle = filterSearch.value.trim().toLowerCase()
  return [...counts.entries()]
    .filter(([value]) => needle === '' || value.toLowerCase().includes(needle))
    .sort((a, b) => a[0].localeCompare(b[0], 'en-US', { numeric: true }))
    .map(([value, count]) => ({ value, count, on: on(value) }))
})
const allFilterValuesOn = computed(() => filterValues.value.every((v) => v.on))
function toggleFilterValue(value: string) {
  const column = filterColumn.value
  if (!column) return
  const current = column.getFilterValue()
  const base = Array.isArray(current) ? [...(current as string[])] : filterValues.value.map((v) => v.value)
  const next = base.includes(value) ? base.filter((v) => v !== value) : [...base, value]
  // Everything ticked is the same as no filter at all — storing it as one
  // would leave a filter pill on a board that is not narrowed.
  column.setFilterValue(next.length === filterValues.value.length ? undefined : next)
}
function toggleAllFilterValues() {
  const column = filterColumn.value
  if (!column) return
  column.setFilterValue(allFilterValuesOn.value ? [] : undefined)
}
const clearColumnFilter = () => { filterColumn.value?.setFilterValue(undefined); filterMenu.value = null }
/** How many columns are narrowing the board right now — the toolbar pill. */
const activeFilters = computed(() => t.table.getState().columnFilters.filter((f) => f.id !== 'status').length)
const clearAllFilters = () => {
  for (const f of t.table.getState().columnFilters) if (f.id !== 'status') t.table.getColumn(f.id)?.setFilterValue(undefined)
}

// --- The header's own menu --------------------------------------------------
//
// Right-click a header: freeze up to here, hide it, paint the column. The
// handoff puts these on the header rather than in a settings panel because
// they are about the column under the cursor.
const headerMenu = ref<{ ci: number; x: number; y: number } | null>(null)
function openHeaderMenu(ci: number, ev: MouseEvent) {
  ev.preventDefault()
  headerMenu.value = { ci, x: ev.clientX, y: ev.clientY }
}
const closeMenus = () => { headerMenu.value = null; filterMenu.value = null; rowMenu.value = null }
function freezeUpTo(ci: number) {
  frozenOverride.value = ci + 1
  closeMenus()
}
function unfreezeAll() {
  frozenOverride.value = 0
  closeMenus()
}
function hideFromMenu(ci: number) {
  const id = cols.value[ci]?.id
  if (id) toggleColumn(id)
  closeMenus()
}
function fillColumnFromMenu(ci: number, color: string | null) {
  const id = cols.value[ci]?.id
  if (!id) return
  import('./boardView').then(({ withFill }) => emit('view', withFill(props.view, [{ kind: 'col', colId: id }], color)))
  closeMenus()
}

// --- Checkboxes (slice 2A) --------------------------------------------------
let checkAnchor: string | null = null
function onCheckClick(id: string, ev: MouseEvent) {
  const visible = rows.value.map((r) => r.id)
  if (ev.shiftKey && checkAnchor && visible.includes(checkAnchor)) {
    ev.preventDefault()
    const [a, b] = [visible.indexOf(checkAnchor), visible.indexOf(id)].sort((x, y) => x - y)
    const next = { ...t.rowSelection.value }
    for (const vid of visible.slice(a, b + 1)) next[vid] = true
    t.rowSelection.value = next
  }
  checkAnchor = id
}
function onCheckChange(id: string, ev: Event) {
  t.rowSelection.value = { ...t.rowSelection.value, [id]: (ev.target as HTMLInputElement).checked }
}
const allChecked = computed(() => t.table.getIsAllRowsSelected())
const someChecked = computed(() => t.table.getIsSomeRowsSelected())
const toggleAll = () => t.table.toggleAllRowsSelected(!allChecked.value)

// --- Column tools (slice 2A) ------------------------------------------------
const currentOrderIds = () => t.table.getAllLeafColumns().map((c) => c.id).filter((id) => id !== 'status')
function toggleColumn(id: string) {
  if (id === 'status') return
  const visible = t.table.getColumn(id)?.getIsVisible() ?? true
  if (visible) t.table.getColumn(id)?.setFilterValue(undefined)
  t.columnVisibility.value = { ...t.columnVisibility.value, [id]: !visible }
}
function moveColumn(id: string, dir: -1 | 1) {
  if (id === 'status') return
  const ids = currentOrderIds()
  const from = ids.indexOf(id)
  const to = from + dir
  if (from < 0 || to < 0 || to >= ids.length) return
  const next = [...ids]
  ;[next[from], next[to]] = [next[to], next[from]]
  t.columnOrder.value = next
}
const columnsForTools = computed(() =>
  t.table.getAllLeafColumns()
    .filter((c) => c.id !== 'status')
    .map((c) => ({ id: c.id, label: col(c.id).label, visible: c.getIsVisible() })),
)
const dragId = ref<string | null>(null)
function dropOn(targetId: string) {
  const id = dragId.value
  dragId.value = null
  if (!id || id === targetId) return
  const ids = currentOrderIds()
  const from = ids.indexOf(id)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0) return
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  t.columnOrder.value = next
}

// --- Styling ---------------------------------------------------------------
const money = (v: string): boolean => /^-?\$/.test(v)
const cellStyle = (l: BoardLoad, colIdStr: string, line: CellLine): Record<string, string> => {
  const c = col(colIdStr)
  const fill = fillOf(l.id, colIdStr, line)
  // EVERY cell paints its own background, not just the special ones. A
  // `position: sticky` cell is promoted out of the row's paint order, so a
  // transparent one lets all sixteen columns scroll visibly through the
  // column a dispatcher pinned (final review finding 5, slice 2A) — and the
  // row's own background does not travel with it. One rule here is cheaper
  // than remembering which columns are sticky today.
  const style: Record<string, string> = { background: 'var(--bb-row)' }
  if (fill) style.background = fill
  else if (c.key === 'customer' && line === 'top' && textOf(l, colIdStr, line)) style.background = 'var(--bb-customer)'
  else if (c.key === 'appt') style.background = 'var(--bb-appt)'
  if (c.key === 'profit') style.color = money(textOf(l, colIdStr, line)) && textOf(l, colIdStr, line).startsWith('-') ? 'var(--bb-negative)' : 'var(--bb-profit)'
  return style
}
const cellPad = computed(() => (t.density.value === 'tight' ? 'px-2 py-0' : 'px-2 py-[3px]'))
/** Narrowings for the template: `flat` holds two shapes and Vue's template
 *  compiler cannot discriminate a union inside an expression. */
type GroupRow = Extract<GroupItem, { kind: 'group' }>
type LoadRow = Extract<GroupItem, { kind: 'load' }>
/** A load's position in the selection's coordinate space (group rows are not
 *  in it), and whether its checkbox is ticked — both read through the
 *  TanStack row, which still owns selection. */
const posOf = (loadId: string): number => loadPosition.value.get(loadId) ?? 0
const isChecked = (loadId: string): boolean => rowByLoadId.value.get(loadId)?.getIsSelected() ?? false
const dollars = (n: number): string => '$' + Math.round(n).toLocaleString('en-US')
/** The last color painted from a menu, so "Fill row(s)" means the color they
 *  just used rather than an arbitrary default. */
const lastRowColor = ref('#fff3b0')

// --- Frozen columns ---------------------------------------------------------
//
// `position: sticky` needs an explicit `left`, and the offset is the gutter
// plus every frozen column before this one — computed from the LIVE widths so
// resizing a frozen column moves the ones pinned after it instead of leaving a
// gap or an overlap.
const GUTTER_PX = 48
/** The prop is the starting point; the header menu's choice wins for the rest
 *  of the session. */
const frozenOverride = ref<number | null>(null)
const frozenCount = computed(() => Math.max(0, Math.min(frozenOverride.value ?? props.frozen, cols.value.length)))
const frozenLeft = computed<number[]>(() => {
  const out: number[] = []
  let x = GUTTER_PX
  for (let i = 0; i < frozenCount.value; i += 1) {
    out.push(x)
    x += cols.value[i]?.getSize() ?? 0
  }
  return out
})
const isFrozen = (ci: number): boolean => ci < frozenCount.value
/** The last frozen column carries the edge shadow, so the seam between what
 *  is pinned and what is scrolling is visible rather than guessed at. */
const frozenStyle = (ci: number): Record<string, string> =>
  isFrozen(ci) ? { left: frozenLeft.value[ci] + 'px', ...(ci === frozenCount.value - 1 ? { boxShadow: '2px 0 0 #b8763d' } : {}) } : {}
const MONO: ReadonlySet<string> = new Set(['bol', 'puZip', 'delZip', 'rate', 'soldRate', 'profit', 'mc', 'loadNo', 'shipDate'])

defineExpose({
  visibleIds,
  totalSize,
  hideColumn: t.hideColumn,
  resetColumns: t.resetColumns,
  setDensity: t.setDensity,
  density: t.density,
  table: t.table,
  clearSelection: t.clearSelection,
  toggleColumn,
  moveColumn,
  columnsForTools,
  // Slice 2B, for the toolbar above the grid.
  selection: sel,
  stats,
  anchorIsSplit,
  toggleMerge,
  fillSelection,
  copyRange,
  clearRange,
  openRowMenu,
  toggleGroup,
  collapseAll,
  expandAll,
  frozenCount,
  exportCsv,
  activeFilters,
  clearAllFilters,
  freezeUpTo,
  unfreezeAll,
  cancelEdit,
})
</script>

<template>
  <div class="bb-shell flex min-h-0 w-full min-w-0 flex-col" :data-look="props.look" :data-density="t.density.value">
    <div
      ref="scroller"
      tabindex="0"
      class="bb-grid relative max-h-[min(70vh,calc(100vh-300px))] min-h-[280px] flex-1 overflow-auto rounded-lg border border-line outline-none"
      data-grid-scroller
      @keydown="onKeydown"
      @mousedown="closeMenus()"
      @paste="onPaste"
      @mouseup="endDrag"
      @mouseleave="endDrag"
    >
      <table class="w-max min-w-full table-fixed border-separate border-spacing-0 text-[13px]" data-broker-grid :style="{ width: t.table.getTotalSize() + 48 + 'px' }">
        <thead class="sticky top-0 z-20">
          <tr>
            <th class="bb-head bb-gutter-head sticky left-0 z-30 w-12 px-2 text-center">
              <input type="checkbox" :checked="allChecked" :indeterminate.prop="!allChecked && someChecked" aria-label="Select all loads" @change="toggleAll" />
            </th>
            <th v-for="(header, hi) in t.table.getHeaderGroups()[0].headers" :key="header.id" :style="[{ width: header.getSize() + 'px' }, frozenStyle(hi)]"
                :aria-sort="header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : 'none'"
                class="bb-head relative px-2 text-[11.5px] font-semibold uppercase tracking-[0.06em]"
                :class="isFrozen(hi) ? 'sticky z-30' : ''"
                draggable="true" @dragstart="dragId = header.column.id" @dragover.prevent @drop="dropOn(header.column.id)"
                @contextmenu="openHeaderMenu(hi, $event)">
              <div class="flex h-[38px] items-center gap-1">
                <button type="button" class="flex min-w-0 flex-1 items-center justify-center gap-1"
                        :title="col(header.column.id).label + ' — click to sort, shift-click to add to the sort'"
                        @click="header.column.getToggleSortingHandler()?.($event)">
                  <span class="truncate">{{ col(header.column.id).label }}</span>
                  <span v-if="header.column.getIsSorted()" class="bb-sort shrink-0 font-mono text-[10px]">{{ header.column.getIsSorted() === 'asc' ? '↑' : '↓' }}<template v-if="t.sorting.value.length > 1">{{ header.column.getSortIndex() + 1 }}</template></span>
                </button>
                <button v-if="header.column.id !== 'agent'" type="button" class="bb-funnel grid h-5 w-5 shrink-0 place-items-center rounded"
                        :class="header.column.getIsFiltered() ? 'bb-filter-on' : ''"
                        :data-filter-button="header.column.id" :aria-label="'Filter ' + col(header.column.id).label"
                        @click.stop="openFilterMenu(hi, $event)">
                  <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true" fill="currentColor"><path d="M1 2h10L7 6.5V11L5 9.5V6.5z" /></svg>
                </button>
              </div>
              <span class="bb-resize absolute right-0 top-0 h-full w-[7px] cursor-col-resize select-none" @mousedown="header.getResizeHandler()($event)" @touchstart="header.getResizeHandler()($event)" aria-hidden="true"></span>
            </th>
          </tr>
          <tr v-if="props.showFilters" data-filters>
            <th class="bb-head bb-gutter-head sticky left-0 z-30 w-12 px-2"></th>
            <th v-for="(header, hi) in t.table.getHeaderGroups()[0].headers" :key="'filter-' + header.id"
                class="bb-head bb-filter-cell px-1 py-1 font-normal normal-case tracking-normal"
                :class="isFrozen(hi) ? 'sticky z-30' : ''" :style="[{ width: header.getSize() + 'px' }, frozenStyle(hi)]">
              <input v-if="header.column.id !== 'agent'" type="text" :data-filter="header.column.id" :value="(header.column.getFilterValue() as string | undefined) ?? ''"
                     :placeholder="'Filter ' + col(header.column.id).label" :aria-label="'Filter ' + col(header.column.id).label"
                     class="bb-filter-input w-full rounded px-1.5 py-0.5 text-xs font-normal"
                     @input="header.column.setFilterValue(($event.target as HTMLInputElement).value || undefined)" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="padTop > 0" aria-hidden="true"><td :colspan="cols.length + 1" :style="{ height: padTop + 'px' }" class="border-0 p-0"></td></tr>
          <template v-for="item in items" :key="item.index">
            <!-- A group header: the field, the value, how many loads, and what
                 they add up to. It spans the whole board because the numbers
                 on it are about the group, not about any column. -->
            <tr v-if="flat[item.index]?.kind === 'group'" :key="'g' + item.index" class="bb-group" :class="'bb-group-l' + Math.min((flat[item.index] as GroupRow).level, 2)" :data-group="(flat[item.index] as GroupRow).key" :data-level="(flat[item.index] as GroupRow).level">
              <td :colspan="cols.length + 1" class="bb-group-cell" :style="{ paddingLeft: (8 + (flat[item.index] as GroupRow).level * 20) + 'px' }">
                <button type="button" class="bb-group-inner flex items-center gap-2 py-[3px] pr-3 text-left" @click="toggleGroup((flat[item.index] as GroupRow).key)">
                  <span class="bb-caret grid h-4 w-4 shrink-0 place-items-center rounded text-[9px]" aria-hidden="true">{{ (flat[item.index] as GroupRow).collapsed ? '▶' : '▼' }}</span>
                  <span class="bb-group-field shrink-0 text-[10px] uppercase tracking-[0.08em]">{{ (flat[item.index] as GroupRow).label }}</span>
                  <span class="bb-group-value truncate font-semibold">{{ (flat[item.index] as GroupRow).value }}</span>
                  <span class="bb-chip shrink-0">{{ (flat[item.index] as GroupRow).count }} {{ (flat[item.index] as GroupRow).count === 1 ? 'load' : 'loads' }}</span>
                  <span class="bb-totals shrink-0 font-mono text-[11.5px]" data-totals>
                    <span class="bb-total-k">Rate</span> {{ dollars((flat[item.index] as GroupRow).totals.rate) }}
                    <span class="bb-total-k">Sold</span> {{ dollars((flat[item.index] as GroupRow).totals.sold) }}
                    <span class="bb-total-k">Profit</span> <span class="bb-total-profit">{{ dollars((flat[item.index] as GroupRow).totals.profit) }}</span>
                  </span>
                </button>
              </td>
            </tr>
            <template v-else-if="flat[item.index]">
              <tr :data-load="(flat[item.index] as LoadRow).load.id" data-row="top" class="bb-row"
                  :class="[(flat[item.index] as LoadRow).load.status === 'archived' ? 'opacity-60' : '', isChecked((flat[item.index] as LoadRow).load.id) ? 'bb-checked' : '']"
                  :data-selected="isChecked((flat[item.index] as LoadRow).load.id) || undefined"
                  :data-locked="lockedBy((flat[item.index] as LoadRow).load) || undefined">
                <td :rowspan="isExpanded((flat[item.index] as LoadRow).load) ? 2 : undefined" class="bb-gutter sticky left-0 z-10 px-2 text-center align-middle">
                  <input type="checkbox" :checked="isChecked((flat[item.index] as LoadRow).load.id)" :aria-label="'Select load ' + ((flat[item.index] as LoadRow).load.bottom?.loadNo || (flat[item.index] as LoadRow).load.top.bol || '')" @click="onCheckClick((flat[item.index] as LoadRow).load.id, $event)" @change="onCheckChange((flat[item.index] as LoadRow).load.id, $event)" />
                  <span v-if="lockedBy((flat[item.index] as LoadRow).load)" data-lock-badge class="bb-lock" :title="lockedBy((flat[item.index] as LoadRow).load) + ' is editing this load'" aria-label="being edited by someone else">✎</span>
                </td>
                <td v-for="(column, ci) in cols" :key="column.id" :data-col="column.id" data-line="top"
                    :rowspan="isExpanded((flat[item.index] as LoadRow).load) && !isSplit((flat[item.index] as LoadRow).load, column.id) ? 2 : undefined"
                    :style="[{ width: column.getSize() + 'px' }, cellStyle((flat[item.index] as LoadRow).load, column.id, 'top'), frozenStyle(ci)]"
                    class="bb-cell whitespace-nowrap align-middle"
                    :class="[cellPad, MONO.has(col(column.id).key) ? 'bb-mono' : '', isFrozen(ci) ? 'sticky z-10' : '',
                             sel.isSelected(posOf((flat[item.index] as LoadRow).load.id), ci) ? 'bb-sel' : '', sel.isAnchor(posOf((flat[item.index] as LoadRow).load.id), ci, 'top') ? 'bb-anchor' : '']"
                    :data-frozen="isFrozen(ci) || undefined"
                    @mousedown="onCellDown(posOf((flat[item.index] as LoadRow).load.id), ci, 'top', $event)"
                    @contextmenu="openRowMenu(posOf((flat[item.index] as LoadRow).load.id), ci, 'top', $event)"
                    @mouseenter="onCellEnter(posOf((flat[item.index] as LoadRow).load.id), ci)"
                    @dblclick="openEditor(posOf((flat[item.index] as LoadRow).load.id), ci, 'top')">
                  <input v-if="isEditing(posOf((flat[item.index] as LoadRow).load.id), ci, 'top')" :ref="bindEditor" v-model="draft" data-cell-editor
                         class="bb-editor w-full" @keydown.enter.prevent="commitEdit('down')" @keydown.tab.prevent="commitEdit('right')"
                         @keydown.esc.prevent="cancelEdit()" @blur="commitEdit(null)" />
                  <template v-else-if="col(column.id).key === 'agent'">
                    <span data-pill :title="(flat[item.index] as LoadRow).load.pill.text ?? undefined" class="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold" :class="(flat[item.index] as LoadRow).load.pill.state === 'attention' ? 'border border-red-500 text-red-600' : 'text-ink-3'">{{ (flat[item.index] as LoadRow).load.pill.state === 'attention' ? 'Attention' : '—' }}</span>
                    <span class="ml-1 inline-flex items-center gap-1" @mousedown.stop @dblclick.stop>
                      <AgentPill
                        :pill="(flat[item.index] as LoadRow).load.agentPill"
                        :line="(flat[item.index] as LoadRow).load.agentLine?.text ?? null"
                        :load-id="(flat[item.index] as LoadRow).load.id"
                        @open-agent="emit('open-agent', $event)"
                      />
                      <AgentSwitch
                        :load="(flat[item.index] as LoadRow).load"
                        :disabled="agentSwitchDisabled((flat[item.index] as LoadRow).load)"
                        :disabled-reason="agentSwitchDisabledReason((flat[item.index] as LoadRow).load)"
                        @stale="onAgentStale((flat[item.index] as LoadRow).load.id)"
                      />
                    </span>
                  </template>
                  <template v-else-if="col(column.id).key === 'update'">
                    <span class="block truncate">{{ textOf((flat[item.index] as LoadRow).load, column.id, 'top') }}</span>
                    <!-- spec §6.2: the agent's latest line, in their own wording, under the
                         human's UPDATE text, greyed and marked as the agent's — never the
                         human's cell rewritten. -->
                    <span
                      v-if="(flat[item.index] as LoadRow).load.agentLine"
                      data-agent-line
                      class="mt-0.5 flex items-center gap-1 truncate text-[10px] text-ink-3"
                      :title="(flat[item.index] as LoadRow).load.agentLine!.text"
                    ><span aria-hidden="true">🤖</span>{{ (flat[item.index] as LoadRow).load.agentLine!.text }}</span>
                  </template>
                  <a v-else-if="isUrl(textOf((flat[item.index] as LoadRow).load, column.id, 'top'))" :href="textOf((flat[item.index] as LoadRow).load, column.id, 'top')" target="_blank" rel="noopener" class="bb-link">{{ textOf((flat[item.index] as LoadRow).load, column.id, 'top').replace(/^https?:\/\//, '').slice(0, 42) }}…</a>
                  <template v-else>{{ textOf((flat[item.index] as LoadRow).load, column.id, 'top') }}</template>
                  <span v-if="recordHint((flat[item.index] as LoadRow).load, column.id)" data-record class="bb-record" :title="'record says ' + recordHint((flat[item.index] as LoadRow).load, column.id)" aria-label="differs from the record"></span>
                </td>
              </tr>
              <tr v-if="isExpanded((flat[item.index] as LoadRow).load)" :data-load="(flat[item.index] as LoadRow).load.id" data-row="bottom" class="bb-row"
                  :class="[(flat[item.index] as LoadRow).load.status === 'archived' ? 'opacity-60' : '', isChecked((flat[item.index] as LoadRow).load.id) ? 'bb-checked' : '']"
                  :data-selected="isChecked((flat[item.index] as LoadRow).load.id) || undefined"
                  :data-locked="lockedBy((flat[item.index] as LoadRow).load) || undefined">
                <template v-for="(column, ci) in cols" :key="column.id">
                  <td v-if="isSplit((flat[item.index] as LoadRow).load, column.id)" :data-col="column.id" data-line="bottom"
                      :style="[{ width: column.getSize() + 'px' }, cellStyle((flat[item.index] as LoadRow).load, column.id, 'bottom'), frozenStyle(ci)]"
                      class="bb-cell whitespace-nowrap align-middle"
                      :class="[cellPad, MONO.has(col(column.id).key) ? 'bb-mono' : '', isFrozen(ci) ? 'sticky z-10' : '',
                               sel.isSelected(posOf((flat[item.index] as LoadRow).load.id), ci) ? 'bb-sel' : '', sel.isAnchor(posOf((flat[item.index] as LoadRow).load.id), ci, 'bottom') ? 'bb-anchor' : '']"
                      :data-frozen="isFrozen(ci) || undefined"
                      @mousedown="onCellDown(posOf((flat[item.index] as LoadRow).load.id), ci, 'bottom', $event)"
                      @contextmenu="openRowMenu(posOf((flat[item.index] as LoadRow).load.id), ci, 'bottom', $event)"
                      @mouseenter="onCellEnter(posOf((flat[item.index] as LoadRow).load.id), ci)"
                      @dblclick="openEditor(posOf((flat[item.index] as LoadRow).load.id), ci, 'bottom')">
                    <input v-if="isEditing(posOf((flat[item.index] as LoadRow).load.id), ci, 'bottom')" :ref="bindEditor" v-model="draft" data-cell-editor
                           class="bb-editor w-full" @keydown.enter.prevent="commitEdit('down')" @keydown.tab.prevent="commitEdit('right')"
                           @keydown.esc.prevent="cancelEdit()" @blur="commitEdit(null)" />
                    <template v-else>{{ textOf((flat[item.index] as LoadRow).load, column.id, 'bottom') }}</template>
                  </td>
                </template>
              </tr>
            </template>
          </template>
          <tr v-if="padBottom > 0" aria-hidden="true"><td :colspan="cols.length + 1" :style="{ height: padBottom + 'px' }" class="border-0 p-0"></td></tr>
        </tbody>
      </table>
      <p v-if="rows.length === 0" class="p-6 text-center text-sm text-ink-2">No loads match.</p>
    </div>
    <!-- The row's context menu. -->
    <div v-if="rowMenu" data-row-menu class="fixed z-50 w-52 rounded-lg border border-line bg-surface py-1 text-sm shadow-xl"
         :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }">
      <div class="flex flex-wrap gap-1 px-3 py-1">
        <button v-for="c in ['#fff3b0', '#cfe3ff', '#cdf2c8', '#ffc9c9', '#e4d4ff', '#e5e7eb']" :key="c" type="button" :data-row-swatch="c"
                class="h-5 w-5 rounded border border-line" :style="{ background: c }" :aria-label="'Fill ' + c" @click="fillFromRowMenu(c, 'cell')"></button>
      </div>
      <button type="button" data-row-fill class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="fillFromRowMenu(lastRowColor, 'row')">Fill row(s)</button>
      <button type="button" data-row-clear-fill class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="fillFromRowMenu(null, 'cell')">Clear fill</button>
      <div class="my-1 border-t border-line"></div>
      <button type="button" data-row-merge class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="mergeFromRowMenu()">{{ anchorIsSplit ? 'Merge' : 'Unmerge' }}</button>
      <button type="button" data-row-copy class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="copyFromRowMenu()">Copy</button>
      <div class="my-1 border-t border-line"></div>
      <button type="button" data-row-delete class="block w-full px-3 py-1 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" @click="deleteFromRowMenu()">Delete row(s)</button>
    </div>

    <!-- The column's value filter: search, (Select all), the values with their
         counts, and the two ways out. -->
    <div v-if="filterMenu" data-filter-menu class="fixed z-50 w-64 rounded-lg border border-line bg-surface p-2 text-sm shadow-xl"
         :style="{ left: filterMenu.x + 'px', top: filterMenu.y + 'px' }">
      <input v-model="filterSearch" type="search" data-filter-search placeholder="Search values…" aria-label="Search values"
             class="mb-2 w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink" />
      <label class="flex items-center gap-2 border-b border-line px-1 pb-1 font-semibold">
        <input type="checkbox" data-filter-all :checked="allFilterValuesOn" @change="toggleAllFilterValues" />(Select all)
      </label>
      <div class="max-h-56 overflow-auto py-1">
        <label v-for="v in filterValues" :key="v.value" class="flex items-center gap-2 px-1 py-0.5" :data-filter-value="v.value">
          <input type="checkbox" :checked="v.on" @change="toggleFilterValue(v.value)" />
          <span class="truncate">{{ v.value === '' ? '(blank)' : v.value }}</span>
          <span class="ml-auto font-mono text-[11px] text-ink-3">{{ v.count }}</span>
        </label>
        <p v-if="filterValues.length === 0" class="px-1 py-2 text-ink-3">Nothing matches that.</p>
      </div>
      <div class="flex gap-2 border-t border-line pt-2">
        <button type="button" data-filter-clear class="flex-1 rounded border border-line px-2 py-1 text-ink-2" @click="clearColumnFilter">Clear</button>
        <button type="button" data-filter-done class="flex-1 rounded bg-brand px-2 py-1 font-semibold text-brand-ink" @click="filterMenu = null">Done</button>
      </div>
    </div>

    <!-- The header's context menu. Fixed to the pointer, closed by any click
         elsewhere or by Escape. -->
    <div v-if="headerMenu" data-header-menu class="fixed z-50 w-52 rounded-lg border border-line bg-surface py-1 text-sm shadow-xl"
         :style="{ left: headerMenu.x + 'px', top: headerMenu.y + 'px' }">
      <button type="button" data-freeze class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="freezeUpTo(headerMenu.ci)">Freeze up to this column</button>
      <button type="button" data-unfreeze class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="unfreezeAll()">Unfreeze all</button>
      <button type="button" data-hide-col class="block w-full px-3 py-1 text-left hover:bg-surface-2" @click="hideFromMenu(headerMenu.ci)">Hide this column</button>
      <div class="my-1 border-t border-line"></div>
      <div class="flex flex-wrap gap-1 px-3 py-1">
        <button v-for="c in ['#fff3b0', '#cfe3ff', '#cdf2c8', '#ffc9c9', '#e4d4ff', '#e5e7eb']" :key="c" type="button" :data-col-swatch="c"
                class="h-5 w-5 rounded border border-line" :style="{ background: c }" :aria-label="'Fill column ' + c" @click="fillColumnFromMenu(headerMenu.ci, c)"></button>
      </div>
      <button type="button" data-clear-col class="block w-full px-3 py-1 text-left text-ink-2 hover:bg-surface-2" @click="fillColumnFromMenu(headerMenu.ci, null)">Clear column fill</button>
    </div>

    <!-- Status bar: what is selected, and what it adds up to. -->
    <div class="bb-status flex items-center gap-4 px-3 py-1 font-mono text-[11.5px] text-ink-2" data-status-bar>
      <span v-if="anchorLabel">{{ anchorLabel }}</span>
      <span v-if="stats.cells > 1">{{ stats.cells }} cells<template v-if="stats.numeric"> · Sum {{ stats.sum.toLocaleString('en-US') }} · Avg {{ (stats.avg ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) }}</template></span>
      <span class="ml-auto hidden sm:inline">Enter edit · Tab next · Ctrl+C copy · Ctrl+V paste · Del clear</span>
    </div>
  </div>
</template>

<style scoped>
.bb-grid { background: var(--bb-row-alt); scrollbar-width: thin; }
.bb-grid::-webkit-scrollbar { height: 10px; width: 10px; }
.bb-grid::-webkit-scrollbar-thumb { background: color-mix(in oklab, var(--bb-head) 45%, transparent); border-radius: 99px; }

/* --- header ------------------------------------------------------------- */
.bb-head {
  background: linear-gradient(180deg, var(--bb-head-2), var(--bb-head));
  color: var(--bb-head-ink);
  border-bottom: 1px solid #000;
  border-right: 1px solid var(--bb-head-line);
  vertical-align: middle;
}
.bb-gutter-head { background: var(--bb-head); }
.bb-sort { color: var(--bb-row); }
.bb-funnel { color: color-mix(in oklab, var(--bb-head-ink) 55%, transparent); transition: background .12s, color .12s; }
.bb-funnel:hover { background: rgba(255, 255, 255, .12); color: var(--bb-head-ink); }
.bb-filter-on { background: var(--bb-row); color: var(--bb-head); }
.bb-resize { border-right: 2px solid transparent; }
.bb-resize:hover { border-right-color: var(--bb-row); }
.bb-filter-cell { background: var(--bb-head-2); border-top: 1px solid var(--bb-head-line); }
.bb-filter-input {
  background: rgba(255, 255, 255, .06);
  border: 1px solid var(--bb-head-line);
  color: var(--bb-head-ink);
}
.bb-filter-input::placeholder { color: color-mix(in oklab, var(--bb-head-ink) 45%, transparent); }
.bb-filter-input:focus { outline: none; border-color: var(--bb-row); background: rgba(255, 255, 255, .1); }

/* --- rows --------------------------------------------------------------- */
.bb-row { background: var(--bb-row); color: var(--bb-ink); }
.bb-row:hover .bb-cell { filter: brightness(0.975); }
.bb-gutter { background: var(--bb-row); border-right: 1px solid var(--bb-gridline); }
.bb-checked .bb-gutter { background: var(--bb-accent); }
.bb-lock { margin-left: 3px; font-size: 10px; line-height: 1; color: var(--bb-accent); }
.bb-row[data-locked] .bb-cell { color: color-mix(in oklab, currentColor 70%, transparent); }
/* One physical line is exactly `--bb-line` tall, border included (border-box),
   so every row boundary lands on a whole pixel and every separator survives
   rounding. Keep these in step with LINE_PX in the script above. */
.bb-shell[data-density='tight'] { --bb-line: 21px; }
.bb-shell[data-density='theirs'] { --bb-line: 27px; }
.bb-cell, .bb-gutter, .bb-group-cell { height: var(--bb-line); line-height: 16px; }
.bb-cell {
  border-right: 1px solid var(--bb-gridline);
  border-bottom: 1px solid var(--bb-gridline);
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.bb-mono { font-family: 'Source Code Pro', ui-monospace, SFMono-Regular, monospace; font-variant-numeric: tabular-nums; }
.bb-link { color: var(--bb-link); text-decoration: underline; text-underline-offset: 2px; }
/* The pinned column paints in its own layer, so it carries the seam itself —
   otherwise the columns sliding under it have no visible edge to slide under. */
.bb-cell[data-frozen] { box-shadow: 2px 0 0 var(--bb-edge); }
/* The mark: a dot in the cell's corner whose title is what the record holds.
   Positioned against the cell — `:not([data-frozen])` because the scoped
   selector would out-rank Tailwind's `.sticky` on a frozen cell, and sticky
   positions too. */
.bb-cell:not([data-frozen]) { position: relative; }
.bb-record { position: absolute; right: 3px; top: 3px; width: 6px; height: 6px; border-radius: 99px; background: var(--bb-accent); box-shadow: 0 0 0 1.5px var(--bb-row); }
.bb-checked .bb-cell { box-shadow: inset 0 0 0 999px color-mix(in oklab, var(--bb-accent) 12%, transparent); }
.bb-sel { box-shadow: inset 0 0 0 999px color-mix(in oklab, var(--bb-accent) 16%, transparent); }
.bb-anchor { box-shadow: inset 0 0 0 2px var(--bb-accent); }
.bb-editor {
  border: 2px solid var(--bb-accent);
  border-radius: 3px;
  background: #fff;
  color: #16191d;
  padding: 0 5px;
  outline: none;
  box-shadow: 0 2px 10px rgba(15, 23, 42, .25);
}

/* --- group rows --------------------------------------------------------- */
.bb-group td { background: var(--bb-group); color: var(--bb-group-ink); border-bottom: 1px solid var(--bb-gridline); }
.bb-group-l1 td, .bb-group-l2 td { background: var(--bb-group-2); }
.bb-group-cell { border-left: 3px solid var(--bb-accent); }
.bb-group-l1 .bb-group-cell { border-left-color: color-mix(in oklab, var(--bb-accent) 45%, transparent); }
.bb-group-l2 .bb-group-cell { border-left-color: color-mix(in oklab, var(--bb-accent) 25%, transparent); }
/* The board is sixteen columns wide and always scrolled sideways, so a summary
   laid across the full row is read only by scrolling back. Sticking it to the
   left edge keeps the value, the count and the money on screen throughout. */
.bb-group-inner { position: sticky; left: 0; width: max-content; max-width: 100%; }
.bb-caret { background: color-mix(in oklab, var(--bb-group-ink) 10%, transparent); }
.bb-group-field { color: color-mix(in oklab, var(--bb-group-ink) 55%, transparent); }
.bb-group-value { color: var(--bb-group-ink); }
.bb-chip {
  border-radius: 99px;
  padding: 0 7px;
  font-size: 11px;
  background: color-mix(in oklab, var(--bb-group-ink) 9%, transparent);
  color: color-mix(in oklab, var(--bb-group-ink) 75%, transparent);
}
.bb-totals { color: color-mix(in oklab, var(--bb-group-ink) 78%, transparent); font-variant-numeric: tabular-nums; }
.bb-total-k { color: color-mix(in oklab, var(--bb-group-ink) 45%, transparent); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.bb-total-profit { color: var(--bb-profit); font-weight: 600; }

/* --- status bar --------------------------------------------------------- */
.bb-status {
  background: var(--bb-status, var(--bb-head));
  color: var(--bb-status-ink, #cbd2d9);
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
  font-variant-numeric: tabular-nums;
}
</style>

<!-- Theme tokens live UNSCOPED on purpose: `:global(html.dark)` inside a
     scoped block was dropped by the compiler, so the dark palette never
     reached the page. `.bb-shell` is this component's own class, so these
     rules still cannot touch anything else. -->
<style>
/* Two palettes, one grid.
   `sheet` is their Excel, colour for colour — the orange rows, the yellow
   customer cell, the green profit. It is the reason a dispatcher recognises
   this screen on day one, so it stays the default and it stays faithful.
   `studio` is the same board in our own palette for the boss's screen.
   Nothing but colour changes between them: same widths, same rules. */
.bb-shell {
  --bb-head: #171b21;
  --bb-head-2: #232a33;
  --bb-head-ink: #eef2f6;
  --bb-head-line: #39424e;
  --bb-row: #f3a967;
  --bb-row-alt: #efa25e;
  --bb-gridline: #cf9257;
  --bb-customer: #ffe95c;
  --bb-appt: #e2efda;
  --bb-profit: #12692c;
  --bb-negative: #b42318;
  --bb-link: #12439c;
  --bb-accent: oklch(0.55 0.16 255);
  --bb-ink: #16191d;
  --bb-group: #dfe4ea;
  --bb-group-2: #edf0f4;
  --bb-group-ink: #1f2630;
  --bb-edge: #b8763d;
  --bb-status: #171b21;
  --bb-status-ink: #aeb8c4;
}
.bb-shell[data-look='studio'] {
  --bb-head: #0f172a;
  --bb-head-2: #1e293b;
  --bb-head-ink: #e2e8f0;
  --bb-head-line: #334155;
  --bb-row: #ffffff;
  --bb-row-alt: #f8fafc;
  --bb-gridline: #e2e8f0;
  --bb-customer: #fef3c7;
  --bb-appt: #ecfdf5;
  --bb-profit: #047857;
  --bb-negative: #be123c;
  --bb-link: #1d4ed8;
  --bb-ink: #0f172a;
  --bb-group: #eef2ff;
  --bb-group-2: #f8fafc;
  --bb-group-ink: #1e293b;
  --bb-edge: #6366f1;
}
html.dark .bb-shell {
  /* Same board, lit for a dark room: the orange drops to a warm brown that
     still reads as their sheet, and the ink flips. */
  --bb-head: #0d1116;
  --bb-head-2: #161c23;
  --bb-head-line: #2b333d;
  --bb-row: #6f421c;
  --bb-row-alt: #5f3917;
  --bb-gridline: #8a5c30;
  --bb-customer: #7d6b13;
  --bb-appt: #1f3a26;
  --bb-profit: #7fe0a0;
  --bb-negative: #ff8f88;
  --bb-link: #9cc4ff;
  --bb-ink: #f4f2ee;
  --bb-group: #1b222b;
  --bb-group-2: #141a21;
  --bb-group-ink: #dfe6ee;
  --bb-status-ink: #93a1b0;
}
html.dark .bb-shell[data-look='studio'] {
  --bb-row: #111823;
  --bb-row-alt: #0d141d;
  --bb-gridline: #24303f;
  --bb-customer: #4a3f12;
  --bb-appt: #10291f;
  --bb-ink: #e6edf5;
  --bb-group: #172033;
  --bb-group-2: #111827;
}
</style>
