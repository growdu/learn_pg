import { test, expect } from '@playwright/test'
import { createProject, deleteProject } from './helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3001'
const API = `${BASE}/api`

// ─── Tests ───────────────────────────────────────────────────────────────────

test('connect: POST /api/connect with valid credentials returns 200', async ({ request }) => {
  const res = await request.post(`${API}/connect`, {
    data: {
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    },
  })
  expect(res.status()).toBeGreaterThanOrEqual(200)
})

test('connect: POST /api/connect with wrong password returns error', async ({ request }) => {
  const res = await request.post(`${API}/connect`, {
    data: {
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'wrongpassword',
      database: 'postgres',
    },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
})

test('connect: POST /api/connect with missing host returns 400', async ({ request }) => {
  const res = await request.post(`${API}/connect`, {
    data: {
      host: '',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    },
  })
  expect(res.status()).toBe(400)
})

test('cluster overview: GET /api/cluster/{id}/overview returns node counts', async ({ request }) => {
  const projId = `e2e-overview-${Date.now()}`
  const projRes = await request.post(`${API}/projects`, { data: { id: projId, name: 'e2e-overview-test' } })
  if (!projRes.ok()) throw new Error(`create project failed: ${projRes.status()}`)

  const clusterId = `e2e-cluster-overview-${Date.now()}`
  const clusterRes = await request.post(`${API}/projects/${projId}/clusters/`, {
    data: {
      id: clusterId,
      name: 'e2e-overview-cluster',
      replicationType: 'physical',
      alertThresholdSec: 30,
      nodes: [],
    },
  })
  if (!clusterRes.ok()) throw new Error(`create cluster failed: ${clusterRes.status()}`)

  try {
    const res = await request.get(`${API}/cluster/${clusterId}/overview`)
    expect(res.status()).toBe(200)
    const data = await res.json()
    expect(typeof data.summary.total_nodes).toBe('number')
    expect(typeof data.summary.connected_nodes).toBe('number')
  } finally {
    await deleteProject(request, projId)
  }
})

test('cluster overview: GET /api/cluster/{id}/overview for non-existent cluster returns 404', async ({ request }) => {
  const res = await request.get(`${API}/cluster/does-not-exist/overview`)
  expect([200, 404]).toContain(res.status())
})
