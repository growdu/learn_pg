import { test, expect } from '@playwright/test'
import { createProject, deleteProject, listProjects, getProject } from './helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3001'
const API = `${BASE}/api`

// ─── Health check ─────────────────────────────────────────────────────────────

test('health: GET /api/health returns ok', async ({ request }) => {
  const res = await request.get(`${API}/health`)
  expect(res.ok()).toBeTruthy()
  const data = await res.json()
  expect(data.status).toBe('ok')
})

test('livez: GET /api/livez returns alive', async ({ request }) => {
  const res = await request.get(`${API}/livez`)
  expect(res.ok()).toBeTruthy()
  const data = await res.json()
  expect(data.status).toBe('alive')
})

// ─── Project CRUD ─────────────────────────────────────────────────────────────

test('workspace: create and retrieve project', async ({ request }) => {
  const id = await createProject(request, 'e2e-create-retrieve')
  try {
    const data = await getProject(request, id)
    expect(data.id).toBe(id)
    expect(data.name).toBe('e2e-create-retrieve')
  } finally {
    await deleteProject(request, id)
  }
})

test('workspace: created project appears in project list', async ({ request }) => {
  const id = await createProject(request, 'e2e-inclusion-test')
  try {
    const projects = await listProjects(request)
    const found = projects.some((p) => p.id === id)
    expect(found).toBe(true)
  } finally {
    await deleteProject(request, id)
  }
})

test('workspace: delete project removes it from list', async ({ request }) => {
  const id = await createProject(request, 'e2e-delete-test')
  await deleteProject(request, id)
  const projects = await listProjects(request)
  const found = projects.some((p) => p.id === id)
  expect(found).toBe(false)
})

test('workspace: list projects returns array', async ({ request }) => {
  const projects = await listProjects(request)
  expect(Array.isArray(projects)).toBe(true)
})

test('workspace: get non-existent project returns 404', async ({ request }) => {
  const res = await request.get(`${API}/projects/does-not-exist`)
  expect(res.status()).toBe(404)
})
