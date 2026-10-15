import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupStepsFor, SETUP_STEPS, voiceSetupSelection } from '../../src/setup/model.ts';
import { initial, load, save, stepsFor } from '../../../web/src/pages/setup/model.ts';
import type { VoiceLanguage } from '@plur1bus/rpc-schema';
it('matches the existing wizard step definitions exactly: eight standalone, seven bundled', () => {
  const source = readFileSync(new URL('../../../web/src/pages/setup/model.ts', import.meta.url), 'utf8');
  const ui = [...source.matchAll(/\{ id: "(\w+)", skippable: (true|false), unavailable: (true|false) \}/g)].map(m => ({ id: m[1], skippable: m[2] === 'true', unavailable: m[3] === 'true' }));
  assert.deepEqual(SETUP_STEPS, ui); assert.equal(setupStepsFor(false).length,8); assert.equal(setupStepsFor(true).length,7);
});
it('never preselects a model needing licence confirmation', () => {
  const models = [{ modelId:'research-voice', role:'tts' as const, sizeBytes:1, licenceId:'research-only', needsConfirmation:true, installed:false }];
  const languages: VoiceLanguage[] = [{ language:'en', profiles:{fast:{models},quality:{models:structuredClone(models)}} }];
  assert.equal(voiceSetupSelection(languages,'en-US'),null);
  languages[0]!.profiles.quality!.models[0]!.needsConfirmation=false;
  assert.deepEqual(voiceSetupSelection(languages,'en-GB'),{language:'en',profile:'quality'});
  assert.equal(voiceSetupSelection(languages,'fr-FR'),null);
});

// Voice step data contract. The skip, back and continue buttons are drawn by the Preact page (packages/web), which
// the core test suite cannot render, so these tests cover what the page stores and reads back: the wizard state
// that holds the step, its status and the voice answer. A skipped Sprache step is not "done", and the answer
// survives a return to the step.

it('a skipped voice step is stored as skipped with no voice answer, and the wizard can move past it', () => {
  save({ ...initial(), step: 'voice', status: { account: 'done', persona: 'done', model: 'skipped', memory: 'done' } });
  const skipped = load();
  assert.equal(skipped.status.voice, undefined, 'the voice step is not marked done');
  assert.equal(skipped.answers.voice, null);
  assert.ok(stepsFor(false).find(step => step.id === 'voice')!.skippable, 'the step may be skipped');
  save({ ...skipped, step: 'backup', status: { ...skipped.status, voice: 'skipped' } });
  assert.equal(load().step, 'backup');
  assert.equal(load().status.voice, 'skipped');
});

it('going back to the voice step keeps the saved language and profile, and continuing marks it done', () => {
  const answer = { language: 'en', profile: 'fast' as const };
  save({ ...initial(), step: 'voice', answers: { ...initial().answers, voice: answer } });
  const back = load();
  assert.equal(back.step, 'voice');
  assert.deepEqual(back.answers.voice, answer, 'returning to the step restores the answer');
  save({ ...back, step: 'backup', status: { ...back.status, voice: 'done' } });
  assert.equal(load().status.voice, 'done');
  assert.deepEqual(load().answers.voice, answer);
});

it('an unexpected stored voice answer reads as not done', () => {
  const stored = initial();
  save({ ...stored, answers: { ...stored.answers, voice: { language: '', profile: 'research' } as unknown as typeof stored.answers.voice } });
  assert.equal(load().answers.voice, null);
});

import { validateVoiceSetupSelection } from '../../src/setup/model.ts';
it('rejects a missing or non-object voice selection with E_INVALID_PARAMS instead of a TypeError', () => {
  for (const bad of [undefined, null, 'de', 7, []]) assert.throws(() => validateVoiceSetupSelection(bad as never), (e: any) => e.error === 'E_INVALID_PARAMS', String(bad));
  assert.doesNotThrow(() => validateVoiceSetupSelection({ language: 'de', profile: 'fast' }));
});
