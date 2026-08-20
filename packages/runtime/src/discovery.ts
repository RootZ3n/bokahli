import { readdir, readFile } from 'node:fs/promises';

/**
 * Find the pids of our own loopback backend.
 *
 * Scans /proc directly rather than shelling out to `ss`: the service runs with
 * a minimal PATH and restricted environment, and an unresolved helper here
 * silently degrades into "every request is a capacity failure". Matching on
 * argv is dependency-free and same-uid readable.
 *
 * This is re-run rather than cached because the backend can restart underneath
 * a running API — that is the whole point of decoupling their lifecycles. A pid
 * learned at startup is wrong the moment the runtime restarts, and a stale pid
 * makes our own inference server look like a competing GPU consumer.
 */
export async function findBackendPids(baseUrl: string): Promise<readonly number[]> {
  const port = new URL(baseUrl).port;
  const entries = await readdir('/proc');
  const pids: number[] = [];

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let argv: string;
    try {
      argv = await readFile(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue; // process exited, or not ours to read
    }
    const args = argv.split('\0');
    if (args.some((a) => a.endsWith('llama-server')) && args.includes(port)) {
      pids.push(Number(name));
    }
  }
  return pids;
}
