import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeConversationPatch } = await import('../src/routes/conversations.js');

test('resolving a conversation clears human-required state', () => {
  const patch = normalizeConversationPatch({ status: 'RESOLVED' });
  assert.equal(patch.status, 'RESOLVED');
  assert.equal(patch.requiresHuman, false);
  assert.equal(patch.handoffReason, '');
  assert.ok(patch.handoffResolvedAt instanceof Date);
});

test('opening a conversation without an explicit human override resumes AI handling', () => {
  const patch = normalizeConversationPatch({ status: 'OPEN' });
  assert.equal(patch.status, 'OPEN');
  assert.equal(patch.requiresHuman, false);
  assert.equal(patch.handoffReason, '');
});

test('pausing AI and manual handoff both set the same consistent state', () => {
  const paused = normalizeConversationPatch({ aiEnabled: false });
  assert.equal(paused.aiEnabled, false);
  assert.equal(paused.requiresHuman, true);
  assert.equal(paused.status, 'HUMAN_REQUIRED');
  assert.equal(paused.handoffReason, 'MANUAL');

  const manual = normalizeConversationPatch({ requiresHuman: true });
  assert.equal(manual.requiresHuman, true);
  assert.equal(manual.status, 'HUMAN_REQUIRED');
  assert.equal(manual.handoffReason, 'MANUAL');
});

test('an explicit request to keep human handling cannot leave status OPEN', () => {
  const patch = normalizeConversationPatch({ status: 'OPEN', requiresHuman: true });
  assert.equal(patch.requiresHuman, true);
  assert.equal(patch.status, 'HUMAN_REQUIRED');
  assert.equal(patch.handoffReason, 'MANUAL');
});
