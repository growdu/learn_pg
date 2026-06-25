import { execSync } from 'child_process'
import * as path from 'path'

/**
 * Global teardown: stop and clean up docker-compose.e2e.yml services
 */
export default async function globalTeardown() {
  const composeFile = path.resolve(__dirname, '../../docker-compose.e2e.yml')
  try {
    execSync(`docker compose -f ${composeFile} down`, {
      cwd: path.dirname(composeFile),
      stdio: 'pipe',
    })
  } catch {
    // Ignore errors during teardown
  }
}