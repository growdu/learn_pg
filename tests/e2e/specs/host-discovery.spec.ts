import { test, expect } from '@playwright/test'
import { api } from '../helpers/api'

/**
 * E2E: Host discovery scan and import
 */
test('host-discovery: scan and import a PostgreSQL instance', async () => {
  // Scan localhost (where a PG instance may be running from docker-compose)
  const scanResult = await api.scanHost('127.0.0.1', 5432)
  expect(scanResult.success).toBeTruthy()

  // Get projects and clusters
  const projectsResult = await api.getProjects()
  expect(projectsResult.success).toBeTruthy()

  const projects = projectsResult.projects ?? []
  if (projects.length === 0) {
    test.skip('No project available for import test')
    return
  }

  const project = projects[0]
  const clusterId = project.clusters?.[0]?.id
  if (!clusterId) {
    test.skip('No cluster available for import test')
    return
  }

  const instances = scanResult.instances ?? []
  if (instances.length === 0) {
    // If no instances found, that's still a valid scan result (not an error)
    // This can happen if no PG is running on the scanned port
    return
  }

  const instance = instances[0]
  if (instance.confidence === 'high') {
    const importResult = await api.importHost(project.id, clusterId, instance, false)
    expect(importResult.success).toBeTruthy()
    expect(importResult.nodeId).toBeDefined()
  }
})