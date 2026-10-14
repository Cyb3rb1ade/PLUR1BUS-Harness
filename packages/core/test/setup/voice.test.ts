import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupStepsFor, SETUP_STEPS, voiceSetupSelection } from '../../src/setup/model.ts';
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
import { validateVoiceSetupSelection } from '../../src/setup/model.ts';
it('rejects a missing or non-object voice selection with E_INVALID_PARAMS instead of a TypeError', () => {
  for (const bad of [undefined, null, 'de', 7, []]) assert.throws(() => validateVoiceSetupSelection(bad as never), (e: any) => e.error === 'E_INVALID_PARAMS', String(bad));
  assert.doesNotThrow(() => validateVoiceSetupSelection({ language: 'de', profile: 'fast' }));
});
