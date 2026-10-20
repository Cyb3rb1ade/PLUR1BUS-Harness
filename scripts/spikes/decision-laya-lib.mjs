// Offline F3 spike helpers. No provider API, global fetch, or Engine internals.
export function softmax(logits, temperature) {
  if (!Array.isArray(logits) || logits.length < 2 || logits.some(v=>!Number.isFinite(v)) || !Number.isFinite(temperature) || temperature<=0) throw Error('invalid logits/temperature');
  const scaled=logits.map(v=>v/temperature), max=Math.max(...scaled);
  const exp=scaled.map(v=>Math.exp(v-max)), sum=exp.reduce((a,b)=>a+b,0);
  return exp.map(v=>v/sum);
}
export function temperatureFor(config,primitive,count) {
  const index={choice:0,score:1,noul:2}[primitive];
  if(index===undefined) throw Error('unknown primitive');
  const bucket=count<=2?'2':count<=5?'3-5':count<=10?'6-10':'11+';
  const value=config.temperature_by_options?.[`${primitive}:${bucket}`] ?? config.temperature?.[index];
  if(!Number.isFinite(value)||value<=0)throw Error('invalid temperature');
  return value;
}
export function buildInputs(request,tokenizer,config) {
  const {primitive,question,state,options}=request;
  if(!['choice','score','noul'].includes(primitive)||typeof question!=='string'||typeof state!=='string'||!Array.isArray(options)||options.length<2||options.length>255||new Set(options.map(o=>o.id)).size!==options.length)throw Error('invalid request');
  if(options.some(o=>typeof o.id!=='string'||!o.id||typeof o.description!=='string'))throw Error('invalid options');
  const ids=[tokenizer.cls,...tokenizer.encode(`${primitive} question: ${question}`),tokenizer.sep],positions=[];
  for(const option of options){positions.push(ids.length);ids.push(tokenizer.mask,...tokenizer.encode(` ${option.id}: ${option.description}`));}
  ids.push(tokenizer.sep);
  if(ids.length>config.head_max_len)throw Error('head budget exceeded');
  const stateIds=tokenizer.encode(state);
  if(ids.length+stateIds.length+1>config.max_len)throw Error('state budget exceeded');
  ids.push(...stateIds,tokenizer.sep);
  if(ids.some(v=>!Number.isSafeInteger(v)||v<0))throw Error('invalid token id');
  return {ids,positions};
}
export function evaluate(rows) {
  if(!rows.length)throw Error('no rows');
  let correct=0,brier=0;
  for(const {gold,probabilities} of rows){
    const entries=Object.entries(probabilities);
    if(!Object.hasOwn(probabilities,gold)||entries.length<2||entries.some(([,p])=>!Number.isFinite(p)||p<0||p>1)||Math.abs(entries.reduce((s,[,p])=>s+p,0)-1)>1e-6)throw Error('invalid probabilities');
    const best=entries.reduce((a,b)=>a[1]>=b[1]?a:b)[0];if(best===gold)correct++;
    for(const [key,p]of entries)brier+=(p-(key===gold?1:0))**2;
  }
  return {n:rows.length,accuracy:correct/rows.length,brier:brier/rows.length};
}
export function germanGate({de,en,paired,verified}) {
  const complete=verified===true&&Number.isSafeInteger(paired)&&paired>=60&&de?.n===paired&&en?.n===paired;
  const valid=[de?.accuracy,en?.accuracy,de?.brier,en?.brier].every(Number.isFinite);
  return {passed:complete&&valid&&de.accuracy>=en.accuracy-.05-1e-12&&de.brier<=en.brier+.05+1e-12,complete,accuracyGap:valid?en.accuracy-de.accuracy:null,brierGap:valid?de.brier-en.brier:null};
}
export const percentile=(rows,p)=>{const a=[...rows].sort((a,b)=>a-b);return a[Math.max(0,Math.ceil(a.length*p)-1)]??null;};
export function validateCases(cases) {
  if(!Array.isArray(cases)||!cases.length)throw Error('empty cases');
  const ids=new Set();
  for(const row of cases){
    if(typeof row.id!=='string'||!row.id||ids.has(row.id))throw Error('duplicate or invalid case id');ids.add(row.id);
    if(!Array.isArray(row.options)||row.options.length<2||new Set(row.options.map(o=>o.id)).size!==row.options.length)throw Error('invalid options');
    if(!row.options.some(o=>o.id===row.gold))throw Error('invalid gold label');
    for(const locale of ['de','en'])for(const value of [row.state?.[locale],row.question?.[locale],...row.options.map(o=>o.description?.[locale])])if(typeof value!=='string'||!value.trim())throw Error('missing translation');
  }
}
