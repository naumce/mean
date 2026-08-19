export interface Driver {
  id: string
  email: string
  name: string
  phone: string | null
  status: string
  createdAt: string
}

export interface DriverCreatePayload {
  email: string
  name: string
  phone?: string
  password: string
}

export interface DriverUpdatePayload {
  name?: string
  phone?: string
  status?: string
}

export interface Vehicle {
  id: string
  plate: string
  model: string | null
  driverId: string | null
  driver?: Driver | null
  createdAt: string
}

export interface VehicleCreatePayload {
  plate: string
  model?: string
}

export interface VehicleUpdatePayload {
  plate?: string
  model?: string
}
