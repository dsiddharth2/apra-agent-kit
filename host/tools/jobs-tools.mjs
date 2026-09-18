// host/tools/jobs-tools.mjs
import * as z from 'zod/v4';

export const jobTools = [
  {
    name: 'submit-task',
    description: 'Submit a task for asynchronous execution by this agent. Returns a job id; poll it with job-status. Use for work that may take more than a minute.',
    inputSchema: z.object({
      goal: z.string().min(1).describe('Natural-language description of the task'),
      inputs: z.record(z.string(), z.any()).optional().describe('Structured inputs for the task'),
      callbackUrl: z.string().url().optional().describe('HTTPS URL to POST the settled event to'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
    reversible: true, timeout: 10_000, retryable: false, tags: ['jobs'],
    async run({ args, jobs }) {
      const { callbackUrl, ...task } = args;
      return jobs.submit(task, { callbackUrl, metadata: { via: 'mcp' } });
    },
  },
  {
    name: 'job-status',
    description: 'Return the current record for a job submitted with submit-task: status, progress, and the result once finished.',
    inputSchema: z.object({ jobId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    reversible: true, timeout: 10_000, retryable: true, tags: ['jobs'],
    async run({ args, jobs }) {
      return (await jobs.get(args.jobId)) ?? { ok: false, error: 'not_found', jobId: args.jobId };
    },
  },
];
