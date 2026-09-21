import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { getCoreRowModel, getFacetedRowModel, getFilteredRowModel, getSortedRowModel, useVueTable, type ColumnOrderState, type ColumnSizingState, type RowSelectionState, type SortingState, type VisibilityState } from '@tanstack/vue-table'
import type { BoardColumn, BoardLoad } from '../../lib/api'
import { buildColumns, cellOf } from './boardColumns'
import { clearPrefs, loadPrefs, savePrefs, type ColumnPrefs } from './columnPrefs'

// The table's brain: TanStack owns sorting, filtering, selection and column
// state; the component draws. Column state is restored from the browser
// and written back on every change; the server's layout wins on reset.
export function useBoardTable(loads: Ref<BoardLoad[]>, layout: Ref<BoardColumn[]>) {
  const prefs = loadPrefs()
  const sorting = ref<SortingState>([])
  const globalFilter = ref('')
  const rowSelection = ref<RowSelectionState>({})
  // `status` (Task 6, boardColumns.ts) is a hidden helper column that only
  // exists to back the status filter. Final review finding 3: `status` goes
  // LAST, after the stored prefs, so a blob carrying `status: true` (hand-
  // edited storage, a future bug, an older build) can never surface it. It
  // has no `layout` entry, so a visible `status` throws in the header render
  // and the whole board becomes a stack trace with no in-app recovery —
  // one character of ordering buys the guarantee.
  const columnVisibility = ref<VisibilityState>({ ...(prefs?.visibility ?? {}), status: false })
  const columnOrder = ref<ColumnOrderState>(prefs?.order ?? [])
  const columnSizing = ref<ColumnSizingState>(prefs?.sizing ?? {})
  const density = ref<ColumnPrefs['density']>(prefs?.density ?? 'theirs')
  const columns = computed(() => buildColumns(layout.value))

  const apply = <T,>(target: Ref<T>) => (updater: T | ((old: T) => T)) => { target.value = typeof updater === 'function' ? (updater as (old: T) => T)(target.value) : updater }

  const table = useVueTable<BoardLoad>({
    get data() { return loads.value },
    get columns() { return columns.value },
    state: {
      get sorting() { return sorting.value },
      get globalFilter() { return globalFilter.value },
      get rowSelection() { return rowSelection.value },
      get columnVisibility() { return columnVisibility.value },
      get columnOrder() { return columnOrder.value },
      get columnSizing() { return columnSizing.value },
    },
    onSortingChange: apply(sorting),
    onGlobalFilterChange: apply(globalFilter),
    onRowSelectionChange: apply(rowSelection),
    onColumnVisibilityChange: apply(columnVisibility),
    onColumnOrderChange: apply(columnOrder),
    onColumnSizingChange: apply(columnSizing),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    // The faceted model is the board with every OTHER column's filter applied
    // but not this one's — which is what makes a value list show "3" next to a
    // customer whose rows the customer filter itself is currently hiding.
    getFacetedRowModel: getFacetedRowModel(),
    getRowId: (l) => l.id,
    enableRowSelection: true,
    enableMultiSort: true,
    columnResizeMode: 'onChange',
    globalFilterFn: (row, _columnId, value: string) => {
      const needle = String(value ?? '').trim().toLowerCase()
      if (!needle) return true
      const l = row.original
      return layout.value.some((c) => cellOf(l.top, c).toLowerCase().includes(needle) || cellOf(l.bottom, c).toLowerCase().includes(needle))
    },
  })

  watch([columnVisibility, columnOrder, columnSizing, density], () => {
    savePrefs({ visibility: columnVisibility.value, order: columnOrder.value, sizing: columnSizing.value, density: density.value })
  }, { deep: true })

  // Final review finding 1 (CRITICAL): TanStack does not prune `rowSelection`
  // when `data` changes. A load that was selected and then left the board
  // (Show archived turned back off, a reload without it) stayed checked, so
  // the bulk bar counted it, the delete confirmation — which names loads
  // from what the server last sent — never listed it, and the POST deleted
  // it anyway. Reconciling here fixes the bar, the dialog and the payload at
  // once, because all three read from this one selection.
  watch(loads, (l) => {
    const live = new Set(l.map((x) => x.id))
    const entries = Object.entries(rowSelection.value)
    const kept = entries.filter(([id, on]) => on && live.has(id))
    if (kept.length !== entries.length) rowSelection.value = Object.fromEntries(kept)
  })

  const selectedIds = computed(() => Object.keys(rowSelection.value).filter((id) => rowSelection.value[id]))
  const clearSelection = () => { rowSelection.value = {} }
  // The persistence watch above is default-flush ("pre"): it runs on the
  // next tick, not synchronously with these assignments. Calling
  // clearPrefs() right after resetting the refs (as the "clear last"
  // ordering alone would suggest) loses the race — the queued watcher
  // still fires afterwards and writes the (now-reset) prefs straight back
  // to storage. Awaiting a tick first lets that watcher run and lose to
  // clearPrefs() instead of the other way around, so storage ends up empty.
  const resetColumns = async () => {
    columnVisibility.value = { status: false }; columnOrder.value = []; columnSizing.value = {}; density.value = 'theirs'
    await nextTick()
    clearPrefs()
  }
  const hideColumn = (id: string) => { columnVisibility.value = { ...columnVisibility.value, [id]: false } }
  const setDensity = (d: ColumnPrefs['density']) => { density.value = d }

  return { table, sorting, globalFilter, rowSelection, selectedIds, clearSelection, columnVisibility, columnOrder, columnSizing, density, setDensity, resetColumns, hideColumn }
}
