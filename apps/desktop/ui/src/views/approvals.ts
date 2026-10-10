import {element,append} from "../components/dom.ts";
import {button} from "../components/button.ts";
import type {MessageKey} from "../i18n.ts";
export type ApprovalCard={id:string;capability:string;effect:string;targets:string[];risk:string;reversible:boolean|null;grantOptions:string[];actionHash:string;reason:string};
export const cardFields=(_card:ApprovalCard)=>["capability","effect","targets","risk","reversible","grantOptions","actionHash","reason"] as const;
export function approvalCards(cards:ApprovalCard[],t:(key:MessageKey)=>string,open:(id:string)=>Promise<void>,decideEnabled=false,decide?:(id:string,decision:"approve"|"deny")=>Promise<void>){
 const list=element("main","content settings-stack");const title=element("h1",undefined,t("approvals.title"));title.tabIndex=-1;list.append(title);
 if(!cards.length)list.append(element("p",undefined,t("approvals.empty")));
 for(const card of cards){
  const item=element("article","settings-card");const heading=element("h2",undefined,card.capability);item.append(heading);
  const fields=element("dl");
  for(const key of cardFields(card)){
   const label=element("dt",undefined,t(`approvals.${key}`));
   const value=key==="targets"||key==="grantOptions"?(key==="grantOptions"?card[key].map(value=>t(`approvals.grant.${value}` as MessageKey)):card[key]).join("\n"):key==="reversible"?t(card.reversible===null?"approvals.unknown":card.reversible?"approvals.yes":"approvals.no"):key==="risk"&&["low","medium","high","critical"].includes(card.risk)?t(`approvals.risk.${card.risk}` as MessageKey):card[key];
   append(fields,label,element("dd",undefined,value));
  }
  item.append(fields);
  const act=(action:()=>Promise<void>,control:HTMLButtonElement)=>{control.disabled=true;void action().catch(()=>{const error=element("p",undefined,t("host.failed"));error.setAttribute("role","alert");item.append(error);}).finally(()=>{control.disabled=false;});};
  const openButton=button(t("approvals.open"),()=>act(()=>open(card.id),openButton),"primary");item.append(openButton);
  for(const decision of ["approve","deny"] as const){const control=button(t(`approvals.${decision}`),()=>{if(decideEnabled&&decide)act(()=>decide(card.id,decision),control);});control.disabled=!decideEnabled||!decide;item.append(control);}
  list.append(item);
 }
 return list;
}
