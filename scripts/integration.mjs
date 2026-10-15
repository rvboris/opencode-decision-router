#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Worker,completion,server,decision,runProcess,wire,REAL_TASKS} from '../test/integration/transport.mjs';
export {makeRealBridge} from '../test/integration/real-bridge.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
const option=(key,fallback)=>argv.includes(`--${key}`)?argv[argv.indexOf(`--${key}`)+1]:fallback;
const cases=['smoke','control','heavy-to-light','light-to-heavy','pinned','unauthorized','rate-limit','server-error','invalid-choice','invalid-json','deadline','concurrent','background','resume','omo'];
const requested=option('cases',cases.join(',')).split(',');
if(option('real-decisions',null)&&requested.join(',')!=='smoke,light-to-heavy,omo')throw new Error('real preflight requires exactly smoke,light-to-heavy,omo = 6 sequential calls');
const realMode=option('real-decisions',null)&&option('ledger',null);
if(process.argv.some(a=>['--real-decisions','--ledger'].includes(a))&&!realMode)throw new Error('real mode requires BOTH --real-decisions <config> and --ledger <path>');
let realBridge=null,realArtifacts=[],realCalls=0;
if(realMode&&process.env.REAL_MODE_CONFIRM!=='6-CALLS-AUTHORIZED'){throw new Error('refusing to run real mode without REAL_MODE_CONFIRM=6-CALLS-AUTHORIZED');}
if(realMode){
  const {makeRealBridge}=await import('../test/integration/real-bridge.mjs');
  const {budgetedFetch}=await import('../test/real/ledger.mjs');
  const realCfg=JSON.parse(fs.readFileSync(option('real-decisions'),'utf8'));
  realBridge=makeRealBridge({endpoint:realCfg.endpoint,apiKeyFile:realCfg.apiKeyFile,budgetedFetchImpl:fetchImpl=>budgetedFetch(fetchImpl,{file:path.resolve(option('ledger'))}),logger:e=>realArtifacts.push({...e,at:Date.now()})});
}
const root=fs.mkdtempSync('/tmp/opencode/new-decision-router-tests-');
const results=[];
const bin=option('opencode','/home/boris/.opencode/bin/opencode');
const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
async function scenario(name,overrides={}) {
  if(realArtifacts.some(e=>e.event==='abort'||e.event==='budget-network-error'))throw new Error('real-mode aborted by prior upstream failure; no more calls permitted');
  const id=`${name}-${crypto.randomBytes(4).toString('hex')}`,dir=path.join(root,id);fs.mkdirSync(dir);
  const dirs=Object.fromEntries(['home','config','data','cache','state','cwd'].map(k=>[k,path.join(dir,k)]));for(const d of Object.values(dirs))fs.mkdirSync(d);
  const decisions=[], errors=[];
  const opts={};let expected='light';
  if(name==='control')expected='heavy';
  if(name==='heavy-to-light')opts.model='mock/heavy';
  if(name==='light-to-heavy'){opts.model='mock/light';expected='heavy';}
  if(name==='pinned'){opts.model='mock/pinned';expected='pinned';}
  if(['unauthorized','rate-limit','server-error','invalid-choice','invalid-json','deadline'].includes(name)){opts.model='mock/heavy';expected='heavy';}
  if(name==='background')opts.background=true;
  Object.assign(opts,overrides.args??{});
  const worker=new Worker(id,opts);worker.resume=name==='resume';worker.omo=!!overrides.omo;
  if(realMode){opts.taskKey=name==='light-to-heavy'?'complex':'easy';worker.taskText=opts.taskKey==='complex'?REAL_TASKS.complex:REAL_TASKS.easy;opts.model=name==='light-to-heavy'?'mock/light':'mock/heavy';expected=name==='light-to-heavy'?'heavy':'light';}
  let workerHTTP,decisionHTTP;
  try {
    workerHTTP=await server((b,req,res)=>completion(res,b,worker.respond(b)));
    decisionHTTP=await server((b,req,res,timers)=>{
      decisions.push({at:Date.now(),body:b});
      if(realBridge){if(realCalls>=6)throw new Error('real-mode hard cap of 6 calls exceeded');realCalls++;realBridge.handle(b,res);return;}
      const status={unauthorized:401,'rate-limit':429,'server-error':503}[name];
      const send=()=>{res.writeHead(status??200,{'content-type':'application/json'});res.end(name==='invalid-json'?'{':JSON.stringify(status?{error:'fixture'}:decision(name==='invalid-choice'?'bad':name==='light-to-heavy'?'heavy':'light')));};
      if(name==='deadline'||overrides.delay){const t=setTimeout(send,name==='deadline'?5000:overrides.delay);timers.add(t);res.on('close',()=>{clearTimeout(t);timers.delete(t);});}else send();
    });
    const cfg={enabled:name!=='control',endpoint:decisionHTTP.url,apiKeyEnv:'FIXTURE_KEY',models:{light:'mock/light',heavy:'mock/heavy'},agents:['fixer','explorer'],timeoutMs:realMode?45000:500,maxTaskChars:4000,logFile:path.join(dir,'router.jsonl')};save(path.join(dir,'router.json'),cfg);
    let plugin=repo;
    if(argv.includes('--diagnostic-wrapper')){plugin=path.join(dir,'plugin');fs.mkdirSync(plugin);fs.writeFileSync(path.join(plugin,'index.js'),`export {default} from ${JSON.stringify(path.join(repo,'src/index.js'))};\n`);}
    const config={plugins:[plugin],model:'mock/heavy',agent:{build:{model:'mock/heavy'},fixer:{mode:'subagent',model:'mock/heavy',description:'Fixture specialist'},explorer:{mode:'subagent',model:'mock/light'}},provider:{mock:{npm:'@ai-sdk/openai-compatible',options:{baseURL:workerHTTP.url+'/v1',apiKey:'dummy'},models:{heavy:{name:'heavy'},light:{name:'light'},pinned:{name:'pinned'}}}},mcp:{},permission:{'*':'allow'},share:'disabled'};
    if(overrides.omo){
      const omo='/home/boris/.cache/opencode/npm/oh-my-opencode-slim@latest/1791028966162/node_modules/oh-my-opencode-slim';
      // OMO's published package has no root index.js: register its actual server
      // entry through an isolated directory adapter, never a copied implementation.
      const omoAdapter=path.join(dir,'omo-server');fs.mkdirSync(omoAdapter);
      fs.writeFileSync(path.join(omoAdapter,'index.js'),`export {default} from ${JSON.stringify(path.join(omo,'dist/server/index.js'))};\n`);
      config.plugins=overrides.omo==='first'?[omoAdapter,plugin]:[plugin,omoAdapter];
      delete config.agent.fixer.model;
      delete config.agent.explorer.model;
      fs.mkdirSync(path.join(dirs.config,'opencode'),{recursive:true});
      save(path.join(dirs.config,'opencode','oh-my-opencode-slim.json'),{agents:Object.fromEntries(['orchestrator','fixer','explorer','librarian','oracle','designer','observer','councillor'].map(a=>[a,['fixer','explorer'].includes(a)?{inheritModelFrom:'session',skills:[]}:{model:'mock/heavy',skills:[]}])),disabled_mcps:['websearch','context7','grep_app','gh_grep'],fallback:{enabled:false},background:{enabled:true}});
    }
    save(path.join(dirs.cwd,'opencode.json'),config);
    const env={PATH:'/usr/bin:/bin',HOME:dirs.home,XDG_CONFIG_HOME:dirs.config,XDG_DATA_HOME:dirs.data,XDG_CACHE_HOME:dirs.cache,XDG_STATE_HOME:dirs.state,OPENCODE_DECISION_ROUTER_CONFIG:path.join(dir,'router.json'),FIXTURE_KEY:'dummy'};
    const run=await runProcess(bin,['run','--standalone','--model','mock/heavy','--format','json',`PARENT_${id}: delegate once to fixer.`],{cwd:dirs.cwd,env},Number(option('timeout',realMode?'180000':'45000')));
    fs.writeFileSync(path.join(dir,'stdout.jsonl'),run.stdout);fs.writeFileSync(path.join(dir,'stderr.txt'),run.stderr);
    save(path.join(dir,'worker.json'),worker.rows);save(path.join(dir,'decisions.json'),decisions);save(path.join(dir,'schema.json'),worker.schema);
    assert.equal(run.code,0,`runtime exit: ${run.stdout.slice(-1800)} ${run.stderr.slice(-500)}`);
    assert.ok(worker.schema,'native schema not advertised');
    if(overrides.omo)assert.ok(worker.rows.some(r=>r.tools.some(t=>/^task_(status|result|revive)$/.test(t))),'OMO activation unproven: installed package directory did not advertise OMO lifecycle tools');
    const children=worker.rows.filter(r=>r.role==='child');assert.ok(children.length,'no child inference');
    for(const child of children)assert.equal(wire(child.model),expected,'wrong child model');
    assert.equal(decisions.length,['control','pinned'].includes(name)?0:1,'classifier count');
    assert.ok(worker.results.length,'missing native tool result');
    const db=new DatabaseSync(path.join(dirs.data,'opencode','opencode.db'),{readOnly:true});
    const switches=db.prepare("SELECT session_id, type, time_created, data FROM session_message WHERE type='model-switched'").all();db.close();save(path.join(dir,'model-switches.json'),switches);
    const childIDs=worker.results.flatMap(r=>[...r.content.matchAll(/sessionID[=:][\s"']*(ses_[A-Za-z0-9]+)/g)].map(m=>m[1]));
    assert.equal(switches.filter(s=>childIDs.includes(s.session_id)).length,0,'unexpected child model switch in session history');
    if(name==='background'){assert.ok(worker.results.some(r=>/working in the background.*sessionID: ses_/.test(r.content)),'no background acknowledgment');assert.match(run.stdout,/DONE_|completed/,'no child completion event');}
    if(name==='resume'){assert.ok(worker.resumed,'resume not issued');assert.equal(children.length,2,'resume child request missing');assert.ok(worker.results.at(-1).content.includes(worker.sessionID),'resume changed session');}
    if(realMode){save(path.join(dir,'real.json'),{realArtifacts,childModels:children.map(c=>c.model),decisions:decisions.map(d=>({...d,body:{model:d.body?.model,taskChars:sanitizeLength(d.body?.state?.task)}}))});}
    return {name,id,status:'passed',expected,children,decisions:decisions.length,toolResults:worker.results,dir};
  } catch(e){errors.push(e.message);return {name,id,status:'failed',errors,dir};}
  finally{await workerHTTP?.close();await decisionHTTP?.close();}
}
const sanitizeLength=t=>typeof t==='string'?t.length:null;
for(const name of requested){
 if(!cases.includes(name)){results.push({name,status:'failed',errors:['unknown scenario']});continue;}
 if(realMode&&!['smoke','light-to-heavy','omo'].includes(name)){results.push({name,status:'skipped-real-mode',errors:['real mode limited to smoke/light-to-heavy/omo']});continue;}
 if(realMode&&name==='omo'&&results.filter(r=>r.status==='skipped-real-mode').length<0){/*keep omo*/}
 if(name==='omo'){const phases=realMode?['smoke','light-to-heavy']:['smoke','heavy-to-light','light-to-heavy','pinned','unauthorized','rate-limit','server-error','invalid-choice','invalid-json','deadline','background','resume'];const matrix=[];for(const omo of ['first','last'])for(const phase of phases)matrix.push({...await scenario(phase,{omo}),order:omo});if(!realMode)for(const omo of ['first','last']){const pair=await Promise.all([scenario('heavy-to-light',{omo,delay:150}),scenario('light-to-heavy',{omo,delay:150})]);matrix.push({name:'concurrent',order:omo,status:pair.every(r=>r.status==='passed')?'passed':'failed',pair});}results.push({name,status:matrix.every(r=>r.status==='passed')?'passed':'failed',matrix});continue;}
 if(name==='concurrent'){const pair=await Promise.all([scenario('heavy-to-light',{delay:150}),scenario('light-to-heavy',{delay:150})]);results.push({name,status:pair.every(r=>r.status==='passed')?'passed':'failed',pair});}
 else results.push(await scenario(name));
 console.log(JSON.stringify(results.at(-1)));
}
save(path.join(root,'results.json'),{registration:argv.includes('--diagnostic-wrapper')?'diagnostic-wrapper-not-acceptance':'direct-repository',realMode:!!realMode,realArtifacts,command:`node scripts/integration.mjs ${argv.join(' ')}`,results});console.log(`Evidence: ${root}`);if(results.some(r=>r.status!=='passed'))process.exitCode=1;
