import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Global setup: ensure Docker is running and start docker-compose.e2e.yml
 */
export default async function globalSetup() {
  // Check if Docker is available
  try {
    execSync('docker info', { stdio: 'pipe' })
  } catch {
    throw new Error('Docker is not available. E2E tests require Docker.')
  }

  const composeFile = path.resolve(__dirname, '../../docker-compose.e2e.yml')
  if (!fs.existsSync(composeFile)) {
    throw new Error(`docker-compose.e2e.yml not found at ${composeFile}`)
  }

  // Start the E2E test services
  execSync(`docker compose -f ${composeFile} up -d`, {
    cwd: path.dirname(composeFile),
    stdio: 'inherit',
  })
}