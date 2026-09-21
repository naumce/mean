// Trailer-type glyphs and accent classes (accents read the same in both modes).
export const EQUIP_ICON: Record<string, string> = {
  DryVan: '📦', Reefer: '❄', Flatbed: '▤', StepDeck: '⬍', Tanker: '⬤', Intermodal: '▭',
}
export const EQUIP_CLASSES: Record<string, string> = {
  DryVan: 'bg-blue-500/20 text-blue-500',
  Reefer: 'bg-cyan-500/20 text-cyan-500',
  Flatbed: 'bg-amber-500/20 text-amber-500',
  StepDeck: 'bg-purple-500/20 text-purple-500',
  Tanker: 'bg-yellow-500/20 text-yellow-600',
  Intermodal: 'bg-teal-500/20 text-teal-500',
}
export const EQUIP_TYPES = Object.keys(EQUIP_ICON)

/** "StepDeck" -> "STEP DECK" */
export function equipLabel(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
}
export const equipIcon = (type: string): string => EQUIP_ICON[type] ?? '▭'
export const equipClass = (type: string): string => EQUIP_CLASSES[type] ?? 'bg-surface-3 text-ink-2'
