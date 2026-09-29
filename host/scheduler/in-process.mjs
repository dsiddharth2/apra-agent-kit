import { Cron } from 'croner';
import { validateSchedules } from './validate.mjs';
import { shouldRun } from './overlap.mjs';

export function createInProcessScheduler(config, { jobs, toolRegistry, logger }) {
  const crons = [];
  let started = false;

  async function tick(schedule) {
    const tickTime = new Date();
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
              tick: tickTime.toISOString(),
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
      for (const schedule of config.schedules) {
        const job = new Cron(schedule.cron, { timezone: schedule.timezone }, () => tick(schedule));
        crons.push({ schedule, job });
      }
      started = true;
      logger.info?.(`[scheduler] started ${crons.length} schedule(s)`);
    },

    async stop() {
      for (const { job } of crons) job.stop();
      crons.length = 0;
      started = false;
    },

    getSchedules() {
      return crons.map(({ schedule, job }) => ({
        name: schedule.name,
        workflow: schedule.workflow,
        args: schedule.args,
        cron: schedule.cron,
        timezone: schedule.timezone,
        overlap: schedule.overlap,
        nextRun: job.nextRun()?.toISOString() ?? null,
      }));
    },
  };
}
