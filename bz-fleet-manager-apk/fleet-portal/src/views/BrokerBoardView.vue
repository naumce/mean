<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AgentDrawer from '../components/agent/AgentDrawer.vue'
import BrokerGrid from '../components/broker/BrokerGrid.vue'
import BrokerImportDialog from '../components/broker/BrokerImportDialog.vue'
import BulkBar from '../components/broker/BulkBar.vue'
import ColumnTools from '../components/broker/ColumnTools.vue'
import ConfirmDelete from '../components/broker/ConfirmDelete.vue'
import type { BoardCellPaste, BoardLoad, BoardViewState } from '../lib/api'
import { triggerBlobDownload } from '../lib/download'
import { useSheetStore } from '../nightshift/stores/sheet'
import { useAuthStore } from '../stores/auth'
import { useBrokerBoardStore } from '../stores/brokerBoard'
import { useLoadLocksStore } from '../stores/loadLocks'

// Their board (spec §4): the sheet they use today, backed by our loads.
// Slice 2A (Task 5) adds the bulk bar: select rows in the grid, then
// archive/unarchive/delete/export the selection — each action reloads the
// board and drops the selection on success, and leaves both untouched (with
// the server's verbatim refusal in store.error) when it's refused.
const store = useBrokerBoardStore()
const loadLocks = useLoadLocksStore()
// Sanctioned exception to the portal isolation rule (Cockpit code importing
// nightshift/): the grid reads the sheet binding to disable its AGENT switch.
const sheetStore = useSheetStore()
const auth = useAuthStore()
const importing = ref(false)
const confirmingDelete = ref(false)
const search = ref('')
const grid = ref<InstanceType<typeof BrokerGrid> | null>(null)
// `listen()` subscribes and then reads the snapshot itself (F7) — the other
// order leaves a window where a frame is neither in the snapshot nor
// delivered.
//
// Task 11 ruling: `sheetStore.load()` is fetched here (not inside BrokerGrid
// itself) so the grid's own tests never need to stub a sheet binding just to
// render — the grid only ever READS `sheetStore.binding` reactively, to
// decide whether the AGENT switch has moved to the dispatcher's own sheet.
// Only a sheet-tier org can have a binding at all (final fix wave, minor),
// so a tower org never pays the extra GET.
onMounted(() => {
  store.load(); store.loadView(); loadLocks.listen(); store.connectRealtime()
  if (auth.tier === 'sheet') void sheetStore.load()
})
onBeforeUnmount(() => { loadLocks.releaseAll(); loadLocks.unlisten(); store.disconnectRealtime() })

// Slice 2B: the board is editable. The grid emits what a dispatcher did; the
// store does the writing and owns the refusal. Nothing here is optimistic
// except the fills — a cell shows the server's own answer, so a RATE they
// typed as "4000" comes back as "$4,000.00" and PROFIT follows it.
//
// Task 8: a load lock is held for exactly as long as an editor is open on it
// (see onEditStart/onEditEnd below), and every write carries the version the
// grid rendered — the version backstop (store.conflictFor) is the fallback
// for whatever the lock did not catch (a stale tab, a missed heartbeat).
// F4: in-flight saves PER LOAD, not one `lastSave` for the tab. A dispatcher
// tabbing across a row starts editing load B while load A's PATCH is still in
// the air; with a single pending save (and a single held load) A's lock was
// released the moment B's editor opened, and A's write then landed on a row
// anyone could have taken. Each load's lock is released when THAT load has no
// saves left and no conflict of its own is waiting to be answered.
const saves = new Map<string, Set<Promise<boolean>>>()

function trackSave(loadId: string, p: Promise<boolean>) {
  let set = saves.get(loadId)
  if (!set) { set = new Set(); saves.set(loadId, set) }
  set.add(p)
  void p.finally(() => {
    set.delete(p)
    if (set.size === 0) saves.delete(loadId)
    settle(loadId)
  })
}

/** Release this load's lock if nothing is still using it: no save in flight,
 *  no editor open on it, and no conflict of its own pending — then, A4 Task
 *  7, let the store catch this load up on any socket frame it held back
 *  while busy (a no-op unless one actually was). `store.conflictFor(loadId)`
 *  needs no separate attribution step the way the old single `store.conflict`
 *  slot did: the map is already keyed by the load that raised it. */
function settle(loadId: string) {
  if (saves.get(loadId)?.size) return
  if (editingLoadId.value === loadId) return
  if (store.conflictFor(loadId)) return
  loadLocks.release(loadId)
  store.settleLoad(loadId)
}

const editingLoadId = ref<string | null>(null)
const onEdit = (write: BoardCellPaste) => {
  const p = store.editCell(write.loadId, { row: write.row, key: write.key, source: write.source, value: write.value, baseVersion: write.baseVersion })
  trackSave(write.loadId, p)
}
async function onEditStart(loadId: string) {
  if (await loadLocks.hold(loadId)) { editingLoadId.value = loadId; return }
  // Someone else has it: the editor closes and the row says who.
  store.error = `${loadLocks.heldBy(loadId)?.by ?? 'Someone'} is editing this load`
  grid.value?.cancelEdit()
}
function onEditEnd(loadId: string) {
  // The lock outlives the editor by exactly one save: released once the
  // write has landed — or, on a version conflict, once the dispatcher has
  // chosen (resolveConflict below), so nobody grabs the row mid-decision.
  if (editingLoadId.value === loadId) editingLoadId.value = null
  settle(loadId)
}
const resolve = async (loadId: string, choice: 'mine' | 'theirs') => {
  await store.resolveConflict(loadId, choice)
  // F8: only once the conflict is actually gone. `resolveConflict` can
  // refuse again (the row moved a second time while the panel was open), and
  // releasing there handed the row away mid-decision.
  if (!store.conflictFor(loadId)) settle(loadId)
}
// A4 Task 7: one panel per conflicted row, not one slot for the whole board
// — two dispatchers' saves can collide on two different loads at once, and
// resolving one must never dismiss the other's (A2 finding R14).
const conflicts = computed(() => Object.values(store.conflicts))
const onPaste = (cells: BoardCellPaste[]) => store.pasteCells(cells)
const onView = (next: BoardViewState) => store.saveView(next)
const onNotice = (text: string) => { store.notice = text }
async function onAddLoad() {
  const id = await store.addLoad()
  if (id) store.notice = 'Load added — type into it'
}
async function onDuplicate() { await store.duplicate(store.selectedIds); if (!store.error) grid.value?.clearSelection() }

/** Right-click → Delete row(s) goes through the SAME confirmation as the bulk
 *  bar's Delete: a menu item that deletes without naming what it deletes is
 *  how a board loses a load nobody meant to touch. */
function onDeleteRows(ids: string[]) {
  store.selectedIds = ids
  confirmingDelete.value = true
}

/** Setting the UPDATE cell for a whole selection is a paste of one column —
 *  the same all-or-nothing endpoint, so twenty loads either all say DELIVERED
 *  or none of them do. */
async function onSetUpdate(text: string) {
  // F12: a selected id the board no longer holds (archived away, deleted by
  // someone else, filtered out of a partial load) has NO rendered version —
  // sending `baseVersion: 0` for it claimed a version it never read, and the
  // §7.4 backstop would have waved that write through. Skip it and say so.
  const known = new Map(store.loads.map((l) => [l.id, l]))
  const missing = store.selectedIds.filter((id) => !known.has(id))
  const cells = store.selectedIds
    .map((id) => known.get(id))
    .filter((l): l is BoardLoad => l !== undefined)
    .map((l) => ({ loadId: l.id, row: 'top' as const, key: 'update' as const, source: 'UPDATE', value: text, baseVersion: l.version }))
  if (cells.length === 0) {
    store.error = 'None of the selected rows are on the board any more — reload and try again'
    return
  }
  const ok = await store.pasteCells(cells)
  if (ok) store.notice = `UPDATE set on ${cells.length} ${cells.length === 1 ? 'load' : 'loads'}`
  // After the paste: `pasteCells` clears `error` on entry and owns it on a
  // refusal, so the skip note goes on top of a success, never over a reason.
  if (missing.length > 0 && !store.error) {
    store.error = `${missing.length} selected ${missing.length === 1 ? 'row is' : 'rows are'} no longer on the board and ${missing.length === 1 ? 'was' : 'were'} skipped — reload to see ${missing.length === 1 ? 'it' : 'them'}`
  }
}

// The handoff's 12 swatches, plus "no fill". A dispatcher paints the
// selection; the color is remembered so painting a second block is one click.
const SWATCHES = ['#fff3b0', '#ffd9a8', '#ffc9c9', '#ffd6e7', '#e4d4ff', '#cfe3ff', '#c6f0ea', '#cdf2c8', '#e6f5b8', '#e5e7eb', '#f5d76e', '#a9c9f5']
const lastFill = ref(SWATCHES[0])
const fillTarget = ref<'cell' | 'row' | 'col'>('cell')
const fillOpen = ref(false)
function paint(color: string | null) {
  if (color) lastFill.value = color
  grid.value?.fillSelection(color, fillTarget.value)
  fillOpen.value = false
}

// Grouping (slice 2B): a chips builder, outermost first. The fields are the
// handoff's list, kept to columns this board actually has — CARRIER is the
// second line of CUSTOMER, which is why it is named separately.
const GROUPABLE: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'customer', label: 'Customer' }, { id: 'carrier', label: 'Carrier' }, { id: 'shipDate', label: 'Ship date' },
  { id: 'pickupCity', label: 'Pick up' }, { id: 'deliveryCity', label: 'Delivery' }, { id: 'update', label: 'Update' },
  { id: 'puZip', label: 'PU zip' }, { id: 'delZip', label: 'Del zip' },
]
const groupBy = ref<string[]>([])
const groupChoice = ref('')
const groupableLeft = computed(() => GROUPABLE.filter((g) => !groupBy.value.includes(g.id)))
const labelOfGroup = (id: string) => GROUPABLE.find((g) => g.id === id)?.label ?? id
function addGroup() {
  if (groupChoice.value && !groupBy.value.includes(groupChoice.value)) groupBy.value = [...groupBy.value, groupChoice.value]
  groupChoice.value = ''
}
const removeGroup = (id: string) => { groupBy.value = groupBy.value.filter((g) => g !== id) }

/** The CSV is the VIEW: the columns left visible and the rows the search and
 *  filters left, in the order on screen. The .xlsx export beside it is the
 *  server's, in their own saved layout — two different promises, both worth
 *  keeping. */
function exportCsv() {
  const csv = grid.value?.exportCsv()
  if (!csv) return
  triggerBlobDownload('load-board.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  store.notice = 'Board exported as CSV'
}

// Task 6: the filter row is off by default (it doubles header height); the
// status select is a distinct channel from both search and the filter row.
// "archived" only ever matches a row when the server actually sent archived
// loads back — it hides them by default (store.showArchived) — so the
// option's title says that rather than silently doing nothing.
const showFilters = ref(false)
const statusFilter = ref('all')

// Their colours or ours. `sheet` is the default and the point of this view;
// `studio` is the same grid in the product's palette for anyone who does not
// need to recognise their spreadsheet. Remembered per browser, like density.
const LOOK_KEY = 'brokerBoard.look.v1'
const look = ref<'sheet' | 'studio'>((localStorage.getItem(LOOK_KEY) as 'sheet' | 'studio') ?? 'sheet')
watch(look, (v) => { try { localStorage.setItem(LOOK_KEY, v) } catch { /* private window: the board still works */ } })

// LOAD#, else BOL#, else the internal order number — never the bare id
// unless nothing else is on the row (decisions log, Task 5).
const selectedLabels = computed(() => store.loads.filter((l) => store.selectedIds.includes(l.id)).map((l) => l.bottom?.loadNo || l.top.bol || l.top.loadNo || l.id.slice(0, 8)))
// NIT 9: a selection survives a search (deliberately — see BulkBar), so the
// bar has to say how much of it is currently off screen. The grid publishes
// the ids the search/filters leave visible; everything selected that is not
// among them is hidden. Before the grid exists there is nothing selected
// either, so "no grid" is honestly zero.
const hiddenSelected = computed(() => {
  const ids = grid.value?.visibleIds
  if (!ids) return 0
  const visible = new Set(ids)
  return store.selectedIds.filter((id) => !visible.has(id)).length
})
// store.remove/archive never throw (their errors land in store.error), so
// the only way to tell success from refusal here is that a successful
// bulk() already cleared store.selectedIds itself — only then is it safe to
// also clear the grid's own internal checkbox state. Clearing it unconditionally
// (as the brief's reference code did) fed back through the grid's
// update:selectedIds emit and wiped a REFUSED action's selection too,
// undoing finding 1's fix at one remove.
async function onDelete() { confirmingDelete.value = false; await store.remove(store.selectedIds); if (!store.error) grid.value?.clearSelection() }
async function onArchive(archived: boolean) { await store.archive(store.selectedIds, archived); if (!store.error) grid.value?.clearSelection() }
async function onToggleArchived(ev: Event) { store.showArchived = (ev.target as HTMLInputElement).checked; await store.load() }

// Night Shift on the Board (Task 7): the drawer. Opened by the pill's
// `open-agent` (loadId), which bubbles up through BrokerGrid's own emits —
// that passthrough is the other implementer's; this view only listens for
// it. The header fields the drawer wants (LOAD#, customer, carrier + MC)
// come from this board's own two-row cell shape: CARRIER is the second line
// of CUSTOMER (see the GROUPABLE comment above), same convention
// `selectedLabels` already uses for LOAD#.
const agentDrawerLoadId = ref<string | null>(null)
const agentDrawerLoad = computed(() => store.loads.find((l) => l.id === agentDrawerLoadId.value) ?? null)
const agentDrawerLoadNo = computed(() => {
  const l = agentDrawerLoad.value
  return l ? l.bottom?.loadNo || l.top.bol || l.top.loadNo || l.id.slice(0, 8) : null
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 overflow-hidden p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-[18px] font-bold tracking-tight text-ink">Their Board</h1>
        <p class="text-sm text-ink-2">Your sheet, as you use it. Two rows per load. The AGENT column is the night shift.</p>
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <input v-model="search" type="search" placeholder="Search every cell…" aria-label="Search the board" class="w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink sm:w-56" />
        <label class="flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-2"><input type="checkbox" data-show-archived :checked="store.showArchived" @change="onToggleArchived" /> Archived</label>
        <select v-model="statusFilter" data-status aria-label="Filter by status" class="rounded-lg border border-line bg-surface px-2 py-2 text-sm text-ink">
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="assigned">Assigned</option>
          <option value="in_progress">In progress</option>
          <option value="delivered">Delivered</option>
          <option value="archived" title="Only shows when &quot;Show archived&quot; is on — the server hides archived loads otherwise">Archived</option>
        </select>
        <div class="flex items-center overflow-hidden rounded-lg border border-line">
          <button type="button" class="px-2.5 py-2 text-sm hover:bg-surface-2" :class="showFilters ? 'bg-surface-2 text-ink' : 'text-ink-2'" :aria-pressed="showFilters" @click="showFilters = !showFilters">Filters</button>
          <button type="button" class="border-l border-line px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2" title="Tight or their spacing" @click="grid?.setDensity(grid?.density === 'tight' ? 'theirs' : 'tight')">Density</button>
          <button type="button" data-look-toggle class="border-l border-line px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2"
                  :title="look === 'sheet' ? 'Switch to the product palette' : 'Switch back to their sheet colours'"
                  @click="look = look === 'sheet' ? 'studio' : 'sheet'">{{ look === 'sheet' ? 'Sheet' : 'Studio' }}</button>
        </div>
        <button v-if="(grid?.activeFilters ?? 0) > 0" type="button" data-filter-pill class="rounded-full border border-brand px-2 py-1 text-xs font-semibold text-brand" @click="grid?.clearAllFilters()">{{ grid?.activeFilters }} filtered · clear</button>
        <div class="flex items-center overflow-hidden rounded-lg border border-line">
          <button type="button" data-add-load class="px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2 disabled:opacity-50" :disabled="store.busy" @click="onAddLoad">+ Load</button>
          <button type="button" data-merge class="border-l border-line px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2" title="Split a cell into two lines, or join it back" @click="grid?.toggleMerge()">{{ grid?.anchorIsSplit ? 'Merge' : 'Unmerge' }}</button>
        <div class="relative">
          <button type="button" data-fill class="border-l border-line px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2" :aria-expanded="fillOpen" @click="fillOpen = !fillOpen">
            <span class="mr-1 inline-block h-3 w-3 rounded-sm align-middle ring-1 ring-black/10" :style="{ background: lastFill }"></span>Fill
          </button>
          <div v-if="fillOpen" data-fill-menu class="absolute right-0 z-40 mt-1 w-56 rounded-lg border border-line bg-surface p-2 shadow-lg">
            <div class="mb-2 flex gap-1 text-xs">
              <button v-for="target in (['cell', 'row', 'col'] as const)" :key="target" type="button" class="flex-1 rounded border px-1 py-1" :class="fillTarget === target ? 'border-brand text-brand' : 'border-line text-ink-2'" @click="fillTarget = target">{{ target === 'col' ? 'Columns' : target === 'row' ? 'Rows' : 'Cells' }}</button>
            </div>
            <div class="grid grid-cols-6 gap-1">
              <button v-for="c in SWATCHES" :key="c" type="button" :data-swatch="c" class="h-6 w-6 rounded border border-line" :style="{ background: c }" :aria-label="'Fill ' + c" @click="paint(c)"></button>
            </div>
            <button type="button" data-no-fill class="mt-2 w-full rounded border border-line px-2 py-1 text-xs text-ink-2" @click="paint(null)">No fill</button>
          </div>
        </div>
        </div>
        <ColumnTools :columns="grid?.columnsForTools ?? []" @toggle="grid?.toggleColumn($event)" @move="(id, d) => grid?.moveColumn(id, d)" @reset="grid?.resetColumns()" />
        <button type="button" data-export-csv class="rounded-lg border border-line px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2" @click="exportCsv">Export CSV</button>
        <button class="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-brand-ink hover:brightness-110" @click="importing = true">Import .xlsx</button>
      </div>
    </div>

    <!-- Group by: chips, outermost first, with the totals on each group row. -->
    <div class="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-group-builder>
      <span class="text-xs font-semibold uppercase tracking-wide text-ink-3">Group by</span>
      <span v-for="(id, i) in groupBy" :key="id" class="flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/10 py-0.5 pl-2 pr-1 text-brand" :data-chip="id">
        <span class="text-[10px] font-bold opacity-70">{{ i + 1 }}</span>{{ labelOfGroup(id) }}
        <button type="button" class="grid h-4 w-4 place-items-center rounded-full hover:bg-brand/20" :aria-label="'Stop grouping by ' + labelOfGroup(id)" @click="removeGroup(id)">×</button>
      </span>
      <select v-model="groupChoice" data-group-add aria-label="Group by another field" class="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink" @change="addGroup">
        <option value="">Add…</option>
        <option v-for="g in groupableLeft" :key="g.id" :value="g.id">{{ g.label }}</option>
      </select>
      <template v-if="groupBy.length">
        <div class="flex items-center overflow-hidden rounded-lg border border-line text-ink-2">
          <button type="button" data-collapse-all class="px-2 py-1 hover:bg-surface-2" @click="grid?.collapseAll()">Collapse all</button>
          <button type="button" data-expand-all class="border-l border-line px-2 py-1 hover:bg-surface-2" @click="grid?.expandAll()">Expand all</button>
        </div>
      </template>
    </div>

    <p v-if="store.error" class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500 dark:bg-red-950/40 dark:text-red-300">{{ store.error }}</p>
    <!-- The record refused the status this cell asked for (spec §6.3). The
         cell itself landed, so this is neither red nor green: it is the
         record saying, in its own words, where that move actually happens.
         Dismissible, and the next write that is not refused clears it. -->
    <p v-if="store.lastRefusal" data-refusal class="flex items-start justify-between gap-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-200">
      <span>{{ store.lastRefusal }}</span>
      <button type="button" data-dismiss-refusal aria-label="Dismiss" class="shrink-0 px-1 font-semibold hover:opacity-70" @click="store.lastRefusal = null">×</button>
    </p>
    <!-- The version backstop (spec §7.4): this cell changed under the
         dispatcher while they were typing. Both values are shown; nothing was
         written until they choose. One panel per conflicted row (A4 Task 7)
         — two saves in flight on two different loads never share one slot. -->
    <div v-for="entry in conflicts" :key="entry.loadId" data-conflict class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950/40 dark:text-amber-200">
      <span>This cell changed while you were typing — yours: <b>{{ entry.write.value }}</b> · theirs: <b>{{ entry.theirs }}</b></span>
      <button type="button" data-keep-mine class="rounded border border-amber-400 px-2 py-0.5 font-semibold hover:bg-amber-100" @click="resolve(entry.loadId, 'mine')">Keep mine</button>
      <button type="button" data-take-theirs class="rounded border border-amber-400 px-2 py-0.5 font-semibold hover:bg-amber-100" @click="resolve(entry.loadId, 'theirs')">Take theirs</button>
    </div>
    <p v-if="store.notice" class="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-800 dark:border-green-500 dark:bg-green-950/40 dark:text-green-300">{{ store.notice }}</p>
    <BulkBar :count="store.selectedIds.length" :hidden="hiddenSelected" :busy="store.busy" @archive="onArchive(true)" @unarchive="onArchive(false)" @delete="confirmingDelete = true" @export="store.exportSelected(store.selectedIds)" @duplicate="onDuplicate" @set-update="onSetUpdate" @clear="grid?.clearSelection()" />

    <p v-if="store.loading && store.loads.length === 0" class="text-sm text-ink-2">Loading your board…</p>
    <div v-else-if="!store.error && store.loads.length === 0" class="rounded border border-dashed border-line p-8 text-center">
      <p class="text-base font-semibold text-ink">Import your board</p>
      <p class="mt-1 text-sm text-ink-2">Pick the .xlsx you dispatch from today. It shows up here exactly as it is, and the night shift can start watching it.</p>
      <button class="mt-4 rounded bg-brand px-3 py-2 text-sm font-semibold text-brand-ink" @click="importing = true">Choose file</button>
    </div>
    <!-- Gated on data, not on store.error: a refused bulk action (archive/
         delete/export) sets store.error but must NOT unmount the grid — the
         dispatcher needs the rows and checkboxes still visible to see and
         fix which loads blocked it (review finding 1). An error on the
         *initial* load has store.loads empty, so it still falls through to
         the empty state above rather than showing a grid with nothing in it. -->
    <BrokerGrid v-else-if="store.loads.length > 0" ref="grid" :layout="store.layout" :loads="store.loads" :search="search" :show-filters="showFilters" :status-filter="statusFilter" :view="store.view" :group-by="groupBy" :look="look" :locks="loadLocks.theirs" @update:selected-ids="store.selectedIds = $event" @edit="onEdit" @paste="onPaste" @view="onView" @notice="onNotice" @delete-rows="onDeleteRows" @edit-start="onEditStart" @edit-end="onEditEnd" @open-agent="agentDrawerLoadId = $event" />

    <ConfirmDelete v-if="confirmingDelete" :labels="selectedLabels" @confirm="onDelete" @cancel="confirmingDelete = false" />
    <!-- The dialog stays open after an import so the counts can be read; the dispatcher closes it. -->
    <BrokerImportDialog v-if="importing" @close="importing = false" />

    <!-- Night Shift on the Board (spec §6.4): click the pill, the drawer
         slides in from the right; the board stays visible underneath it. -->
    <AgentDrawer
      :load-id="agentDrawerLoadId"
      :load-no="agentDrawerLoadNo"
      :customer-name="agentDrawerLoad?.top.customer ?? null"
      :carrier-name="agentDrawerLoad?.bottom?.customer ?? null"
      :carrier-mc="agentDrawerLoad?.top.mc ?? agentDrawerLoad?.bottom?.mc ?? null"
      @close="agentDrawerLoadId = null"
    />
  </div>
</template>
