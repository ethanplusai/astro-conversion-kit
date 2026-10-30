import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareInertForm } from '../../skills/parity-gates/scripts/verify/forms.mjs';

const live = { method: 'post', action: 'https://example.com/wp-login.php', fields: ['log', 'pwd'] };

test('an inert form with the live fields and no way to send passes', () => {
  const built = { method: 'post', action: '#', onsubmit: 'return false', fields: ['log', 'pwd'] };
  assert.deepEqual(compareInertForm('/log-in/', '', live, built), []);
});

test('a listed form that can still submit fails', () => {
  const built = { method: 'post', action: 'https://formspree.io/f/abc', onsubmit: null, fields: ['log', 'pwd'] };
  const fields = compareInertForm('/log-in/', '', live, built).map((f) => f.field);
  assert.deepEqual(fields, ['inert action', 'inert onsubmit']);
});

test('a listed form that lost a field fails', () => {
  const built = { method: 'post', action: '#', onsubmit: 'return false', fields: ['log'] };
  assert.deepEqual(compareInertForm('/log-in/', '', live, built).map((f) => f.field), ['fields']);
});
