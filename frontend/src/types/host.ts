export interface WorkspaceHost {
  id: string
  name: string
  host: string
  port: number
  sshUser: string
  sshKey?: string
  createdAt: number
}
