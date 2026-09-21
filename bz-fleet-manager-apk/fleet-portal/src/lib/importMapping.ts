// Pure client-side core of the import field-mapper: CSV parsing, the field
// catalog per entity, header auto-matching, and canonical row building.
// No DOM, no store — everything here is unit-testable in isolation. The
// server stays the validation authority; this only renames columns.

import type { ImportEntity } from '../stores/importer'

export interface ImportField {
  key: string
  label: string
  required: boolean
  /** Normalized header spellings (lowercase, alphanumeric only) seen in the
   *  wild — TMS/ELD exports rarely match our field names. */
  aliases: string[]
}

/** column index -> our field key, or null for "ignore this column". */
export type ColumnMapping = (string | null)[]

// RFC-4180-ish: quoted cells, escaped quotes, CRLF, blank-line skip. Ported
// from fleet-backend/src/lib/csv.ts so both ends read the same dialect.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0
  const pushCell = () => {
    row.push(inQuotes ? cell : cell.trim())
    cell = ''
    inQuotes = false
  }
  const pushRow = () => {
    pushCell()
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (ch === '"') {
        inQuotes = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell.trim() === '') {
      inQuotes = true
      cell = ''
      i++
      continue
    }
    if (ch === ',') {
      pushCell()
      i++
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow()
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') {
      pushRow()
      i++
      continue
    }
    cell += ch
    i++
  }
  if (cell !== '' || row.length > 0) pushRow()
  return rows
}

export const FIELD_CATALOG: Record<ImportEntity, ImportField[]> = {
  loads: [
    { key: 'externalId', label: 'Load ID', required: true,
      aliases: ['loadid', 'load', 'loadnumber', 'loadno', 'reference', 'referencenumber', 'ordernumber', 'order', 'pronumber', 'pro'] },
    { key: 'requiredEquip', label: 'Equipment', required: true,
      aliases: ['equipment', 'equipmenttype', 'equip', 'trailertype', 'trailer'] },
    { key: 'revenueCents', label: 'Revenue (cents)', required: false,
      aliases: ['revenue', 'linehaul', 'rate', 'linehaulcents'] },
    { key: 'fscCents', label: 'Fuel surcharge (cents)', required: false,
      aliases: ['fsc', 'fuelsurcharge', 'fuel'] },
    { key: 'hazmatClass', label: 'Hazmat class', required: false,
      aliases: ['hazmat', 'hazclass', 'unclass'] },
    { key: 'commodity', label: 'Commodity', required: false,
      aliases: ['product', 'freight', 'freightdescription', 'description', 'cargo'] },
    { key: 'brokerName', label: 'Broker / customer', required: false,
      aliases: ['broker', 'customer', 'customername', 'billto', 'shipperbroker'] },
    { key: 'pickupAddress', label: 'Pickup address', required: true,
      aliases: ['origin', 'originaddress', 'pickup', 'pickuplocation', 'puaddress', 'shipper', 'shipperaddress', 'from'] },
    { key: 'pickupLat', label: 'Pickup lat', required: false,
      aliases: ['originlat', 'pulat', 'shipperlat'] },
    { key: 'pickupLng', label: 'Pickup lng', required: false,
      aliases: ['originlng', 'originlon', 'pulng', 'pulon', 'shipperlng'] },
    { key: 'pickupWindowStart', label: 'Pickup window start', required: false,
      aliases: ['puearliest', 'pickupstart', 'pickupearliest', 'apptstart', 'appointmentstart'] },
    { key: 'pickupWindowEnd', label: 'Pickup window end', required: false,
      aliases: ['pulatest', 'pickupend', 'pickuplatest', 'apptend', 'appointmentend'] },
    { key: 'deliveryAddress', label: 'Delivery address', required: true,
      aliases: ['destination', 'destinationaddress', 'delivery', 'deliverylocation', 'deladdress', 'consignee', 'consigneeaddress', 'dropaddress', 'to'] },
    { key: 'deliveryLat', label: 'Delivery lat', required: false,
      aliases: ['destlat', 'destinationlat', 'dellat', 'consigneelat'] },
    { key: 'deliveryLng', label: 'Delivery lng', required: false,
      aliases: ['destlng', 'destlon', 'destinationlng', 'dellng', 'consigneelng'] },
    { key: 'deliveryWindowEnd', label: 'Delivery window end', required: false,
      aliases: ['deliverylatest', 'deliveryend', 'deliveryappt', 'duedate', 'deliverby'] },
  ],
  drivers: [
    { key: 'email', label: 'Email', required: true, aliases: ['driveremail', 'emailaddress', 'mail'] },
    { key: 'name', label: 'Name', required: true, aliases: ['drivername', 'driver', 'fullname'] },
    { key: 'externalId', label: 'Driver ID', required: false,
      aliases: ['driverid', 'employeeid', 'employeenumber', 'code', 'drivercode'] },
    { key: 'phone', label: 'Phone', required: false, aliases: ['phonenumber', 'mobile', 'cell', 'cellphone'] },
    { key: 'hazmatEndorsed', label: 'Hazmat endorsed', required: false,
      aliases: ['hazmat', 'hazmatendorsement', 'hazmatendorsed'] },
    { key: 'lat', label: 'Last lat', required: false, aliases: ['lastlat', 'latitude', 'currentlat'] },
    { key: 'lng', label: 'Last lng', required: false, aliases: ['lastlng', 'longitude', 'lon', 'currentlng'] },
  ],
  hos: [
    { key: 'email', label: 'Driver email', required: true, aliases: ['driveremail', 'emailaddress', 'mail'] },
    { key: 'driveRemainingMin', label: 'Drive remaining (min)', required: true,
      aliases: ['driveremaining', 'driveleft', 'drivemin', 'driveminutes', 'driveremainingminutes'] },
    { key: 'windowRemainingMin', label: 'Window remaining (min)', required: true,
      aliases: ['windowremaining', 'shiftremaining', 'dutywindow', 'windowmin', 'onduty'] },
    { key: 'cycleRemainingMin', label: 'Cycle remaining (min)', required: true,
      aliases: ['cycleremaining', 'cycle', 'cyclemin', 'seventyhour', '70hr'] },
    { key: 'minutesSinceBreak', label: 'Minutes since break', required: true,
      aliases: ['sincebreak', 'breakminutes', 'minsincebreak', 'sincelastbreak'] },
  ],
}

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Match each CSV header to a catalog field: exact key first, then aliases.
 *  A field is claimed at most once — the first matching column wins. */
export function autoMap(headers: string[], entity: ImportEntity): ColumnMapping {
  const fields = FIELD_CATALOG[entity]
  const claimed = new Set<string>()
  return headers.map((header) => {
    const norm = normalizeHeader(header)
    if (!norm) return null
    const match =
      fields.find((f) => normalizeHeader(f.key) === norm) ??
      fields.find((f) => f.aliases.includes(norm))
    if (!match || claimed.has(match.key)) return null
    claimed.add(match.key)
    return match.key
  })
}

/** Apply the mapping: canonical keys, ignored columns dropped, empty cells
 *  omitted so the server treats them as absent optional fields. */
export function buildRows(dataRows: string[][], mapping: ColumnMapping): Record<string, string>[] {
  return dataRows.map((cells) => {
    const out: Record<string, string> = {}
    mapping.forEach((fieldKey, i) => {
      const value = cells[i]
      if (!fieldKey || value == null || value === '') return
      out[fieldKey] = value
    })
    return out
  })
}

/** Required catalog fields the current mapping leaves unmapped. */
export function missingRequired(mapping: ColumnMapping, entity: ImportEntity): ImportField[] {
  const mapped = new Set(mapping.filter(Boolean))
  return FIELD_CATALOG[entity].filter((f) => f.required && !mapped.has(f.key))
}
