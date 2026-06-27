import { test, expect } from '@playwright/test'
import {
  createProject,
  deleteProject,
  provisionSingle,
  teardownCluster,
  waitForTask,
  listProvisionTasks,
} from './helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3001'
const API = `${BASE}/api`

// ─── Tests ───────────────────────────────────────────────────────────────────

test('provision: POST /api/provision/single returns taskId', async ({ request }) => {
  const projectId = await createProject(request, 'e2e-provision-test')
  let clusterId = ''
  try {
    const { taskId } = await provisionSingle(request, projectId, 'e2e-single-test')
    expect(taskId).toBeTruthy()
    expect(typeof taskId).toBe('string')
    expect(taskId.length).toBeGreaterThan(0)
    // Wait for the task so we can teardown the container in the finally block
    const result = await waitForTask(request, taskId)
    clusterId = result.clusterId ?? ''
  } finally {
    await teardownCluster(request, clusterId)
    await deleteProject(request, projectId)
  }
})

test('provision: task completes with success or failed status', async ({ request }) => {
  const projectId = await createProject(request, 'e2e-provision-task-test')
  let clusterId = ''
  try {
    const { taskId } = await provisionSingle(request, projectId, 'e2e-task-status-test')
    const result = await waitForTask(request, taskId)
    clusterId = result.clusterId ?? ''
    expect(['success', 'failed']).toContain(result.status)
    if (result.status === 'failed') {
      expect(result.message).toBeTruthy()
    }
  } finally {
    await teardownCluster(request, clusterId)
    await deleteProject(request, projectId)
  }
})

test('provision: completed task appears in task list', async ({ request }) => {
  const projectId = await createProject(request, 'e2e-task-list-test')
  let clusterId = ''
  try {
    const { taskId } = await provisionSingle(request, projectId, 'e2e-task-list-test')
    const result = await waitForTask(request, taskId)
    clusterId = result.clusterId ?? ''
    const list = await listProvisionTasks(request)
    const found = list.tasks.some((t) => t.taskId === taskId)
    expect(found).toBe(true)
  } finally {
    await teardownCluster(request, clusterId)
    await deleteProject(request, projectId)
  }
})

test('provision: GET /api/provision/tasks/{id} returns task data', async ({ request }) => {
  const projectId = await createProject(request, 'e2e-get-task-test')
  let clusterId = ''
  try {
    const { taskId } = await provisionSingle(request, projectId, 'e2e-get-task-test')
    const result = await waitForTask(request, taskId)
    clusterId = result.clusterId ?? ''
    const res = await request.get(`${API}/provision/tasks/${taskId}`)
    expect(res.ok()).toBeTruthy()
    const data = await res.json()
    expect(data.success).toBe(true)
    expect(data.task.taskId).toBe(taskId)
    expect(['success', 'failed']).toContain(data.task.status)
  } finally {
    await teardownCluster(request, clusterId)
    await deleteProject(request, projectId)
  }
})

test('provision: provision fails without projectId', async ({ request }) => {
  const res = await request.post(`${API}/provision/single`, {
    data: {
      projectId: '',
      clusterName: 'e2e-no-project',
      template: 'single',
      runtime: { type: 'docker' },
    },
  })
  expect(res.status()).toBe(400)
})

test('provision: list provision tasks returns array with summary', async ({ request }) => {
  const list = await listProvisionTasks(request)
  expect(Array.isArray(list.tasks)).toBe(true)
  expect(typeof list.count).toBe('number')
})
