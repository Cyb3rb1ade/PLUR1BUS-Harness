import type {DesktopTransport,IntegrationState} from '../ipc.ts';
import type {MessageKey} from '../i18n.ts';
import {element,append} from '../components/dom.ts';
export function integrationControls(transport:DesktopTransport,t:(key:MessageKey)=>string,refresh:()=>void){
 let state:IntegrationState|null=null,loaded=false,busy=false,failed=false;
 return ()=>{
  const body=element('div');
  if(!loaded){loaded=true;void transport.desktopIntegrationGet?.().then(value=>{state=value;refresh();}).catch(()=>{failed=true;refresh();});}
  if(state?.kind==="store")body.append(element("p",undefined,t("integration.store")));
  else if(state){const label=element('label','quit-choice'),input=document.createElement('input');input.type='checkbox';input.checked=state.enabled;input.disabled=busy;input.dataset.focusKey='desktop-integration';input.addEventListener('change',()=>{if(busy)return;busy=true;failed=false;const enabled=input.checked;refresh();void transport.desktopIntegrationSet?.(enabled).then(value=>{state=value;}).catch(()=>{failed=true;}).finally(()=>{busy=false;refresh();});});append(label,input,document.createTextNode(t(`integration.${state.kind}`)));body.append(label);}
  if(failed){const message=element('p',undefined,t('integration.failed'));message.setAttribute('role','alert');body.append(message);}
  return body;
 };
}
