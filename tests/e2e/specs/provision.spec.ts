import { test, expect } from '@playwright/test'
import { api } from '../helpers/api'

/**
 * E2E: Single node provision via /api/provision/single
 * Requires Docker to be available for real PG container provision.
 */
test('provision: single node provision succeeds', async () => {
  // Create a minimal project first
  const projectResult = await api.getProjects()
  expect(projectResult.success).toBeTruthy()

  const projects = projectResult.projects ?? []
  if (projects.length === 0) {
    // Create a project first
    const newProject = {
      id: `e2e-project-${Date.now()}`,
      name: 'E2E 测试项目',
      clusters: [],
      components: [],
    }
    await api.createProject(newProject)
  }

  const projectId = projects[0]?.id ?? `e2e-project-${Date.now()}`

  // Call provision single
  const result = await api.provisionSingle(projectId, `e2e-cluster-${Date.now()}`, 'docker')
  expect(result.success).toBeTruthy()
  expect(result.clusterId).toBeDefined()
  expect(result.taskId).toBeDefined()

  // Wait for task to complete
  let taskResult: any = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    taskResult = await api.getProvisionTask(result.taskId)
    if (taskResult.task?.status === 'success' || taskResult.task?.status === 'failed') break
  }

  expect(taskResult.task?.status).toBe('success')
})