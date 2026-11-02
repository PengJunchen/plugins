import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MagpieHost,findBun,findMagpieHost} from './host-process.mjs'
const bun=findBun(),hostPath=findMagpieHost()
test('cloud transport reuses native task and returns tool results through explicit production Magpie host',{skip:!bun||!hostPath?'Set MAGPIE_HOST and MAGPIE_BUN':false,timeout:30000},async t=>{
 const temp=mkdtempSync(join(tmpdir(),'comate-cloud-host-'));t.after(()=>rmSync(temp,{recursive:true,force:true}))
 const payloads=[]
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  const body=JSON.parse(raw)
  res.setHeader('content-type','application/json')
  if(req.url.endsWith('/available'))return res.end(JSON.stringify({code:0,data:[{modelId:'cloud-live',displayName:'Cloud Fixture'}]}))
  if(req.url.endsWith('/conversation'))return res.end(JSON.stringify({code:0,data:{id:1}}))
  if(req.url.endsWith('/task'))return res.end(JSON.stringify({code:0,data:{taskId:2}}))
  assert.ok(req.url.endsWith('/execute'));payloads.push(body)
  const done={content:{type:'ANSWER',detail:{end:true}}}
  const name=body.tools[0].function.name
  const events=body.toolUseResults.some(result=>result.message==='CLIENT_TOOL_RESULT')?[{content:{type:'ANSWER',detail:{delta:'CLIENT_TOOL_RESULT',end:true}}}]:[
   {content:{type:'FUNCTION_CALL_START',detail:{toolUse:[{id:'a',name,input:{text:'client value'}}]}}},
   {content:{type:'FUNCTION_CALL_END',detail:{toolUse:[{id:'a',name,input:{}}]}}},done]
  res.setHeader('content-type','text/event-stream');res.end(events.map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''))
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
 const entry=join(temp,'entry.mjs'),settings=join(temp,'settings.json');writeFileSync(settings,JSON.stringify({'baidu.comate.license':'fake-host-license'}))
 writeFileSync(entry,`import {ComateAuthPlugin as plugin} from ${JSON.stringify(new URL('./index.mjs',import.meta.url).href)};export const ComateAuthPlugin=(input)=>plugin(input,{fetchImpl:globalThis.fetch,cloudOrigin:'http://127.0.0.1:${server.address().port}',discoveryOptions:{settingsPath:${JSON.stringify(settings)}}});`)
 const host=new MagpieHost({bun,host:hostPath,cwd:temp});t.after(()=>host.close())
 await host.call('init',{authPath:join(temp,'auth.json'),directory:temp,config:{},plugins:[{spec:'cloud-test',target:entry}]})
 const p=(await host.call('providers')).find(x=>x.id==='comate');const a=await host.call('authorize',{provider:'comate',method:p.methods.findIndex(x=>x.type==='oauth'),inputs:{}});const signed=await host.call('callback',{session:a.session});assert.equal(signed.ok,true)
 const models=(await host.call('providers')).find(x=>x.id==='comate').models;assert.ok(models.some(x=>x.id==='cloud-live'));await host.call('load',{provider:'comate',account:signed.account})
 const messages=[{role:'user',content:'Use echo'}],tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}}}}}]
 async function request(){const r=await host.fetch({provider:'comate',account:signed.account,model:'cloud-live',npm:'@ai-sdk/openai-compatible',url:'https://comate.baidu.com/v1/chat/completions',method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({model:'cloud-live',messages,tools})).toString('base64'),session:'cloud-host-session'});assert.equal(r.status,200,r.body.toString());return JSON.parse(r.body).choices[0].message}
 const first=await request();assert.equal(first.tool_calls[0].function.name,'echo');messages.push(first,{role:'tool',tool_call_id:first.tool_calls[0].id,content:'CLIENT_TOOL_RESULT'});assert.equal((await request()).content,'CLIENT_TOOL_RESULT');assert.equal(payloads.length,2);assert.equal(payloads[1].isFirstQuery,false);assert.equal(payloads[1].conversationId,payloads[0].conversationId);assert.equal(payloads[1].taskId,payloads[0].taskId);assert.equal(payloads[1].toolUseResults[0].id,'a');assert.equal(payloads[1].toolUseResults[0].message,'CLIENT_TOOL_RESULT')
})
