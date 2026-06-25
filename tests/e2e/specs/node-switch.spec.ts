import { test, expect } from '@playwright/test'
import { api } from '../helpers/api'

/**
 * E2E: Multi-node cluster node switching
 * Requires a project with multiple nodes in a cluster.
 */
test('node-switch: switch between nodes in a cluster', async ({ page }) => {
  // Get projects from backend
  const projectsResult = await api.getProjects()
  expect(projectsResult.success).toBeTruthy()

  const projects = projectsResult.projects ?? []
  if (projects.length === 0) {
    test.skip('No project available for node switch test')
    return
  }

  const project = projects[0]
  if (!project.clusters || project.clusters.length === 0) {
    test.skip('No cluster available for node switch test')
    return
  }

  const cluster = project.clusters[0]
  if (!cluster.nodes || cluster.nodes.length < 2) {
    test.skip('Cluster has fewer than 2 nodes, skipping node switch test')
    return
  }

  // Navigate to cluster view
  await page.goto(`/cluster/${cluster.id}`)
  await page.waitForSelector(`text=${cluster.name}`, { timeout: 10000 })

  // Get cluster overview to see connected nodes
  const overview = await api.getClusterOverview(cluster.id)
  expect(overview.success).toBeTruthy()

  const nodes = overview.nodes ?? []
  if (nodes.length < 2) {
    test.skip('Cluster overview shows fewer than 2 nodes')
    return
  }

  // Find two different nodes
  const node1 = nodes[0]
  const node2 = nodes[1]

  // Activate first node
  const activateResult1 = await api.activateNode(node1.id)
  expect(activateResult1.success).toBeTruthy()

  // Switch to second node
  const activateResult2 = await api.activateNode(node2.id)
  expect(activateResult2.success).toBeTruthy()

  // Both activations should succeed independently
  expect(node1.id).not.toBe(node2.id)
})