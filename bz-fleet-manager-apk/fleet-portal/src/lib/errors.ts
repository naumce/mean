import { AxiosError } from 'axios'

export function extractApiErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof AxiosError) {
    const data = error.response?.data as { error?: string } | undefined
    if (data?.error) return data.error
    if (error.message) return error.message
  }
  if (error instanceof Error) return error.message
  return fallback
}
