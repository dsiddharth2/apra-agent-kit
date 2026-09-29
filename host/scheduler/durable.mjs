import { Cron } from 'croner';
import { validateSchedules } from './validate.mjs';
import { shouldRun } from './overlap.mjs';

/** Azure Timer Trigger NCRONTAB is 6 fields: second minute hour day month weekday. Spec cron is 5-field. */
function toNcrontab(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length === 5) return `0 ${fields.join(' ')}`;
  return cron;
}

export function createDurableScheduler(config, { jobs, toolRegistry, logger }) {
  let started = false;

  async function tick(schedule, timer) {
    const tickTime = timer?.scheduleStatus?.last ?? new Date().toISOString();
    try {
      const canRun = await shouldRun(schedule.name, schedule.overlap, { jobs, logger });
      if (!canRun) return;

      const { jobId } = await jobs.submit(
        {
          goal: `Scheduled workflow: ${schedule.workflow}`,
          workflow: schedule.workflow,
          inputs: schedule.args,
          strategy: 'workflow',
        },
        {
          metadata: {
            schedule: {
              name: schedule.name,
              tick: typeof tickTime === 'string' ? tickTime : new Date(tickTime).toISOString(),
            },
          },
        },
      );
      logger.info?.(`[scheduler] fired "${schedule.name}" → job ${jobId}`);
    } catch (err) {
      logger.warn?.(`[scheduler] tick "${schedule.name}" failed: ${err?.message ?? err}`);
    }
  }

  return {
    async start() {
      if (started) return;
      validateSchedules(config.schedules, toolRegistry);
      started = true;
      logger.info?.(`[scheduler] started (durable) with ${config.schedules.length} schedule(s)`);
    },

    async stop() {
      started = false;
    },

    registerTimerFunctions(app) {
      validateSchedules(config.schedules, toolRegistry);
      for (const schedule of config.schedules) {
        const timerConfig = {
          schedule: toNcrontab(schedule.cron),
          handler: async (timer, context) => tick(schedule, timer),
        };
        if (schedule.timezone && schedule.timezone !== 'UTC') {
          timerConfig.runOnStartup = false;
        }
        app.timer(`schedule-${schedule.name}`, timerConfig);
      }
    },

    getSchedules() {
      return config.schedules.map(schedule => {
        let nextRun = null;
        try {
          const cron = new Cron(schedule.cron, { timezone: schedule.timezone });
          nextRun = cron.nextRun()?.toISOString() ?? null;
        } catch { /* best-effort */ }
        return {
          name: schedule.name,
          workflow: schedule.workflow,
          args: schedule.args,
          cron: schedule.cron,
          timezone: schedule.timezone,
          overlap: schedule.overlap,
          nextRun,
        };
      });
    },
  };
}
