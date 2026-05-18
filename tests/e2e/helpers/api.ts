const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080'

export interface DiscoveredInstance {
  host: string
  port: number
  version?: string
  service?: string
  confidence?: string
}

async function request(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${BACKEND_URL}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const data = await res.json()
  return data
}

export const api = {
  // Workspace
  async getProjects() {
    return request('/api/workspace/projects')
  },

  async createProject(project: any) {
    return request('/api/workspace/projects', {
      method: 'POST',
      body: JSON.stringify({ project }),
    })
  },

  // Provision
  async provisionSingle(projectId: string, clusterName: string, providerType = 'docker') {
    return request('/api/provision/single', {
      method: 'POST',
      body: JSON.stringify({ projectId, clusterName, providerType }),
    })
  },

  async getProvisionTask(taskId: string) {
    return request(`/api/provision/tasks/${taskId}`)
  },

  // Discovery
  async scanHost(host: string, port = 5432) {
    return request('/api/discovery/host/scan', {
      method: 'POST',
      body: JSON.stringify({ host, port }),
    })
  },

  async importHost(projectId: string, clusterId: string, instance: DiscoveredInstance, autoConnect = false) {
    return request('/api/discovery/host/import', {
      method: 'POST',
      body: JSON.stringify({ projectId, clusterId, instance, autoConnect }),
    })
  },

  async validateDSN(dsn: string) {
    return request('/api/discovery/dsn/validate', {
      method: 'POST',
      body: JSON.stringify({ dsn }),
    })
  },

  async importDSN(projectId: string, clusterId: string, dsn: string, autoConnect = false) {
    return request('/api/discovery/dsn/import', {
      method: 'POST',
      body: JSON.stringify({ projectId, clusterId, dsn, autoConnect }),
    })
  },

  // Cluster
  async getClusterOverview(clusterId: string) {
    return request(`/api/cluster/${clusterId}/overview`)
  },

  // Nodes
  async activateNode(nodeId: string) {
    return request(`/api/nodes/${nodeId}/activate`, { method: 'POST' })
  },

  // Connect
  async connect(host: string, port: number, user: string, password: string, database: string) {
    return request('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ host, port, user, password, database }),
    })
  },
}