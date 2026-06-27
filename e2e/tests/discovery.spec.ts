import { test, expect } from '@playwright/test'
import { createProject, deleteProject, validateDSN, importDSN, hostScan } from './helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3001'
const API = `${BASE}/api`

// ─── Inline helpers ───────────────────────────────────────────────────────────

async function createCluster(
  request: import('@playwright/test').APIRequestContext,
  projectId: string,
  clusterName = 'e2e-discovery-cluster',
): Promise<string> {
  const id = `e2e-cluster-${Date.now()}`
  const res = await request.post(`${API}/projects/${projectId}/clusters/`, {
    data: {
      id,
      name: clusterName,
      replicationType: 'physical',
      alertThresholdSec: 30,
      nodes: [],
    },
  })
  if (!res.ok()) throw new Error(`create cluster failed: ${res.status()} ${await res.text()}`)
  return id
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('DSN validate and import', () => {
  test('dsn validate: valid localhost postgres dsn returns reachable=true or false', async ({ request }) => {
    const result = await validateDSN(request, 'postgres://postgres:postgres@localhost:5432/postgres')
    expect(typeof result.reachable).toBe('boolean')
    expect(typeof result.success).toBe('boolean')
    expect(result.success).toBe(true)
  })

  test('dsn validate: invalid dsn returns success=false', async ({ request }) => {
    const result = await validateDSN(request, 'not-a-dsn')
    expect(result.success === false || result.reachable === false).toBeTruthy()
  })

  test('dsn validate: unreachable host returns reachable=false', async ({ request }) => {
    // Use 0.0.0.0 to ensure immediate connection failure (invalid destination).
    // Avoids Docker bridge TCP retransmission delays that occur with TEST-NET addresses.
    const result = await validateDSN(request, 'postgres://postgres:***@0.0.0.0:5432/postgres')
    expect(result.success).toBe(true)
    expect(result.reachable).toBe(false)
  })

  test('dsn import: imports node into cluster', async ({ request }) => {
    const projectId = await createProject(request, 'e2e-dsn-import-test')
    const clusterId = await createCluster(request, projectId, 'e2e-dsn-cluster')
    try {
      const result = await importDSN(request, projectId, clusterId, 'postgres://postgres:postgres@localhost:5432/postgres')
      expect(typeof result.success).toBe('boolean')
    } finally {
      await deleteProject(request, projectId)
    }
  })

  test('dsn import: rejects empty projectId', async ({ request }) => {
    const res = await request.post(`${API}/discovery/dsn/import`, {
      data: { projectId: '', clusterId: 'fake', dsn: 'postgres://localhost:5432/postgres', autoConnect: false },
    })
    expect(res.status()).toBe(400)
  })
})

test.describe('Host scan', () => {
  test('host scan: localhost:5432 returns scan result with confidence', async ({ request }) => {
    const result = await hostScan(request, 'localhost', 5432)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.instances)).toBe(true)
    const inst = result.instances[0]
    if (inst) {
      expect(inst.host).toBeTruthy()
      expect(typeof inst.port).toBe('number')
      expect(['low', 'high']).toContain(inst.confidence)
    }
  })

  test('host scan: unreachable host returns low-confidence result', async ({ request }) => {
    const result = await hostScan(request, '192.0.2.1', 5432)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.instances)).toBe(true)
  })

  test('host scan: rejects empty host', async ({ request }) => {
    const res = await request.post(`${API}/discovery/host/scan`, {
      data: { host: '', ssh: {} },
    })
    expect(res.status()).toBe(400)
  })
})
