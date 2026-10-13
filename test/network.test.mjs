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
  await assert.rejects(n.fetch('https://api.test'),e=>!e.message.includes('sensitive')&&/could not reach api.test/.test(e.message)&&e.transient===true);
  await n.close();
});
test('real CONNECT transport does not expose origin authorization to proxy',async()=>{
  const server=http.createServer();let observed;
  server.on('connect',(request,socket)=>{observed={url:request.url,headers:request.headers};socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const n=createNetwork({proxy:`http://127.0.0.1:${server.address().port}`},{env:{}});
  try {
    await assert.rejects(n.fetch('https://origin.example.test/file',{headers:{Authorization:'Bearer synthetic-origin'},signal:AbortSignal.timeout(3000)}),/through the configured proxy/);
    assert.equal(observed.url,'origin.example.test:443');assert.equal(observed.headers.authorization,undefined);
  }finally{await n.close();await new Promise(resolve=>server.close(resolve));}
});
test('bounded API responses reject malformed JSON without echoing contents',async()=>{
  await assert.rejects(boundedJSON(new Response('sensitive fixture invalid JSON')),e=>!e.message.includes('sensitive'));
  await assert.rejects(boundedJSON(new Response('a'.repeat(1048577))),/too large/);
});
test('network failures are named precisely and only transient ones retry',async()=>{
  const {networkError,retrying}=await import('../lib/network.mjs');
  const make=code=>Object.assign(new TypeError('fetch failed'),{cause:{code,message:'sensitive detail'}});
  assert.match(networkError(make('ENOTFOUND'),'api.test').message,/could not look up api.test/);
  const tls=networkError(make('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),'api.test');
  assert.match(tls.message,/not trusted.*NODE_EXTRA_CA_CERTS/);assert.equal(tls.transient,false);
  assert.equal(networkError(make('ECONNRESET'),'api.test').transient,true);
  const timeout=networkError(Object.assign(Error('x'),{name:'TimeoutError'}),'api.test');
  assert.match(timeout.message,/did not answer in time/);assert.equal(timeout.transient,true);
  const user=new AbortController();user.abort();
  assert.equal(networkError(make('ECONNRESET'),'api.test',user.signal).cancelled,true);
  for(const code of ['ENOTFOUND','ECONNRESET','CERT_HAS_EXPIRED'])assert.ok(!networkError(make(code),'api.test').message.includes('sensitive'));
  let calls=0;const delays=[];
  assert.equal(await retrying(async()=>{if(++calls<3)throw Object.assign(Error('busy'),{transient:true});return 'ok';},{wait:async ms=>delays.push(ms)}),'ok');
  assert.deepEqual(delays,[1000,2000]);
  calls=0;await assert.rejects(retrying(async()=>{calls++;throw Error('permanent');},{wait:async()=>{}}),/permanent/);assert.equal(calls,1);
});
