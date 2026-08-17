/**
 * In-process liveness. No personal data. systemd remains the supervisor.
 */

const DEGRADED_AFTER_MS = 3 * 60 * 1000;
const UNHEALTHY_AFTER_MS = 10 * 60 * 1000;
const STARTUP_GRACE_MS = 2 * 60 * 1000;

const state = {
  startedAt: Date.now(),
  lastTelegramUpdateAt: null,
  lastSchedulerTickAt: null,
  lastSuccessfulSchedulerTickAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  shuttingDown: false,
  crashed: false,
  schedulerWanted: false,
};

function resetRuntimeHealthForTests(now = Date.now()) {
  state.startedAt = now;
  state.lastTelegramUpdateAt = null;
  state.lastSchedulerTickAt = null;
  state.lastSuccessfulSchedulerTickAt = null;
  state.lastErrorAt = null;
  state.lastErrorCode = null;
  state.shuttingDown = false;
  state.crashed = false;
  state.schedulerWanted = false;
}

function noteRuntimeEvent(kind, details = {}) {
  const ts = Number.isFinite(details.at) ? details.at : Date.now();
  if (kind === "telegramUpdate") {
    state.lastTelegramUpdateAt = ts;
    return;
  }
  if (kind === "schedulerTick") {
    state.lastSchedulerTickAt = ts;
    return;
  }
  if (kind === "schedulerTickOk") {
    state.lastSchedulerTickAt = ts;
    state.lastSuccessfulSchedulerTickAt = ts;
    return;
  }
  if (kind === "schedulerWanted") {
    state.schedulerWanted = Boolean(details.wanted);
    return;
  }
  if (kind === "error") {
    state.lastErrorAt = ts;
    const code = details.code || details.name;
    state.lastErrorCode =
      typeof code === "string" && code.length <= 64 ? code : "Error";
    return;
  }
  if (kind === "shutdown") {
    state.shuttingDown = true;
    return;
  }
  if (kind === "crash") {
    state.crashed = true;
    state.shuttingDown = true;
    state.lastErrorAt = ts;
    state.lastErrorCode =
      typeof details.code === "string" ? details.code : "crash";
  }
}

function classifyRuntimeHealth(now = Date.now(), options = {}) {
  if (state.crashed || state.shuttingDown) {
    return "unhealthy";
  }

  const schedulerWanted =
    options.schedulerWanted !== undefined
      ? Boolean(options.schedulerWanted)
      : state.schedulerWanted;
  const uptime = now - state.startedAt;

  if (schedulerWanted) {
    const lastOk = state.lastSuccessfulSchedulerTickAt;
    if (!lastOk) {
      return uptime > STARTUP_GRACE_MS ? "unhealthy" : "degraded";
    }
    const lag = now - lastOk;
    if (lag >= UNHEALTHY_AFTER_MS) {
      return "unhealthy";
    }
    if (lag >= DEGRADED_AFTER_MS) {
      return "degraded";
    }
  }

  if (state.lastErrorAt && now - state.lastErrorAt < DEGRADED_AFTER_MS) {
    return "degraded";
  }

  return "healthy";
}

function getRuntimeHealthSnapshot(now = Date.now(), options = {}) {
  const status = classifyRuntimeHealth(now, options);
  return {
    status,
    startedAt: state.startedAt,
    uptimeSeconds: Math.max(0, Math.floor((now - state.startedAt) / 1000)),
    lastTelegramUpdateAt: state.lastTelegramUpdateAt,
    lastSchedulerTickAt: state.lastSchedulerTickAt,
    lastSuccessfulSchedulerTickAt: state.lastSuccessfulSchedulerTickAt,
    lastErrorAt: state.lastErrorAt,
    lastErrorCode: state.lastErrorCode,
    schedulerWanted: state.schedulerWanted,
    shuttingDown: state.shuttingDown,
  };
}

module.exports = {
  DEGRADED_AFTER_MS,
  UNHEALTHY_AFTER_MS,
  STARTUP_GRACE_MS,
  noteRuntimeEvent,
  classifyRuntimeHealth,
  getRuntimeHealthSnapshot,
  resetRuntimeHealthForTests,
};
