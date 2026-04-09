export interface Column {
  name: string
  type: number
}

export interface ExecuteResult {
  columns: Column[]
  rows: Record<string, string>[]
  commandTag: string
  error?: string
  errorDetail?: Record<string, string>
}

export interface ExecuteResponse {
  success: boolean
  result: ExecuteResult
  error: string
}

export interface ConnectResponse {
  success: boolean
  message: string
  version: string
  data_dir: string
}

export interface HealthResponse {
  status: string
  pg_connected: boolean
}
