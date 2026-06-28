// src/lib/api.test.ts
//
// Unit tests for the api client. These run with vitest + jsdom;
// the test harness exposes a fetch mock via globalThis.fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient, type RetryInfo } from './api'

interface MockResponseInit {
  status?: number
  body?: string
  headers?: Record<string, string>
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200
  const body = init.body ?? '{}'
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  // @ts-expect-error - override for tests
  globalThis.fetch = fetchMock
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createApiClient', () => {
  it('returns parsed JSON for 2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{"ok":true,"n":42}' }))
    const c = createApiClient({ baseUrl: 'http://x' })
    const out = await c.get<{ ok: boolean; n: number }>('/foo')
    expect(out).toEqual({ ok: true, n: 42 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('composes URL from baseUrl + path, including leading slash', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x' })
    await c.get('foo')
    expect(fetchMock.mock.calls[0][0]).toBe('http://x/foo')
  })

  it('strips trailing slash on baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x/' })
    await c.get('/foo')
    expect(fetchMock.mock.calls[0][0]).toBe('http://x/foo')
  })

  it('passes through absolute URLs unchanged', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x' })
    await c.get('https://elsewhere/y')
    expect(fetchMock.mock.calls[0][0]).toBe('https://elsewhere/y')
  })

  it('sends X-Request-Id and JSON content-type for POST', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{"success":true}' }))
    const c = createApiClient({
      baseUrl: 'http://x',
      requestIdFactory: () => 'req-test',
    })
    await c.post('/y', { hello: 'world' })
    const call = fetchMock.mock.calls[0]
    expect(call[1].method).toBe('POST')
    expect(call[1].headers['Content-Type']).toBe('application/json')
    expect(call[1].headers['X-Request-Id']).toBe('req-test')
    expect(call[1].body).toBe('{"hello":"world"}')
  })

  it('throws ApiError on 4xx with backend error message', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 400, body: '{"error":"bad sql"}' }),
    )
    const c = createApiClient({ baseUrl: 'http://x', maxRetries: 0 })
    await expect(c.get('/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'bad sql',
    })
  })

  it('falls back to a message containing the status code when body parses but has no error field', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x', maxRetries: 0 })
    await expect(c.get('/x')).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('500'),
    })
  })

  it('retries on 5xx with exponential backoff up to maxRetries', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 503, body: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 503, body: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{"ok":1}' }))

    const sleeps: number[] = []
    const c = createApiClient({
      baseUrl: 'http://x',
      maxRetries: 3,
      baseBackoffMs: 1, // make the test fast
      maxBackoffMs: 1,
      onRetry: (info: RetryInfo) => sleeps.push(info.delayMs),
    })
    const out = await c.get('/x')
    expect(out).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleeps).toHaveLength(2) // two retries
  })

  it('does not retry on 4xx (except 408/429)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404, body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x', maxRetries: 3 })
    await expect(c.get('/x')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 (rate-limited)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 429, body: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{"ok":1}' }))
    const c = createApiClient({
      baseUrl: 'http://x',
      maxRetries: 3,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const out = await c.get('/x')
    expect(out).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries on network error', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(mockResponse({ body: '{"ok":1}' }))
    const c = createApiClient({
      baseUrl: 'http://x',
      maxRetries: 3,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    })
    const out = await c.get('/x')
    expect(out).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry when caller disables retries via opts', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x', maxRetries: 3 })
    await expect(c.get('/x', { retry: false })).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('respects caller-provided signal cancellation', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const c = createApiClient({ baseUrl: 'http://x', maxRetries: 0 })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 5)
    await expect(c.get('/x', { signal: ac.signal })).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      message: expect.stringContaining('aborted'),
    })
  })

  it('returns undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const c = createApiClient({ baseUrl: 'http://x' })
    const out = await c.delete('/x/1')
    expect(out).toBeUndefined()
  })

  it('does not auto-add Content-Type when body is absent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x' })
    await c.get('/x')
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('merges caller headers on top of defaults', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{}' }))
    const c = createApiClient({ baseUrl: 'http://x' })
    await c.get('/x', { headers: { 'X-Custom': 'yes', Accept: 'text/plain' } })
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Custom']).toBe('yes')
    expect(headers['Accept']).toBe('text/plain')
    expect(headers['X-Request-Id']).toBeTruthy()
  })
})
