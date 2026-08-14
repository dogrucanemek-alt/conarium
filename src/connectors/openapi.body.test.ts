/**
 * G20 L9 — OpenAPI body is capped before JSON.parse (50KB, same as the query payload cap).
 */
import { describe, expect, it, vi } from 'vitest'
import { OpenApiConnector } from './openapi.js'

function connector() {
  return new OpenApiConnector({
    type: 'openapi',
    name: 'api',
    description: 'fixture',
    config: { allowedBaseUrls: 'https://example.com', baseUrl: 'https://example.com' },
  })
}

describe('G20 L9 OpenAPI body cap', () => {
  it('rejects a response body over 50KB before parsing JSON', async () => {
    const c = connector()
    ;(c as unknown as { endpoints: Array<{ method: string; path: string }> }).endpoints = [
      { method: 'GET', path: '/big' },
    ]
    const huge = JSON.stringify({ pad: 'x'.repeat(60 * 1024) })
    expect(Buffer.byteLength(huge)).toBeGreaterThan(50 * 1024)
    vi.spyOn(c, 'safeFetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => Buffer.from(huge),
      json: async () => JSON.parse(huge),
    } as unknown as Response)

    await expect(c.query('GET /big')).rejects.toThrow(/50KB|body exceeds/)
  })

  it('parses a body under the 50KB cap', async () => {
    const c = connector()
    ;(c as unknown as { endpoints: Array<{ method: string; path: string }> }).endpoints = [
      { method: 'GET', path: '/ok' },
    ]
    const small = JSON.stringify({ id: 1 })
    vi.spyOn(c, 'safeFetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => Buffer.from(small),
      json: async () => {
        throw new Error('json() must not be used — cap the body first')
      },
    } as unknown as Response)

    const out = await c.query('GET /ok')
    expect(out.rows).toEqual([{ id: 1 }])
  })
})
