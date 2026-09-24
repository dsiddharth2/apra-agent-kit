import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLearner } from '../host/memory/learner.mjs';

function mockLtm() {
  const stored = [];
  const promoted = [];
  return {
    store: async (entry) => { stored.push(entry); return { action: 'created', entry }; },
    promote: async (id) => { promoted.push(id); return { id, retrievalStrength: 1.0 }; },
    _stored: stored,
    _promoted: promoted,
  };
}

test('learner extracts facts from LLM response', async () => {
  const ltm = mockLtm();
  const api = {
    executePrompt: async () => '```json\n{"newFacts": [{"kind": "pattern", "text": "Rounding causes mismatches", "tags": ["invoices"]}], "usedRecalledIds": ["mem-abc"]}\n```',
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Find mismatches', history: [], recalledFacts: [{ id: 'mem-abc', kind: 'domain', text: 'Threshold is 0.01' }] });
  assert.equal(result.newFacts.length, 1);
  assert.equal(result.promotedIds.length, 1);
  assert.equal(ltm._stored[0].kind, 'pattern');
  assert.equal(ltm._promoted[0], 'mem-abc');
});

test('learner filters out rule kind', async () => {
  const ltm = mockLtm();
  const api = {
    executePrompt: async () => '```json\n{"newFacts": [{"kind": "rule", "text": "Should not be stored", "tags": []}], "usedRecalledIds": []}\n```',
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
  assert.equal(ltm._stored.length, 0);
});

test('learner handles LLM failure gracefully', async () => {
  const ltm = mockLtm();
  const api = { executePrompt: async () => { throw new Error('LLM down'); } };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
  assert.equal(result.promotedIds.length, 0);
});

test('learner handles malformed JSON gracefully', async () => {
  const ltm = mockLtm();
  const api = { executePrompt: async () => 'No JSON here, just text.' };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
});
