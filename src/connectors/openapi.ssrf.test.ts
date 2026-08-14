import { describe, expect, it, vi } from 'vitest'
import { OpenApiConnector } from './openapi.js'

function connector() {
  return new OpenApiConnector({
    type: 'openapi',
    name: 'api',
    description: 'fixture',
    config: { allowedBaseUrls: 'https://example.com' },
  })
}

describe('G10 OpenAPI DNS pin + redirect SSRF', () => {
  it('a 302 to https://127.0.0.1/secret is rejected', async () => {
    const c = connector()
    vi.spyOn(c, 'enforceSafeRemoteUrl').mockImplementation(async (raw, purpose) => {
      if (raw.includes('127.0.0.1')) {
        throw new Error(`api: ${purpose} resolves to blocked private/reserved address 127.0.0.1.`)
      }
      return ['1.2.3.4']
    })
    vi.spyOn(c as unknown as { doFetch: (u: string) => Promise<Response> }, 'doFetch').mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://127.0.0.1/secret' : null) },
    } as Response)

    await expect(c.safeFetch('https://example.com/ok', {}, 'OpenAPI request')).rejects.toThrow(
      /127\.0\.0\.1|private|blocked/,
    )
  })

  it('lookup is pinned to the approved address', async () => {
    const c = connector()
    const lookups: string[] = []
    vi.spyOn(c, 'enforceSafeRemoteUrl').mockResolvedValue(['203.0.113.8'])
    vi.spyOn(c as unknown as { pinnedDispatcher: (h: string, a: string) => unknown }, 'pinnedDispatcher').mockImplementation(
      (_h, address) => {
        lookups.push(address)
        return undefined
      },
    )
    vi.spyOn(c as unknown as { doFetch: () => Promise<Response> }, 'doFetch').mockResolvedValue({
      status: 200,
      headers: { get: () => null },
    } as Response)

    await c.safeFetch('https://example.com/ok', {}, 'OpenAPI request')
    expect(lookups).toEqual(['203.0.113.8'])
  })
})
