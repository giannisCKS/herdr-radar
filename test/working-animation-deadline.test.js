'use strict';

// A frame that outran its own animation step must still repaint next step.
//
// The spinner deadline was measured from the time the frame STARTED, and the
// frame then awaited its writes. On a slow Herdr those writes can cross the
// 150ms step: the deadline is now behind the clock, the earliest-deadline
// filter drops it, and the frame sleeps to the 30s catch-all. The spinner then
// only moves when the one-second heartbeat fires, and a burst of writes leaves
// it looking frozen. The deadline has to be re-derived from the time the writes
// finished — for panes that are animating, not for every frame.

const test = require('node:test');
const assert = require('node:assert/strict');

const activity = require('../lib/activity');
const herdr = require('../lib/herdr');
const state = require('../lib/state');
const view = require('../lib/view');
const { PULSE_STEPS } = require('../lib/logos');
const { Frame, SPIN_MS } = require('../lib/frame');

const CATCH_ALL_MS = 30000;
const PULSE_MS = SPIN_MS * PULSE_STEPS;

// A write that blocks until the test decides the frame is slow enough. Every
// write in the frame goes through it, so the clock can cross the step while the
// frame is parked in `await Promise.all(jobs)`.
function deferredWrites() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const writes = { count: 0 };
  const write = () => {
    writes.count += 1;
    return gate;
  };
  return { writes, write, release };
}

function frameFor(t, { snapshot, write }) {
  t.mock.method(activity, 'load', () => new Map());
  t.mock.method(activity, 'save', () => {});
  t.mock.method(activity, 'recover', () => null);
  t.mock.method(state, 'snapshot', async () => snapshot());
  t.mock.method(state, 'labels', async () => ({
    tabs: new Map([['w:t1', '1']]),
    workspaces: new Map([['w', 'proj']]),
    parents: new Map(),
    worktrees: new Map(),
  }));
  t.mock.method(state, 'writeTokens', write);
  t.mock.method(state, 'clearState', write);
  t.mock.method(herdr, 'reportMetadataAsync', write);
  t.mock.method(herdr, 'panelGrouped', () => false);
  t.mock.method(view, 'mode', () => null);

  const frame = new Frame('test');
  t.mock.method(frame.workspaceOrder, 'sync', async () => {});
  t.mock.method(frame, 'spaceJobs', () => {});
  t.mock.method(frame, 'groupJobs', async () => {});
  return frame;
}

function pane(overrides = {}) {
  return {
    pane: 'w:p1',
    workspace: 'w',
    tab: 'w:t1',
    name: 'codex',
    title: 'Fix the parser',
    status: 'working',
    tokens: {},
    ...overrides,
  };
}

// Wait for the frame to have registered its writes (the whole batch is queued
// in one synchronous stretch), then move the wall clock and let them land.
async function untilWrites(writes) {
  for (let i = 0; i < 100; i += 1) {
    if (writes.count > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the frame never queued a write');
}

function installClock(t) {
  const realNow = Date.now;
  const clock = { now: 50 };
  Date.now = () => clock.now;
  t.after(() => {
    Date.now = realNow;
  });
  return clock;
}

test('a working frame whose writes outran the step sleeps to the next spinner step', async (t) => {
  const clock = installClock(t);
  const { writes, write, release } = deferredWrites();
  const frame = frameFor(t, { snapshot: () => [pane()], write });

  const rendering = frame.render(clock.now);
  await untilWrites(writes);
  // Frame started at 50, its step is 150; the writes land at 160.
  clock.now = 160;
  release(true);

  assert.equal(await rendering, 300, 'the spinner was left on the catch-all sleep');
});

test('a working frame that keeps up still wakes on its original step', async (t) => {
  const clock = installClock(t);
  const { writes, write, release } = deferredWrites();
  const frame = frameFor(t, { snapshot: () => [pane()], write });

  const rendering = frame.render(clock.now);
  await untilWrites(writes);
  release(true);

  assert.equal(await rendering, SPIN_MS, 'the ordinary spinner cadence moved');
});

test('a blocked frame whose writes outran the pulse sleeps to the next pulse step', async (t) => {
  const clock = installClock(t);
  const { writes, write, release } = deferredWrites();
  const frame = frameFor(t, { snapshot: () => [pane({ status: 'blocked' })], write });

  const rendering = frame.render(clock.now);
  await untilWrites(writes);
  // Frame started at 50, its pulse step is 750; the writes land at 800.
  clock.now = 800;
  release(true);

  assert.equal(await rendering, PULSE_MS * 2, 'the pulse was left on the catch-all sleep');
});

test('an idle frame whose writes outran the step keeps the catch-all sleep', async (t) => {
  const clock = installClock(t);
  const { writes, write, release } = deferredWrites();
  const frame = frameFor(t, { snapshot: () => [pane({ status: 'idle' })], write });

  const rendering = frame.render(clock.now);
  await untilWrites(writes);
  clock.now = 160;
  release(true);

  assert.equal(await rendering, 160 + CATCH_ALL_MS, 'an idle pane was woken on the animation cadence');
});

test('a failed write still backs off when the frame outran the step', async (t) => {
  const clock = installClock(t);
  const { writes, write, release } = deferredWrites();
  const frame = frameFor(t, { snapshot: () => [pane({ status: 'idle' })], write });

  const rendering = frame.render(clock.now);
  await untilWrites(writes);
  clock.now = 160;
  release(false);

  // The first failure backs off 2s (settled counts before the exponent), so
  // the deadline is `after + 2000`, not the catch-all.
  assert.equal(await rendering, 2160, 'the failure retry deadline was lost');
});
