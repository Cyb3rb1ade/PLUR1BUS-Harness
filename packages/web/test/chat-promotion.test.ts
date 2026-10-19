import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setup, teardown, browserSkip } from './harness.ts';
import { withChat } from './chat-fixtures.ts';
import { expectAxeClean } from './axe.ts';
before(setup); after(teardown);
for (const lang of ['en', 'de'] as const) test(`private promotion requires preview and defaults to no content (${lang})`, { skip: browserSkip }, async () => {
  let previewArgs: any, commits = 0;
  await withChat({ route: '#/chat/ses_1', locale: lang === 'de' ? 'de-DE' : 'en-US', seed(c) {
    c.seed({ id: 'ses_1', title: 'Private chat title', messages: [['user','chosen-message-marker'],['assistant','unselected-private-marker']] });
    c.server.rpc.handle('chat.promote.links', () => ({ links: [] }), { write: false });
    c.server.rpc.handle('project.list', () => ({ projects: [{ id:'p1', name:'Destination project' }] }), { write: false });
    c.server.rpc.handle('chat.promote.preview', (p: any) => { previewArgs = p; return { previewId:'preview-one', content:'', target:p.target, selection:'none', expiresAt:Date.now()+600000 }; });
    c.server.rpc.handle('chat.promote.commit', p => { commits++; assert.deepEqual(p,{previewId:'preview-one'}); return {projectId:'p1',cardId:null,selection:'none',transferredMessages:0}; });
  } }, async ({ page, problems }) => {
    await page.locator('.chat-menu summary').click();
    await page.getByRole('button',{name:lang==='de'?'Chat befördern oder verknüpfen':'Promote or link chat'}).click();
    const dialog=page.getByRole('dialog'); await dialog.waitFor();
    await dialog.getByLabel(lang==='de'?'Projekt':'Project',{exact:true}).selectOption('p1');
    assert.equal(await dialog.getByLabel(lang==='de'?'Zu kopierende Inhalte':'Content to copy').inputValue(),'none');
    const confirm=dialog.getByRole('button',{name:lang==='de'?'Beförderung bestätigen':'Confirm promotion'});
    assert.equal(await confirm.isDisabled(),true);
    await dialog.getByRole('button',{name:lang==='de'?'Auswahl vorschauen':'Preview selection'}).click();
    await dialog.locator('.promotion-preview').waitFor(); assert.equal(await confirm.isDisabled(),false);
    assert.equal(previewArgs.selection.kind,'none'); assert.ok(!JSON.stringify(previewArgs).includes('private-marker'));
    await expectAxeClean(page,'D92 promotion dialog');
    await confirm.click(); await dialog.getByRole('status').waitFor();
    assert.equal(commits,1); assert.deepEqual(problems,[]);
  });
});
test('selected message IDs are fetched from source, preview is escaped, changing selection invalidates confirmation', {skip:browserSkip}, async()=>{
  let previewArgs:any;
  await withChat({route:'#/chat/ses_1',seed(c){
    c.seed({id:'ses_1',messages:[['user','<script>chosen()</script>'],['assistant','keep-private']]});
    c.server.rpc.handle('chat.promote.links', () => ({ links: [] }), { write: false });
    c.server.rpc.handle('chat.promote.links',()=>({links:[]}),{write:false});
    c.server.rpc.handle('project.list',()=>({projects:[{id:'p1',name:'Destination project'}]}),{write:false});
    c.server.rpc.handle('chat.promote.preview',(p:any)=>{previewArgs=p;return{previewId:'preview-two',content:'user: <script>chosen()</script>',target:p.target,selection:'selected',expiresAt:Date.now()+600000};});
  }},async({page})=>{
    await page.locator('.chat-menu summary').click();await page.getByRole('button',{name:'Promote or link chat'}).click();const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Project',{exact:true}).selectOption('p1');await dialog.getByLabel('Content to copy').selectOption('selected');
    await dialog.getByRole('checkbox',{name:'user: <script>chosen()</script>'}).check();await dialog.getByRole('button',{name:'Preview selection'}).click();await dialog.locator('.promotion-preview').waitFor();
    assert.deepEqual(previewArgs.selection.messageIds,['m_ses_1_1']);assert.equal(await dialog.locator('.promotion-preview script').count(),0);
    assert.equal(await dialog.getByRole('button',{name:'Confirm promotion'}).isDisabled(),false);await dialog.getByLabel('Content to copy').selectOption('none');assert.equal(await dialog.getByRole('button',{name:'Confirm promotion'}).isDisabled(),true);
  });
});
