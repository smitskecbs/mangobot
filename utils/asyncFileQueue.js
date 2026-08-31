/**
 * Per-file FIFO of async exclusive tasks.
 * Waiting is Promise-based: the Node event loop stays free while a task awaits I/O.
 */

const path = require("path");

/** @type {Map<string, { tail: Promise<void>, generation: number }>} */
const queues = new Map();

function resolveFileMutationQueueKey(filePath) {
  return path.resolve(String(filePath || ""));
}

function hasFileMutationQueue(filePath) {
  return queues.has(resolveFileMutationQueueKey(filePath));
}

function countFileMutationQueues() {
  return queues.size;
}

/**
 * Run `task` exclusively for this file path. FIFO with other waiters on the same key.
 * A rejected task rejects its own Promise; later tasks still run.
 *
 * @template T
 * @param {string} filePath
 * @param {() => T | Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueFileMutation(filePath, task) {
  if (typeof task !== "function") {
    return Promise.reject(new TypeError("enqueueFileMutation requires a task function"));
  }

  const key = resolveFileMutationQueueKey(filePath);
  let entry = queues.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), generation: 0 };
    queues.set(key, entry);
  }

  const generation = entry.generation + 1;
  entry.generation = generation;

  const run = entry.tail.then(
    () => task(),
    () => task()
  );

  const settled = run.then(
    () => undefined,
    () => undefined
  );
  entry.tail = settled;

  settled.then(() => {
    const current = queues.get(key);
    if (
      current &&
      current.generation === generation &&
      current.tail === settled
    ) {
      queues.delete(key);
    }
  });

  return run;
}

module.exports = {
  enqueueFileMutation,
  resolveFileMutationQueueKey,
  hasFileMutationQueue,
  countFileMutationQueues,
};
