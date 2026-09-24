const NOTIFICATION_EVENTS = new Set([
  'memory:recall', 'memory:store', 'memory:learn', 'memory:error',
]);

const FULL_EVENTS = new Set([
  ...NOTIFICATION_EVENTS,
  'memory:recall:tool', 'memory:promote', 'memory:decay',
]);

export function createMemoryEvents({ notifier, level = 'notifications' } = {}) {
  if (!notifier || level === 'none') {
    return { emit() {} };
  }

  const allowed = level === 'full' ? FULL_EVENTS : NOTIFICATION_EVENTS;

  function strip(type, payload) {
    if (level === 'full') return payload;
    if (type === 'memory:recall' || type === 'memory:recall:tool') {
      const { facts, ...rest } = payload;
      return { ...rest, count: facts?.length ?? payload.count };
    }
    return payload;
  }

  return {
    emit(type, payload) {
      if (!allowed.has(type)) return;
      notifier.publish({ type, ...strip(type, payload) }).catch(() => {});
    },
  };
}
