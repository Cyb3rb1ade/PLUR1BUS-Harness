import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderFeed} from '../render-feed.mjs';

const metadata={version:'0.1.1',channel:'stable',kind:'patch',security:false,date:'2026-10-21',notes:{de:'Behoben',en:'Fixed'},minFromVersion:'0.1.0'};
const bundle=Buffer.from('{"version":"0.1.1"}');
const manifest=platforms=>Buffer.from(JSON.stringify({version:'0.1.1',notes:'Fixed',platforms}));
const asset=url=>({url,signature:'release-signature'});

for(const platform of ['windows-x86_64','linux-x86_64']) {
 test(`publisher rejects legacy ZIP and tar.gz updater artifacts for ${platform}`,()=>{
  for(const suffix of ['.zip','.tar.gz','.ZIP?download=1','.tar.gz#download','.%7aip']) {
   assert.throws(()=>renderFeed(metadata,bundle,manifest({[platform]:asset(`https://releases.test/app${suffix}`)})),/legacy-updater-artifact/);
  }
 });
}

test('publisher accepts a v2 manifest with raw Windows/Linux assets and a macOS app archive',()=>{
 const latest=manifest({
  'windows-x86_64':asset('https://releases.test/app.exe'),
  'windows-aarch64':asset('https://releases.test/app.msi'),
  'linux-x86_64':asset('https://releases.test/app.AppImage'),
  'linux-x86_64-deb':asset('https://releases.test/app.deb'),
  'linux-aarch64-rpm':asset('https://releases.test/app.rpm'),
  'darwin-aarch64':asset('https://releases.test/app.app.tar.gz'),
 });
 const release=renderFeed(metadata,bundle,latest);
 assert.equal(release.version,'0.1.1');
 assert.match(release.tauri,/^[0-9a-f]{64}$/);
});

test('publisher fails closed when a Windows/Linux artifact URL is malformed',()=>{
 for(const url of [undefined,null,'not a URL','https://releases.test/%ZZ.zip']) {
  assert.throws(()=>renderFeed(metadata,bundle,manifest({'linux-x86_64':asset(url)})));
 }
});
