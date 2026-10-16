import http from 'node:http';
import { spawn } from 'node:child_process';
export const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(x => typeof x === 'string' ? x : x.text ?? '').join('\n') : '';
export const wire = model => model.replace(/^mock\//, '');
// Unequivocal semantic tasks for real-decisions classification. The easy task is
// a routine bounded edit; the complex task requires architectural diagnosis.
export const REAL_TASKS = {
  easy: 'Rename the variable "count" to "total" in the file src/count.js and update its two references. No behavior change.',
  complex: 'Diagnose intermittent deadlocks across three worker pools sharing a connection pool, propose a redesign of the locking and backpressure architecture with failure modes, and evaluate migration risks.',
};
const FIXTURE_TASK = id => `ROUTER_CASE:${id} CHILD_${id} Return DONE_${id}.`;
export const decision = choice => ({answers:{routing:{type:'choice',choice}}});
export function completion(res, request, message) {
  const base = {id:'chatcmpl-fixture',created:1,model:request.model};
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  if (!request.stream) { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message,finish_reason:finish}]})); return; }
  res.writeHead(200,{'content-type':'text/event-stream'});
  const chunk = (delta, finish_reason=null) => res.write(`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  chunk({role:'assistant'});
  chunk(message.tool_calls ? {tool_calls:message.tool_calls.map((c,index)=>({index,...c}))} : {content:message.content});
  chunk({},finish); res.end('data: [DONE]\n\n');
}
export async function server(handler) {
  const timers=new Set();
  const s=http.createServer(async(req,res)=>{try {let raw=''; for await(const c of req) raw+=c; await handler(JSON.parse(raw||'{}'),req,res,timers);} catch(e){if(!res.headersSent)res.writeHead(500);res.end(String(e));}});
  await new Promise(r=>s.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${s.address().port}`,close:async()=>{for(const t of timers)clearTimeout(t);s.closeAllConnections();await new Promise(r=>s.close(r));}};
}
export function runProcess(bin,args,options,timeout=45000) {
  return new Promise(resolve=>{
    const p=spawn(bin,args,{...options,detached:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',expired=false,kill;
    const signal=s=>{try{process.kill(-p.pid,s)}catch{}};
    const timer=setTimeout(()=>{expired=true;signal('SIGTERM');kill=setTimeout(()=>signal('SIGKILL'),1000);},timeout);
    p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);
    p.on('error',e=>{stderr+=e.message;});
    p.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(kill);resolve({code,signal,expired,stdout,stderr});});
  });
}
export class Worker {
  constructor(id,options={}) {this.id=id;this.options=options;this.phase='initial';this.rows=[];this.callId=`call-${id}`;this.schema=null;this.results=[];this.taskText=REAL_TASKS[options.taskKey]??FIXTURE_TASK(id);}
  respond(b) {
    if(this.rows.length>=24) throw new Error('request cap exceeded');
    const messages=b.messages??[], last=messages.at(-1)??{};
    const result=messages.findLast(m=>m.tool_call_id===this.callId);
    const child=!result&&messages.some(m=>m.role==='user'&&text(m.content).includes(`CHILD_${this.id}`))||this.options.taskKey&&messages.some(m=>m.role==='user'&&text(m.content).includes(this.taskText.slice(0,40)));
    const native=(b.tools??[]).find(t=>t.function?.name==='subagent');
    const role=child?'child':result?'parent-result':native?'parent':'auxiliary';
    this.toolSchemas=b.tools??this.toolSchemas;
    const row={role,model:b.model,reasoning_effort:b.reasoning_effort,reasoning:b.reasoning,stream:b.stream,tools:(b.tools??[]).map(t=>t.function?.name),phase:this.phase};this.rows.push(row);
    if(child)return {role:'assistant',content:`DONE_${this.id}`};
    if(result){
      this.results.push(result);
      if(this.resume && !this.resumed){
        const sessionID=this.sessionID??text(result.content).match(/sessionID[=:][\s"']*(ses_[A-Za-z0-9]+)/)?.[1];
        if(!sessionID)throw new Error('completed tool result lacks sessionID');
        this.sessionID=sessionID;
        if(this.omo && !this.acknowledged){
          this.acknowledged=true;this.callId+='-ack';
          const tool=this.toolSchemas.find(t=>t.function?.name==='task_result');
          const props=tool?.function.parameters.properties??{};
          const key=Object.keys(props).find(k=>/session|task|id/i.test(k));
          if(!key)throw new Error('task_result schema missing task reference');
          return {role:'assistant',content:null,tool_calls:[{id:this.callId,type:'function',function:{name:'task_result',arguments:JSON.stringify({[key]:sessionID})}}]};
        }
        this.resumed=true;this.callId+= '-resume';this.phase='delegated';
        return {role:'assistant',content:null,tool_calls:[{id:this.callId,type:'function',function:{name:'subagent',arguments:JSON.stringify({agent:'fixer',description:'Resume child',sessionID,...(this.omo?{model:this.options.resumeModel??`mock/${wire(this.rows.find(r=>r.role==='child').model)}`} : {}),prompt:`ROUTER_CASE:${this.id} CHILD_${this.id} Resume and return done.`})}}]};
      }
      this.phase='final';return {role:'assistant',content:'PARENT_DONE'};
    }
    if(!native)return {role:'assistant',content:'Fixture title'};
    if(this.phase!=='initial')throw new Error(`unexpected parent phase ${this.phase}`);
    this.schema=native.function.parameters;
    for(const k of ['agent','description','prompt','model','background','sessionID'])if(!this.schema.properties[k])throw new Error(`native schema missing ${k}`);
    this.phase='delegated';
    const {taskKey,resumeModel,...nativeOptions}=this.options;
    const args={agent:'fixer',description:'Fixture child',prompt:this.taskText,...nativeOptions};
    row.args=args;return {role:'assistant',content:null,tool_calls:[{id:this.callId,type:'function',function:{name:'subagent',arguments:JSON.stringify(args)}}]};
  }
}
