import assert from 'node:assert/strict';
import test from 'node:test';
import { countPlaywrightTests } from './run-result.mjs';

test('counts tests that produced at least one Playwright result', () => {
  assert.equal(countPlaywrightTests({
    suites: [{
      specs: [
        { tests: [{ results: [{ status: 'passed' }] }, { results: [{ status: 'failed' }, { status: 'passed' }] }] },
        { tests: [{ results: [] }] },
      ],
      suites: [{ specs: [{ tests: [{ results: [{ status: 'skipped' }] }] }] }],
    }],
  }), 3);
});

test('returns zero for an absent or empty report', () => {
  assert.equal(countPlaywrightTests(null), 0);
  assert.equal(countPlaywrightTests({ suites: [] }), 0);
});
