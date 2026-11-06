// Test-only lifecycle: a Compose command ACK is not evidence of a new process.
// Keep the original container/volume, use one daemon start, and verify its incarnation.
export function createDependencyLifecycle({ project, service, compose, docker }) {
  if (
    !/^ctp-integration-\d+-[a-f0-9]{12}$/.test(project) ||
    !['postgres', 'redis'].includes(service)
  )
    throw new Error('DEPENDENCY_OWNERSHIP');
  let phase = 'NEW';
  let id;
  let originalStart;
  async function inspect() {
    const result = JSON.parse(await docker(['inspect', id]));
    const container = Array.isArray(result) && result.length === 1 ? result[0] : undefined;
    if (
      container?.Id !== id ||
      container?.Config?.Labels?.['com.docker.compose.project'] !== project ||
      container?.Config?.Labels?.['com.docker.compose.service'] !== service ||
      typeof container?.State?.StartedAt !== 'string' ||
      !Number.isFinite(Date.parse(container.State.StartedAt))
    )
      throw new Error('DEPENDENCY_OWNERSHIP');
    return container.State;
  }
  return {
    async stop() {
      if (phase !== 'NEW') throw new Error('DEPENDENCY_LIFECYCLE');
      phase = 'STOPPING';
      id = (await compose(['ps', '--all', '--quiet', service])).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('DEPENDENCY_OWNERSHIP');
      const before = await inspect();
      if (before.Running !== true || before.Status !== 'running')
        throw new Error('DEPENDENCY_NOT_RUNNING');
      originalStart = before.StartedAt;
      await docker(['stop', '--time', '1', id]);
      const after = await inspect();
      if (after.Running !== false || after.Status !== 'exited')
        throw new Error('DEPENDENCY_STOP_NOT_CONFIRMED');
      phase = 'STOPPED';
    },
    async start() {
      if (phase !== 'STOPPED') throw new Error('DEPENDENCY_LIFECYCLE');
      // Mark before I/O: a failed/ambiguous operation is never retried by this helper.
      phase = 'STARTING';
      await docker(['start', id]);
      const after = await inspect();
      if (
        after.Running !== true ||
        after.Status !== 'running' ||
        Date.parse(after.StartedAt) <= Date.parse(originalStart)
      )
        throw new Error('DEPENDENCY_START_NOT_CONFIRMED');
      phase = 'STARTED';
    },
  };
}
