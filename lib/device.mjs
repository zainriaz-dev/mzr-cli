// Public-client authorization only. Credentials live in memory, never on disk.
function httpsURL(value, origin) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('Invalid authorization URL');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.origin !== origin) throw Error('Untrusted authorization URL');
  return u;
}
export async function boundedJSON(response) {
  if(!response.body)throw Error('Missing bootstrap response');
  const reader=response.body.getReader();let size=0;const parts=[];
  try { while(true) { const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>1048576)throw Error('Authorization response too large');parts.push(value); }
  } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}
  catch{throw Error('Invalid bootstrap JSON response');}
}
export async function deviceAuthorize(config, options={}) {
  const fetcher=options.fetch||fetch, now=options.now||Date.now;
  const signal=options.signal;
  const wait=options.wait||((ms)=>new Promise((resolve,reject)=>{
    const aborted=()=>{clearTimeout(timer);reject(Error('Authorization cancelled'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',aborted);resolve();},ms);
    if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});
  }));
  const issuer=new URL(config.issuer), origin=issuer.origin;
  httpsURL(config.issuer,origin);
  const request=async(url,body,remaining=20000)=>{
    if(signal?.aborted)throw Error('Authorization cancelled');
    const timeout=AbortSignal.timeout(Math.max(1,Math.min(20000,remaining)));
    const r=await fetcher(url,{method:body?'POST':'GET',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    return [r,await boundedJSON(r)];
  };
  const [discoveryResponse,discovery]=await request(config.issuer+'/.well-known/openid-configuration');
  if(!discoveryResponse.ok || discovery.issuer!==config.issuer)throw Error('OAuth project issuer mismatch');
  for(const key of ['device_authorization_endpoint','token_endpoint']){
    const u=httpsURL(discovery[key],origin);if(u.search)throw Error('Untrusted discovery query');
  }
  const [response,data]=await request(discovery.device_authorization_endpoint,{client_id:config.clientId,resource:config.api,scope:'openid profile email mzr.download'});
  const userCode=/^[A-Za-z0-9-]{4,32}$/;
  if(!response.ok || typeof data.device_code!=='string' || !data.device_code || data.device_code.length>4096 || typeof data.user_code!=='string' || !userCode.test(data.user_code) || !Number.isInteger(data.expires_in) || data.expires_in<1 || data.expires_in>1800)throw Error('Invalid device authorization');
  const approvalOrigin=config.authOrigin||'https://auth.zainriaz.dev';
  const base=new URL(approvalOrigin);httpsURL(approvalOrigin,base.origin);
  if(base.search || (base.pathname!=='/' && base.pathname!==''))throw Error('Invalid approval origin');
  const urls=[data.verification_uri,data.verification_uri_complete||data.verification_uri].map(value=>{
    const u=httpsURL(value,base.origin);for(const [key,v] of u.searchParams){if(key!=='user_code' || !userCode.test(v) || u.searchParams.getAll(key).length!==1)throw Error('Unexpected approval query');}return u;
  });
  let interval=data.interval??5;
  if(!Number.isInteger(interval) || interval<1 || interval>1800)throw Error('Invalid device polling interval');
  options.print?.(`Open ${urls[1]}\nConfirm code: ${data.user_code}`);
  options.open?.(urls[1].href);
  const deadline=now()+data.expires_in*1000;
  while(now()<deadline){
    await wait(Math.min(interval*1000,deadline-now()));
    if(signal?.aborted)throw Error('Authorization cancelled');
    if(now()>=deadline)break;
    const [r,token]=await request(discovery.token_endpoint,{client_id:config.clientId,grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:data.device_code},deadline-now());
    if(r.ok && typeof token.access_token==='string' && token.access_token && !/[\s\x00-\x1f]/.test(token.access_token) && token.access_token.length<=16384)return token.access_token;
    if(token.error==='slow_down')interval+=5;
    else if(token.error!=='authorization_pending')throw Error('Authorization denied or expired');
  }
  throw Error('Authorization expired');
}
