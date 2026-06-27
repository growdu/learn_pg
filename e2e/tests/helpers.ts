/**
 * Inline helpers for learn_pg E2E tests.
 * Spec files use Playwright's built-in `request` fixture (APIRequestContext) directly.
 */

import type { APIRequestContext } from '@playwright/test'

export type { APIRequestContext }
export { expect } from '@playwright/test'

export interface TaskStatus {
  taskId: string
  status: string
  progress: number
  message?: string
  clusterId?: string
}

// ─── Inline helpers (take APIRequestContext as parameter) ─────────────────────

export async function waitForTask(
  api: APIRequestContext,
  taskId: string,
  timeout = 90_000,
  interval = 3000,
): Promise<TaskStatus> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const res = await api.get(`/api/provision/tasks/${taskId}`)
    if (res.ok()) {
      const data = (await res.json()) as { success: boolean; task: TaskStatus }
      if (data.success && data.task) {
        const t = data.task
        if (t.status === 'success' || t.status === 'failed') {
          return { taskId, status: t.status, progress: t.progress, message: t.message, clusterId: t.clusterId }
        }
      }
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`task ${taskId} did not complete within ${timeout}ms`)
}

export async function createProject(api: APIRequestContext, name: string): Promise<string> {
  const id = `e2e-proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const res = await api.post('/api/projects', { data: { id, name } })
  if (!res.ok()) throw new Error(`create project failed: ${res.status()} ${await res.text()}`)
  return id
}

export async function deleteProject(api: APIRequestContext, projectId: string): Promise<void> {
  await api.delete(`/api/projects/${projectId}`)
}

export async function listProjects(api: APIRequestContext): Promise<Array<{ id: string; name: string }>> {
  const res = await api.get('/api/projects')
  if (!res.ok()) throw new Error(`list projects failed: ${res.status()}`)
  const data = (await res.json()) as { projects: Array<{ id: string; name: string }> }
  return data.projects ?? []
}

export async function getProject(api: APIRequestContext, projectId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`/api/projects/${projectId}`)
  if (!res.ok()) throw new Error(`get project failed: ${res.status()}`)
  const data = await res.json() as { project: Record<string, unknown>; success: boolean }
  return data.project
}

export async function provisionSingle(
  api: APIRequestContext,
  projectId: string,
  clusterName = 'e2e-single',
): Promise<{ taskId: string }> {
  const res = await api.post('/api/provision/single', {
    data: {
      projectId,
      clusterName,
      template: 'single',
      runtime: { type: 'docker', pgVersion: '16' },
      providerType: 'docker',
    },
  })
  if (!res.ok()) throw new Error(`provision/single failed: ${res.status()} ${await res.text()}`)
  const data = (await res.json()) as { success: boolean; taskId: string; error?: string }
  if (!data.success) throw new Error(`provision failed: ${data.error}`)
  return { taskId: data.taskId }
}

/**
 * Teardown a cluster: stops any Docker containers it provisioned and removes
 * the cluster from the workspace. Safe to call even if the cluster is already
 * gone — the API returns 404 in that case, which we ignore.
 */
export async function teardownCluster(
  api: APIRequestContext,
  clusterId: string,
  cleanupData = true,
): Promise<void> {
  if (!clusterId) return
  const res = await api.post(`/api/clusters/${clusterId}/teardown`, {
    data: { cleanupData },
  })
  if (!res.ok() && res.status() !== 404) {
    // Best-effort cleanup; log but don't fail the test
    // eslint-disable-next-line no-console
    console.warn(`teardown ${clusterId} returned ${res.status()}: ${await res.text()}`)
  }
}

export async function listProvisionTasks(
  api: APIRequestContext,
): Promise<{ count: number; tasks: Array<{ taskId: string; status: string }> }> {
  const res = await api.get('/api/provision/tasks')
  if (!res.ok()) throw new Error(`list tasks failed: ${res.status()}`)
  return res.json()
}

export async function validateDSN(
  api: APIRequestContext,
  dsn: string,
): Promise<{ success: boolean; reachable: boolean; version?: string; error?: string }> {
  const res = await api.post('/api/discovery/dsn/validate', { data: { dsn } })
  if (!res.ok()) throw new Error(`dsn/validate request failed: ${res.status()}`)
  return res.json()
}

export async function importDSN(
  api: APIRequestContext,
  projectId: string,
  clusterId: string,
  dsn: string,
): Promise<{ success: boolean; nodeId?: string; error?: string }> {
  const res = await api.post('/api/discovery/dsn/import', {
    data: { projectId, clusterId, dsn, autoConnect: false },
  })
  if (!res.ok()) throw new Error(`dsn/import request failed: ${res.status()} ${await res.text()}`)
  return res.json()
}

export async function hostScan(
  api: APIRequestContext,
  host: string,
  port = 5432,
): Promise<{ success: boolean; instances: Array<{ host: string; port: number; confidence: string }> }> {
  const res = await api.post('/api/discovery/host/scan', {
    data: { host, ssh: { port } },
  })
  if (!res.ok()) throw new Error(`host/scan failed: ${res.status()}`)
  return res.json()
}
