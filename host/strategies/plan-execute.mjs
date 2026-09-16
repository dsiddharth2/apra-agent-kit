// host/strategies/plan-execute.mjs
import { parseResponse } from '../response-parser.mjs';
import {
  buildSystemPrompt, buildPlanPrompt, buildReviewPrompt, buildStepReviewPrompt,
  buildResolveArgsPrompt, buildReasonPrompt, buildReplanPrompt, buildExecutePrompt,
  formatTools,
} from '../prompts/index.mjs';

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

function hasEmptyArgs(step) {
  return step.type === 'tool' && (!step.args || Object.keys(step.args).length === 0);
}

export function createPlanExecuteStrategy({
  task,
  tools,
  fleetApi,
  guardrails,
  maxReplanAttempts = 3,
  maxReviewAttempts = 2,
  maxStepReviewAttempts = 2,
  maxNoActionTurns = 3,
  minReviewPolicy = 'irreversible',
  agentName = 'agent',
  agentDescription = '',
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription });
  const toolCatalog = formatTools(tools);
  const observations = [];

  function shouldReview(step) {
    if (step.review) return true;
    if (minReviewPolicy === 'irreversible' && step.type === 'tool') {
      const tool = tools.find(t => t.name === step.tool);
      if (tool && tool.reversible === false) return true;
    }
    return false;
  }

  async function callPrompt(memberName, prompt) {
    const raw = await fleetApi.executePrompt({ member_name: memberName, prompt });
    return extractText(raw);
  }

  async function runTool(name, args) {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found in registry.` };
    }
    if (guardrails) {
      return guardrails.execute(tool, { fleetApi, args });
    }
    const { executeTool } = await import('../tools/executor.mjs');
    return executeTool(tool, { fleetApi, args });
  }

  async function* iterate() {
    let replanCount = 0;
    let currentPlan = null;

    // Phase 1: Plan
    planLoop: while (true) {
      const planPrompt = currentPlan
        ? buildReplanPrompt({
            task, plan: currentPlan, history: observations,
            failedStep: null, reviewerFeedback: null, systemPrompt,
          })
        : buildPlanPrompt({ task, tools: toolCatalog, systemPrompt });

      const planText = await callPrompt('doer', planPrompt);
      yield { type: 'prompt_usage', text: planText };
      const planParsed = parseResponse(planText);

      if (planParsed.type !== 'plan') {
        yield { type: 'error', reason: 'invalid_plan', message: 'Doer did not produce a plan block' };
        return;
      }

      currentPlan = planParsed.payload;
      yield { type: 'plan', plan: currentPlan };

      // Phase 2: Review plan
      for (let reviewRound = 0; reviewRound < maxReviewAttempts; reviewRound++) {
        const reviewPrompt = buildReviewPrompt({ task, plan: currentPlan, tools: toolCatalog, systemPrompt });
        const reviewText = await callPrompt('reviewer', reviewPrompt);
        yield { type: 'prompt_usage', text: reviewText };
        const reviewParsed = parseResponse(reviewText);

        if (reviewParsed.type !== 'review') {
          yield { type: 'review', approved: true, note: 'Reviewer did not produce review block, treating as approved' };
          break;
        }

        const { approved, feedback } = reviewParsed.payload;
        yield { type: 'review', approved, feedback };

        if (approved) break;

        replanCount++;
        if (replanCount > maxReplanAttempts) {
          yield { type: 'error', reason: 'max_replans', message: `Exceeded ${maxReplanAttempts} replan attempts` };
          return;
        }

        const replanPrompt = buildReplanPrompt({
          task, plan: currentPlan, history: observations,
          failedStep: null, reviewerFeedback: feedback, systemPrompt,
        });
        const replanText = await callPrompt('doer', replanPrompt);
        yield { type: 'prompt_usage', text: replanText };
        const replanParsed = parseResponse(replanText);

        if (replanParsed.type !== 'plan') {
          yield { type: 'error', reason: 'invalid_replan', message: 'Doer did not produce a revised plan block' };
          return;
        }
        currentPlan = replanParsed.payload;
        yield { type: 'plan', plan: currentPlan };
      }

      break planLoop;
    }

    // Phase 3: Execute steps
    const steps = currentPlan.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      if (step.type === 'tool') {
        let args = step.args;

        if (hasEmptyArgs(step)) {
          const resolvePrompt = buildResolveArgsPrompt({ task, step, history: observations, systemPrompt });
          const resolveText = await callPrompt('doer', resolvePrompt);
          yield { type: 'prompt_usage', text: resolveText };
          const resolved = parseResponse(resolveText);
          if (resolved.type === 'tool_call') {
            args = resolved.payload.args;
          }
        }

        let result = await runTool(step.tool, args);
        observations.push({ type: 'observation', stepType: 'tool', tool: step.tool, args, result });
        yield { type: 'observation', stepType: 'tool', tool: step.tool, args, ...result };

        // Step review
        if (shouldReview(step)) {
          for (let retryRound = 0; retryRound <= maxStepReviewAttempts; retryRound++) {
            const srPrompt = buildStepReviewPrompt({ task, step, result, history: observations, systemPrompt });
            const srText = await callPrompt('reviewer', srPrompt);
            yield { type: 'prompt_usage', text: srText };
            const srParsed = parseResponse(srText);

            const approved = srParsed.type === 'step_review' ? srParsed.payload.approved : true;
            const feedback = srParsed.type === 'step_review' ? srParsed.payload.feedback : undefined;
            yield { type: 'step_review', approved, feedback, step: step.tool };

            if (approved) break;

            if (retryRound >= maxStepReviewAttempts) {
              replanCount++;
              if (replanCount > maxReplanAttempts) {
                yield { type: 'error', reason: 'max_replans', message: 'Exceeded replan attempts after step review rejection' };
                return;
              }
              const replanPrompt = buildReplanPrompt({
                task, plan: currentPlan, history: observations,
                failedStep: step, reviewerFeedback: feedback, systemPrompt,
              });
              const rpText = await callPrompt('doer', replanPrompt);
              yield { type: 'prompt_usage', text: rpText };
              const rpParsed = parseResponse(rpText);
              if (rpParsed.type === 'plan') {
                currentPlan = rpParsed.payload;
                yield { type: 'plan', plan: currentPlan };
              }
              break;
            }

            // Retry: ask doer to redo
            const retryPrompt = buildResolveArgsPrompt({ task, step: { ...step, reason: `Retry: ${feedback}` }, history: observations, systemPrompt });
            const retryText = await callPrompt('doer', retryPrompt);
            yield { type: 'prompt_usage', text: retryText };
            const retryParsed = parseResponse(retryText);
            if (retryParsed.type === 'tool_call') {
              args = retryParsed.payload.args;
            }
            result = await runTool(step.tool, args);
            observations.push({ type: 'observation', stepType: 'tool', tool: step.tool, args, result, retry: retryRound + 1 });
            yield { type: 'observation', stepType: 'tool', tool: step.tool, args, ...result };
          }
        }
      } else if (step.type === 'reason') {
        const reasonPrompt = buildReasonPrompt({ task, step, history: observations, systemPrompt });
        const reasonText = await callPrompt('doer', reasonPrompt);
        yield { type: 'prompt_usage', text: reasonText };
        observations.push({ type: 'observation', stepType: 'reason', text: reasonText });
        yield { type: 'observation', stepType: 'reason', text: reasonText };

        if (shouldReview(step)) {
          const srPrompt = buildStepReviewPrompt({ task, step, result: { text: reasonText }, history: observations, systemPrompt });
          const srText = await callPrompt('reviewer', srPrompt);
          yield { type: 'prompt_usage', text: srText };
          const srParsed = parseResponse(srText);
          const approved = srParsed.type === 'step_review' ? srParsed.payload.approved : true;
          const feedback = srParsed.type === 'step_review' ? srParsed.payload.feedback : undefined;
          yield { type: 'step_review', approved, feedback, step: 'reason' };
        }
      }
    }

    // Phase 4: Done
    const donePrompt = buildExecutePrompt({
      task, plan: currentPlan, stepIndex: steps.length - 1,
      observation: observations[observations.length - 1], systemPrompt,
    });
    const doneText = await callPrompt('doer', donePrompt);
    yield { type: 'prompt_usage', text: doneText };
    const doneParsed = parseResponse(doneText);

    if (doneParsed.type === 'done') {
      yield { type: 'done', result: doneParsed.payload.result, summary: doneParsed.payload.summary };
    } else {
      yield { type: 'done', result: doneText, summary: 'Plan execution completed' };
    }
  }

  return {
    iterate,
    history: () => [...observations],
  };
}
