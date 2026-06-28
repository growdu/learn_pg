// src/lib/api.ts
//
// Thin wrapper around fetch() that the rest of the frontend uses
// instead of calling fetch() directly. Responsibilities:
//
//   - URL composition (base URL + path, never hard-coded relative
//     paths in components).
//   - JSON encoding and decoding with a typed envelope.
//   - Timeout via AbortController so a hung backend can't stall a
//     React state update forever.
//   - Automatic retry on transient failures: 5xx, 408, 429, and
//     network errors. Exponential backoff with jitter so two
//     components that fail together don't retry in lock-step.
//   - Request-ID header injection (X-Request-Id) so a server-side
//     log entry can be correlated with a frontend error report.
//   - A uniform `ApiError` class so callers can match on type
//     instead of parsing strings.
//
// This file deliberately has zero React dependencies so it can be
// unit-tested with plain vitest.

import { addBreadcrumb } from './errorReporter'

/** Configuration for the API client. Most apps only need baseUrl. */
export interface ApiClientOptions {
  /** Base URL, e.g. "http://localhost:3010". No trailing slash. */
  baseUrl: string
  /** Default timeout per request, ms. Defaults to 15_000. */
  defaultTimeoutMs?: number
  /** Maximum number of retry attempts (after the first try). Defaults to 3. */
  maxRetries?: number
  /** Base delay for exponential backoff, ms. Defaults to 250. */
  baseBackoffMs?: number
  /** Cap on the backoff delay, ms. Defaults to 4_000. */
  maxBackoffMs?: number
  /** Optional hook to mint a per-request ID. Defaults to crypto.randomUUID. */
  requestIdFactory?: () => string
  /** Optional hook called before each retry; useful for telemetry. */
  onRetry?: (info: RetryInfo) => void
}

export interface RetryInfo {
  attempt: number // 1-based: 1 = first retry
  url: string
  method: string
  status?: number
  delayMs: number
  error?: string
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD'
  body?: unknown
  /** Per-request timeout override, ms. */
  timeoutMs?: number
  /** Set false to disable retries for this request. Defaults to true. */
  retry?: boolean
  /** Override the retry count for this request. */
  maxRetries?: number
  /** Extra headers, merged on top of the defaults. */
  headers?: Record<string, string>
  /** Signal from the caller (e.g. from a useEffect cleanup). */
  signal?: AbortSignal
}

/** Default JSON envelope returned by the backend. */
export interface ApiEnvelope<T> {
  success: boolean
  message?: string
  error?: string
  data?: T
  // Some endpoints (e.g. /version) return a flat object. The
  // generic caller can still `as` to whatever shape they need.
  [k: string]: unknown
}

/** Thrown for non-2xx responses and network errors. */
export class ApiError extends Error {
  readonly status: number
  readonly url: string
  readonly method: string
  readonly requestId?: string
  readonly cause?: unknown

  constructor(args: {
    message: string
    status: number
    url: string
    method: string
    requestId?: string
    cause?: unknown
  }) {
    super(args.message)
    this.name = 'ApiError'
    this.status = args.status
    this.url = args.url
    this.method = args.method
    this.requestId = args.requestId
    this.cause = args.cause
  }

  /** True for status codes the wrapper will retry automatically. */
  get isRetryable(): boolean {
    if (this.status === 0) return true // network error
    if (this.status === 408) return true
    if (this.status === 429) return true
    return this.status >= 500 && this.status < 600
  }
}

/** Internal: minimal set of fields a retryable HTTP outcome can carry. */
type FetchOutcome =
  | { kind: 'ok'; response: Response; text: string }
  | { kind: 'http-error'; response: Response; text: string }
  | { kind: 'network-error'; error: unknown }

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_BACKOFF_MS = 250
const DEFAULT_MAX_BACKOFF_MS = 4_000

/** Build the API client. */
export function createApiClient(opts: ApiClientOptions) {
  const cfg = {
    defaultTimeoutMs: opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseBackoffMs: opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs: opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    requestIdFactory: opts.requestIdFactory ?? defaultRequestIdFactory,
    onRetry: opts.onRetry,
    baseUrl: opts.baseUrl.replace(/\/+$/, ''),
  }

  /**
   * Make an HTTP request and parse the response.
   *
   * Returns the parsed JSON body. For requests where the backend
   * doesn't return a JSON body (e.g. 204), returns `undefined`.
   */
  async function request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? 'GET'
    const url = joinUrl(cfg.baseUrl, path)
    const retryEnabled = options.retry !== false
    const maxRetries = options.maxRetries ?? cfg.maxRetries
    const attemptTimeout = options.timeoutMs ?? cfg.defaultTimeoutMs

    let lastError: ApiError | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), attemptTimeout)
      // Compose caller-provided signal with our internal one so a
      // parent unmount cancels the in-flight fetch too.
      if (options.signal) {
        if (options.signal.aborted) controller.abort()
        else options.signal.addEventListener('abort', () => controller.abort())
      }

      const requestId = cfg.requestIdFactory()
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Request-Id': requestId,
        ...options.headers,
      }
      addBreadcrumb({
        type: 'fetch',
        message: `${method} ${path} (attempt ${attempt + 1})`,
        data: { requestId, attempt: attempt + 1, method, url },
      })
      let body: BodyInit | undefined
      if (options.body !== undefined) {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      }

      const outcome = await runFetch(url, method, headers, body, controller.signal)
      clearTimeout(timer)

      if (outcome.kind === 'ok') {
        return parseBody<T>(outcome.response, outcome.text)
      }

      if (outcome.kind === 'http-error') {
        const status = outcome.response.status
        const text = outcome.text
        let parsed: unknown
        try {
          parsed = text ? JSON.parse(text) : undefined
        } catch {
          parsed = undefined
        }
        const message = extractMessage(parsed, status, text)
        const err = new ApiError({
          message,
          status,
          url,
          method,
          requestId,
        })
        lastError = err
        const isRetryable = retryEnabled && attempt < maxRetries && err.isRetryable
        if (!isRetryable) {
          addBreadcrumb({
            type: 'fetch',
            level: 'error',
            message: `${method} ${path} failed: ${status} ${message}`,
            data: { requestId, status, url },
          })
          throw err
        }
      } else {
        // network / abort
        const err = new ApiError({
          message: describeNetworkError(outcome.error),
          status: 0,
          url,
          method,
          requestId,
          cause: outcome.error,
        })
        lastError = err
        const isRetryable =
          retryEnabled && attempt < maxRetries && !(options.signal?.aborted === true)
        if (!isRetryable) {
          addBreadcrumb({
            type: 'fetch',
            level: options.signal?.aborted ? 'info' : 'error',
            message: options.signal?.aborted
              ? `${method} ${path} aborted`
              : `${method} ${path} network error: ${err.message}`,
            data: { requestId, url, aborted: options.signal?.aborted === true },
          })
          throw err
        }
      }

      // We get here only when we'll retry.
      const delayMs = backoff(attempt, cfg.baseBackoffMs, cfg.maxBackoffMs)
      cfg.onRetry?.({
        attempt: attempt + 1,
        url,
        method,
        status: lastError.status,
        delayMs,
        error: lastError.message,
      })
      await sleep(delayMs)
    }

    // Unreachable: the loop either returns or throws on the final
    // iteration. If we somehow fall through, surface the last
    // error rather than returning undefined.
    throw lastError ?? new Error('api: retry loop exited without throwing')
  }

  return {
    request,
    get: <T = unknown>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'GET' }),
    post: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'POST', body }),
    put: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'PUT', body }),
    delete: <T = unknown>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'DELETE' }),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

// ---------- helpers ----------

async function runFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: BodyInit | undefined,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal,
      // Don't let the browser cache our JSON API responses by
      // default. Components that want caching can opt in.
      cache: 'no-store',
      credentials: 'same-origin',
    })
    const text = await response.text()
    if (response.ok) {
      return { kind: 'ok', response, text }
    }
    return { kind: 'http-error', response, text }
  } catch (e) {
    return { kind: 'network-error', error: e }
  }
}

function parseBody<T>(response: Response, text: string): T {
  if (response.status === 204 || text.length === 0) {
    return undefined as unknown as T
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new ApiError({
      message: `api: response was not valid JSON: ${(e as Error).message}`,
      status: response.status,
      url: response.url,
      method: '', // filled by the caller (parseBody doesn't know it)
    })
  }
}

function extractMessage(parsed: unknown, status: number, text: string): string {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of ['error', 'message', 'detail']) {
      if (typeof o[k] === 'string' && o[k]) return o[k] as string
    }
  }
  if (text && text.length < 500) return `${status}: ${text}`
  return `HTTP ${status}`
}

function describeNetworkError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return 'Request aborted (timeout or caller cancellation)'
  }
  if (e instanceof Error) return e.message
  return String(e)
}

function backoff(attempt: number, base: number, cap: number): number {
  // Full-jitter: random in [0, min(cap, base * 2^attempt)]. Better
  // than deterministic backoff under thundering-herd conditions.
  const exp = Math.min(cap, base * 2 ** attempt)
  return Math.floor(Math.random() * exp)
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) path = '/' + path
  return base + path
}

function defaultRequestIdFactory(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for older browsers / test environments without
  // crypto.randomUUID. Sufficient for correlation, not for security.
  return 'req-' + Math.random().toString(36).slice(2, 12)
}

/** Default singleton, lazily constructed from VITE_API_BASE_URL. */
let _defaultClient: ApiClient | null = null
// Convenience alias used by client-side modules that don't want
// to thread a client through props. Returns the process-wide
// singleton created by getDefaultApiClient.
export function getApiClient(): ApiClient {
  return getDefaultApiClient()
}

export function getDefaultApiClient(): ApiClient {
  if (_defaultClient) return _defaultClient
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
  _defaultClient = createApiClient({ baseUrl })
  return _defaultClient
}
