import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {networkOptions,createNetwork} from '../lib/network.mjs';
import {boundedJSON} from '../lib/device.mjs';

test('bootstrap proxy flags are explicit and removed before client launch',()=>{
  assert.deepEqual(networkOptions(['install','--bootstrap-proxy','http://proxy.test:8080','--no-browser']),{proxy:'http://proxy.test:8080',useEnvironment:false,forwarded:['install','--no-browser']});
  assert.throws(()=>networkOptions(['--bootstrap-proxy']),/required/);
  assert.throws(()=>networkOptions(['--bootstrap-proxy','http://p.test','--bootstrap-proxy-env']),/not both/);
});
test('direct is isolated, environment opt-in snapshots exclusions and rejects credentials',async()=>{
  let kind,options,request;
  const deps={env:{HTTP_PROXY:'http://p.test:8080',NO_PROXY:'internal.test'},makeDispatcher:(k,o)=>{kind=k;options=o;return {close:async()=>{}};},fetch:async(url,init)=>{request={url,init};return new Response('ok');}};
  let n=createNetwork({},deps);assert.equal(kind,'direct');await n.fetch('https://api.test/v1',{redirect:'follow'});assert.equal(request.init.redirect,'error');await n.close();
  n=createNetwork({useEnvironment:true},deps);assert.equal(kind,'environment');assert.deepEqual(options,{httpProxy:'http://p.test:8080',httpsProxy:'http://p.test:8080',noProxy:'internal.test'});await n.close();
  for(const proxy of ['http://user:password@p.test','http://p.test/path','socks5://p.test',''])assert.throws(()=>createNetwork({proxy},deps));
  assert.throws(()=>createNetwork({useEnvironment:true},{...deps,env:{HTTPS_PROXY:'http://user:password@p.test'}}),/without credentials/);
  assert.throws(()=>createNetwork({}, {...deps,env:{NODE_TLS_REJECT_UNAUTHORIZED:'0'}}),/TLS verification/);
});
test('request policy rejects plaintext and redacts low-level proxy failures',async()=>{
  const n=createNetwork({}, {env:{},makeDispatcher:()=>({close:async()=>{}}),fetch:async()=>{throw Error('sensitive fixture error');}});
  await assert.rejects(n.fetch('http://api.test'),/HTTPS/);
  await assert.rejects(n.fetch('https://api.test'),e=>!e.message.includes('sensitive')&&e.message.includes('Secure bootstrap'));
  await n.close();
});
test('real CONNECT transport does not expose origin authorization to proxy',async()=>{
  const server=http.createServer();let observed;
  server.on('connect',(request,socket)=>{observed={url:request.url,headers:request.headers};socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const n=createNetwork({proxy:`http://127.0.0.1:${server.address().port}`},{env:{}});
  try {
    await assert.rejects(n.fetch('https://origin.example.test/file',{headers:{Authorization:'Bearer synthetic-origin'},signal:AbortSignal.timeout(3000)}),/Secure bootstrap/);
    assert.equal(observed.url,'origin.example.test:443');assert.equal(observed.headers.authorization,undefined);
  }finally{await n.close();await new Promise(resolve=>server.close(resolve));}
});
test('bounded API responses reject malformed JSON without echoing contents',async()=>{
  await assert.rejects(boundedJSON(new Response('sensitive fixture invalid JSON')),e=>!e.message.includes('sensitive'));
  await assert.rejects(boundedJSON(new Response('a'.repeat(1048577))),/too large/);
});
