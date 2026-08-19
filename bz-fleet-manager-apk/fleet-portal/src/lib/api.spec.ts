import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'
import { beforeEach, describe, expect, it } from 'vitest'
import { attachAuthToken } from './api'
import { TOKEN_STORAGE_KEY } from './constants'

function baseConfig(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders() } as InternalAxiosRequestConfig
}

describe('attachAuthToken', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('attaches Authorization: Bearer <token> when a token exists', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'abc123')

    const result = attachAuthToken(baseConfig())

    expect(result.headers.get('Authorization')).toBe('Bearer abc123')
  })

  it('does not set an Authorization header when no token exists', () => {
    const result = attachAuthToken(baseConfig())

    expect(result.headers.get('Authorization')).toBeUndefined()
  })
})
