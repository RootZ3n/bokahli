/**
 * A scan worker that handshakes correctly and then dies on demand.
 *
 * Exists so the pool's crash-recovery path is exercised by an actual worker
 * exit rather than inferred. A recovery path nothing runs is a recovery path
 * nobody knows works, and "the process did not crash" is not something to find
 * out during a deployment.
 *
 * It announces the *real* engine identity, so it passes the registry handshake
 * exactly as the production worker does; the only difference is what it does
 * with a job.
 */
import { parentPort } from 'node:worker_threads';
import { engineIdentity } from '../../dist/trust.js';

const engine = engineIdentity();
parentPort.postMessage({
  type: 'ready',
  detectorVersion: engine.detectorVersion,
  registryPayloadSha256: engine.registryPayloadSha256,
  registryVersion: engine.registryVersion,
  patternCount: engine.patternCount,
});

parentPort.on('message', (job) => {
  // Any job at all takes the worker down, the way an out-of-memory kill or a
  // native fault would: no result, no error event, just an exit.
  void job;
  process.exit(7);
});
