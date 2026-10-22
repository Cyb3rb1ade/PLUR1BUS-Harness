import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = name => readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
function evaluate(expression, context) {
  const expanded = expression.replace(/\b(?:github|inputs)(?:\.[\w_]+)+/g, path => {
    let value = context;
    for (const key of path.split('.')) value = value?.[key];
    return JSON.stringify(value ?? null);
  });
  assert.match(expanded, /^[\s'"a-zA-Z0-9_:/.,=|&!()-]+$/);
  return Function(`return (${expanded});`)();
}
function context(event, number = 12, extra = {}) {
  return { github: { event_name: event, workflow: 'ci', ref: event === 'pull_request' ? `refs/pull/${number}/merge` : 'refs/heads/main',
    event: { pull_request: { number: event === 'pull_request' ? number : undefined }, action: 'synchronize', label: { name: '' } }, ...extra }, inputs: {} };
}
function policy(name) {
  const yaml = workflow(name);
  const block = /^concurrency:\n([\s\S]*?)(?=^\S)/m.exec(yaml)?.[1];
  assert(block, `${name} concurrency block missing`);
  const cancel = /^  cancel-in-progress: (.*)$/m.exec(block)[1];
  const group = /^  group: (.*)$/m.exec(block)[1];
  return {
    yaml,
    cancel: c => cancel === 'false' ? false : evaluate(/^\$\{\{ (.*) \}\}$/.exec(cancel)[1], c),
    group: c => group.replace(/\$\{\{ ([\s\S]*?) \}\}/g, (_, expression) => String(evaluate(expression, c))),
  };
}

for (const name of ['ci', 'desktop', 'hermes-host', 'container', 'release-smoke']) {
  test(`${name}: only superseded PR runs cancel, main/manual/scheduled runs remain`, () => {
    const p = policy(name);
    assert.equal(p.cancel(context('pull_request')), true);
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group']) assert.equal(p.cancel(context(event)), false, event);
    assert.equal(p.group(context('pull_request', 12, { sha: 'old' })), p.group(context('pull_request', 12, { sha: 'new' })));
    assert.notEqual(p.group(context('pull_request', 12)), p.group(context('pull_request', 13)));
    assert.notEqual(p.group(context('push')), p.group(context('push', 12, { ref: 'refs/heads/other' })));
  });
}

test('publishing releases never cancel and nightly has no PR trigger', () => {
  const release = policy('harness-release');
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch', 'workflow_call']) assert.equal(release.cancel(context(event)), false);
  const nightly = policy('nightly');
  const trigger = nightly.yaml.slice(0, nightly.yaml.indexOf('\nconcurrency:'));
  assert.doesNotMatch(trigger, /^  pull_request:/m);
  for (const event of ['schedule', 'workflow_dispatch', 'push']) assert.equal(nightly.cancel(context(event)), false);
});

for (const name of ['ci', 'desktop', 'hermes-host']) {
  test(`${name}: an unrelated label event cannot cancel the active PR run`, () => {
    const p = policy(name);
    const active = context('pull_request');
    const noop = context('pull_request');
    noop.github.event.action = 'labeled'; noop.github.event.label.name = 'documentation';
    assert.notEqual(p.group(active), p.group(noop));
    const requested = context('pull_request');
    requested.github.event.action = 'labeled'; requested.github.event.label.name = 'ci:macos';
    assert.equal(p.group(active), p.group(requested));
  });
}


test('actual workflows never share a PR cancellation namespace', () => {
  const names = ['ci', 'desktop', 'hermes-host', 'container', 'release-smoke', 'harness-release'];
  const groups = names.map(name => policy(name).group(context('pull_request', 12, { workflow: name })));
  assert.equal(new Set(groups).size, names.length);
  assert.equal(policy('release-smoke').group(context('pull_request')), 'release-smoke-12');
});
