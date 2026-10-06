import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deviceAuthorize} from '../lib/device.mjs';
const config={issuer:'https://identity.example.test/project',clientId:'public',api:'https://api.example.test',authOrigin:'https://auth.example.test'};
function fixture(changes={},tokens=[]){
  let now=0;const waits=[],requests=[],opened=[];
  const options={now:()=>now,wait:async ms=>{waits.push(ms);now+=ms;},open:url=>opened.push(url),fetch:async(url)=>{
    requests.push(url);let value;
    if(url.endsWith('openid-configuration'))value={issuer:config.issuer,device_authorization_endpoint:'https://identity.example.test/device',token_endpoint:'https://identity.example.test/token'};
    else if(url.endsWith('device'))value={device_code:'synthetic-device',user_code:'ABCD-EFGH',verification_uri:'https://auth.example.test/approve',expires_in:30,interval:1,...changes};
    else value=tokens.shift()||{error:'authorization_pending'};
    return new Response(JSON.stringify(value),{status:value.error?400:200});
  }};
  return {options,waits,requests,opened};
}
test('device pending/slow_down honors interval without persisting authority',async()=>{
  const f=fixture({},[{error:'authorization_pending'},{error:'slow_down'},{access_token:'synthetic-access'}]);
  assert.equal(await deviceAuthorize(config,f.options),'synthetic-access');
  assert.deepEqual(f.waits,[1000,1000,6000]);assert.equal(f.opened.length,1);
});
test('invalid approval origin/code/expiry never opens a browser',async()=>{
  for(const change of [{verification_uri_complete:'https://evil.example.test'},{user_code:'\x1b[31m'},{expires_in:0},{verification_uri:'https://auth.example.test/?access_token=private'},{interval:100000}]){
    const f=fixture(change);await assert.rejects(deviceAuthorize(config,f.options));assert.deepEqual(f.opened,[]);
  }
});
test('expiry stops before another token request; cancellation is explicit',async()=>{
  const f=fixture({expires_in:1,interval:5});await assert.rejects(deviceAuthorize(config,f.options),/expired/);
  assert.equal(f.requests.length,2);
  const controller=new AbortController();controller.abort();
  await assert.rejects(deviceAuthorize(config,{...f.options,signal:controller.signal}),/cancelled/);
});
