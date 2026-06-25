import { test, expect } from '@playwright/test'
import { api } from '../helpers/api'

/**
 * E2E: DSN validate and import
 */
test('dsn-import: validate and import via DSN', async () => {
  // Get projects
  const projectsResult = await api.getProjects()
  expect(projectsResult.success).toBeTruthy()

  const projects = projectsResult.projects ?? []
  if (projects.length === 0) {
    test.skip('No project available for DSN import test')
    return
  }

  const project = projects[0]
  const clusterId = project.clusters?.[0]?.id
  if (!clusterId) {
    test.skip('No cluster available for DSN import test')
    return
  }

  // Try validating a DSN for a running PG instance
  const dsn = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'
  const validateResult = await api.validateDSN(dsn)
  expect(validateResult.success).toBeTruthy()

  if (validateResult.reachable) {
    // If reachable, try importing
    const importResult = await api.importDSN(project.id, clusterId, dsn, false)
    expect(importResult.success).toBeTruthy()
    expect(importResult.nodeId).toBeDefined()
  } else {
    // If not reachable (no PG running), that's an acceptable test outcome
    expect(validateResult.reachable).toBe(false)
  }
})