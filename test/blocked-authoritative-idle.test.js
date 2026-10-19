'use strict';

// A blocked mark is sticky on purpose: Herdr recognises a question from the
// shape of the screen, and focusing or redrawing the pane can lose that shape
// while the question is still waiting. So the plugin holds the mark until the
// agent goes back to work.
//
// A pane whose state a full lifecycle hook owns is different. Herdr skips the
// screen detector on those terminals and reports the hook's own status, and
// says so in `screen_detection_skipped`. An idle there is the hook saying the
// question was answered, so it must clear the held mark — and the persisted
// `blocked` token must not pull it straight back, which is why the clear and
// the re-adopt share one branch chain. A detector-derived idle keeps the mark:
// it is exactly the misread the hold survives.

const test = require('node:test');
const assert = require('node:assert/strict');

const activity = require('../lib/activity');
const config = require('../lib/config');
const herdr = require('../lib/herdr');
const state = require('../lib/state');
const { Frame } = require('../lib/frame');

// displayFor reads the persisted activity stamps, which come from the plugin's
// real state directory unless they are replaced; the recover lookup walks the
// filesystem on a pane's first frame, so it is stubbed too. Config is pinned so
// a stray idle_grace or blocked_hold in the user's file cannot move the case.
function paneFrame(t) {
  t.mock.method(activity, 'load', () => new Map());
  t.mock.method(activity, 'save', () => {});
  t.mock.method(activity, 'recover', () => null);
  const hold = config.blockedHoldUntilAnswered;
  const grace = config.idleGraceMs;
  config.blockedHoldUntilAnswered = true;
  config.idleGraceMs = 0;
  t.after(() => {
    config.blockedHoldUntilAnswered = hold;
    config.idleGraceMs = grace;
  });
  return new Frame('test');
}

const PANE = 'w:p1';

function entry(overrides = {}) {
  return {
    pane: PANE,
    workspace: 'w',
    tab: 'w:t1',
    name: 'opencode',
    title: 'Fix the parser',
    status: 'idle',
    ...overrides,
  };
}

// A pane already carrying a held red mark, as if an earlier frame had seen the
// agent ask a question mid-work.
function holding(frame) {
  frame.blockedSince.set(PANE, 1000);
  frame.blockedHeldWork.set(PANE, true);
  return frame;
}

test('the snapshot forwards screen_detection_skipped as a boolean', async (t) => {
  t.mock.method(herdr, 'agentsAsync', async () => [
    { pane_id: 'w:p1', agent_status: 'idle', screen_detection_skipped: true, tokens: {} },
    { pane_id: 'w:p2', agent_status: 'idle', screen_detection_skipped: false, tokens: {} },
    { pane_id: 'w:p3', agent_status: 'idle', tokens: {} },
    { pane_id: 'w:p4', agent_status: 'idle', screen_detection_skipped: 'yes', tokens: {} },
  ]);

  const entries = await state.snapshot();
  assert.equal(entries[0].screen_detection_skipped, true, 'authority was dropped from the snapshot');
  assert.equal(entries[1].screen_detection_skipped, false);
  assert.equal(entries[2].screen_detection_skipped, false, 'a Herdr with no field read as authority');
  assert.equal(entries[3].screen_detection_skipped, false, 'a non-boolean value was taken at face value');
});

test('an authoritative idle clears a held blocked mark', (t) => {
  const frame = holding(paneFrame(t));

  const display = frame.displayFor(entry({ screen_detection_skipped: true }), 5000, []);

  assert.equal(display, 'idle', 'the answered question stayed red');
  assert.equal(frame.blockedSince.has(PANE), false, 'the hold was not released');
  assert.equal(frame.blockedHeldWork.has(PANE), false, 'the hold record was left behind');
});

test('a detector-derived idle keeps the mark red', (t) => {
  const frame = holding(paneFrame(t));

  const display = frame.displayFor(entry({ screen_detection_skipped: false }), 5000, []);

  assert.equal(display, 'blocked', 'a detector blip cleared a waiting question');
  assert.equal(frame.blockedSince.has(PANE), true);
});

test('an authoritative idle does not re-adopt a persisted blocked token', (t) => {
  const frame = holding(paneFrame(t));
  frame.blockedSince.delete(PANE);
  frame.blockedHeldWork.delete(PANE);
  // The pane still carries the token an earlier daemon published; with
  // authority the agent is genuinely idle, so it must not be pulled back.
  const stale = entry({ screen_detection_skipped: true, showing: 'blocked' });

  const display = frame.displayFor(stale, 5000, []);

  assert.equal(display, 'idle', 'a stale persisted red was re-adopted over an authoritative idle');
  assert.equal(frame.blockedSince.has(PANE), false);
});

test('a detector-derived persisted blocked token is still re-adopted', (t) => {
  const frame = paneFrame(t);
  const stale = entry({ screen_detection_skipped: false, showing: 'blocked' });

  const display = frame.displayFor(stale, 5000, []);

  assert.equal(display, 'blocked', 'an outlived question was forgotten on a detector pane');
  assert.equal(frame.blockedSince.has(PANE), true, 'the re-adopted mark was not recorded');
});

test('working still clears the mark without any authority', (t) => {
  const frame = holding(paneFrame(t));

  const display = frame.displayFor(entry({ status: 'working' }), 5000, []);

  assert.equal(display, 'working');
  assert.equal(frame.blockedSince.has(PANE), false);
  assert.equal(frame.blockedHeldWork.has(PANE), false);
});

test('a fresh blocked report still holds red', (t) => {
  const frame = paneFrame(t);

  const display = frame.displayFor(entry({ status: 'blocked', screen_detection_skipped: true }), 5000, []);

  assert.equal(display, 'blocked');
  assert.equal(frame.blockedSince.has(PANE), true, 'a pending question was not held');
});
