export interface Column {
  Name: string
  Type: number
}

export interface ExecuteResult {
  Columns: Column[]
  Rows: Record<string, string>[]
  CommandTag: string
  Error: string
  ErrorDetail: Record<string, string>
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