import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfig, createRouter, evaluateEvent, validateDecisionResponse, buildDecisionRequest } from '../../src/index.js';
const profiles = JSON.parse(readFileSync(new URL('../../examples/profiles.json', import.meta.url))).profiles;
const config = extra => validateConfig({ enabled: true, profiles, ...extra });
const answer = choice => ({ answers: { routing: { type: 'choice', choice } } });
const event = model => ({ tool: 'subagent', input: { agent: 'fixer', prompt: 'bounded task', ...(model ? { model } : {}) } });
const deps = choice => ({ env: { OPENROUTER_API_KEY: 'dummy' }, fetchImpl: async () => new Response(JSON.stringify(answer(choice))) });
test('profile criteria contain exactly allowed IDs and quality instruction', () => {
  const req = buildDecisionRequest(config(), 'task');
  assert.deepEqual(req.questions.routing.criteria, Object.fromEntries(Object.entries(profiles).map(([id,p]) => [id,p.description])));
  assert.match(req.questions.routing.instructions, /Prioritize quality/);
});
for (const [id,p] of Object.entries(profiles)) test(`routes exact ${id} and retains display choice`, async () => {
  const logs=[]; const router=createRouter(config(),{...deps(id), log:x=>logs.push(x)});
  const e=event('omniroute/heavy#max');
  assert.deepEqual(await router.handleEvent(e),{routed:true,choice:p.label,profile:id,effort:p.effort,model:p.model});
  assert.equal(e.input.model,p.model); assert.equal(logs[0].profile,id); assert.equal(logs[0].choice,p.label); assert.equal(logs[0].effort,p.effort);
  router.dispose();
});
test('strict response whitelist including prototype keys and wrong types', () => {
  for (const id of ['light','heavy','toString','__proto__','omniroute/heavy#xhigh',{},null,['heavy_high']]) assert.equal(validateDecisionResponse(answer(id),config()),null);
  assert.equal(validateDecisionResponse({answers:{routing:{type:'text',choice:'heavy_high'}}},config()),null);
});
test('invalid profile schemas are rejected without echoing secrets', () => {
  const bad=[null,[],{}, {SECRET:profiles.light_medium}, {light_medium:{...profiles.light_medium,model:'SECRET'}}, {light_medium:{...profiles.light_medium,effort:'high'}}, {light_medium:{...profiles.light_medium,label:'heavy'}}, {light_medium:{...profiles.light_medium,description:''}}, {light_medium:{...profiles.light_medium,SECRET:'SECRET'}}, {light_medium:{...profiles.light_medium,model:'omniroute/light#high'}}];
  for(const value of bad)assert.throws(()=>config({profiles:value}),e=>e.name==='ConfigError'&&!e.message.includes('SECRET'));
});
test('profiles determine eligible bases; pins and resume are untouched',async()=>{
  const cfg=config({profiles:{light_medium:{...profiles.light_medium,model:'custom/light#medium'}}});
  assert.equal(evaluateEvent(event('custom/light#high'),cfg).action,'classify');
  for(const model of ['omniroute/light','omniroute/heavy','other/pinned#high'])assert.equal(evaluateEvent(event(model),cfg).reason,'pinned-model');
  const e=event('custom/light#medium');e.input.sessionID='ses_existing';
  assert.equal(evaluateEvent(e,cfg).reason,'resume-session');
});
test('invalid answer and HTTP failure preserve original full target',async()=>{
  for(const fetchImpl of [deps('light').fetchImpl,async()=>new Response('{}',{status:503})]){
    const e=event('omniroute/light#high');const router=createRouter(config(),{...deps('light'),fetchImpl});
    assert.equal((await router.handleEvent(e)).routed,false);assert.equal(e.input.model,'omniroute/light#high');router.dispose();
  }
});
test('concurrent selections do not leak profile metadata',async()=>{
  const router=createRouter(config(),{env:{OPENROUTER_API_KEY:'dummy'},fetchImpl:async(_url,opts)=>new Response(JSON.stringify(answer(JSON.parse(opts.body).state.task)))});
  await Promise.all(Object.keys(profiles).map(async id=>{const e=event();e.input.prompt=id;assert.equal((await router.handleEvent(e)).profile,id);assert.equal(e.input.model,profiles[id].model);}));router.dispose();
});
test('custom model names and additional label/effort combinations are configurable',async()=>{
  const cfg=config({profiles:{heavy_medium:{model:'custom/team/model-v2#medium',label:'heavy',effort:'medium',description:'Custom balanced model'}}});
  const router=createRouter(cfg,deps('heavy_medium'));const e=event('custom/team/model-v2#high');
  assert.deepEqual(await router.handleEvent(e),{routed:true,choice:'heavy',profile:'heavy_medium',effort:'medium',model:'custom/team/model-v2#medium'});
  assert.equal(validateDecisionResponse(answer('heavy_high'),cfg),null);router.dispose();
});
test('legacy success has no profile or effort fields',async()=>{
  const router=createRouter(validateConfig({enabled:true}),deps('heavy'));const result=await router.handleEvent(event());
  assert.deepEqual(result,{routed:true,choice:'heavy',model:'omniroute/heavy'});router.dispose();
});
