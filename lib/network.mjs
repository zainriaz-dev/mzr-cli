import {Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch} from 'undici';

// Bootstrap-only options never forward proxy credentials to the Go client.
export function networkOptions(args) {
  let proxy, useEnvironment=false;
  const forwarded=[];
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--bootstrap-proxy') {
      if(proxy!==undefined || !args[i+1] || args[i+1].startsWith('--'))throw Error('One bootstrap proxy URL is required');
      proxy=args[++i];
    } else if(args[i]==='--bootstrap-proxy-env') {
      if(useEnvironment)throw Error('Duplicate proxy environment option');
      useEnvironment=true;
    } else forwarded.push(args[i]);
  }
  if(proxy!==undefined && useEnvironment)throw Error('Select a proxy URL or proxy environment, not both');
  return {proxy,useEnvironment,forwarded};
}
function proxyURL(value) {
  if(!value)return '';
  let url;try {url=new URL(value);}catch {throw Error('Invalid bootstrap proxy URL');}
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname!=='/')throw Error('Proxy must be an HTTP(S) origin without credentials or extra URL components');
  return url.origin;
}
export function createNetwork(options={}, dependencies={}) {
  const env=dependencies.env||process.env;
  // No silent proxy environment/TLS downgrade or shared global dispatcher.
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error('Bootstrap requires TLS verification; insecure runtime option refused');
  const make=dependencies.makeDispatcher||((kind,config)=>kind==='proxy'?new ProxyAgent(config):kind==='environment'?new EnvHttpProxyAgent(config):new Agent());
  let dispatcher;
  if(options.proxy!==undefined) {
    const origin=proxyURL(options.proxy);
    if(!origin)throw Error('Bootstrap proxy URL is empty');
    dispatcher=make('proxy',origin);
  }
  else if(options.useEnvironment) {
    const http=proxyURL(env.http_proxy??env.HTTP_PROXY??'');
    const https=proxyURL(env.https_proxy??env.HTTPS_PROXY??http);
    const noProxy=env.no_proxy??env.NO_PROXY??'';
    if(noProxy.length>4096 || /[\x00-\x1f]/.test(noProxy))throw Error('Invalid proxy exclusion list');
    dispatcher=make('environment',{httpProxy:http,httpsProxy:https,noProxy});
  } else dispatcher=make('direct');
  const fetcher=dependencies.fetch||undiciFetch;
  const viaProxy=options.proxy!==undefined || !!options.useEnvironment;
  return {
    async fetch(url, init={}) {
      let parsed;try{parsed=new URL(url);}catch{throw Error('Invalid bootstrap request URL');}
      if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.hash)throw Error('Bootstrap requires credential-free HTTPS request URLs');
      try{return await fetcher(parsed.href,{...init,redirect:'error',dispatcher});}
      catch(error){throw networkError(error,parsed.host,init.signal,viaProxy);}
    },
    close:()=>dispatcher.close()
  };
}

// networkError turns a low-level failure into a specific, actionable message
// without echoing the library's text (which may carry proxy or header details).
// Transient failures are marked so callers can retry instead of giving up.
const TLS=/CERT|SELF_SIGNED|UNABLE_TO_|DEPTH_ZERO|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH/;
const DROPPED=new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ENETDOWN','ECONNABORTED','EAI_AGAIN',
  'UND_ERR_SOCKET','UND_ERR_CLOSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
export function networkError(error,host,signal,viaProxy=false) {
  const named=(message,transient)=>Object.assign(Error(message),{transient});
  if(signal?.aborted && signal.reason?.name!=='TimeoutError')return Object.assign(Error('Cancelled'),{cancelled:true});
  if(error?.name==='TimeoutError' || signal?.reason?.name==='TimeoutError')return named(`${host} did not answer in time`,true);
  const raw=String(error?.cause?.code||error?.code||'');
  const code=/^[A-Z0-9_]{2,48}$/.test(raw)?raw:'';
  if(code==='ENOTFOUND')return named(`could not look up ${host}; check your internet connection or DNS`,true);
  if(TLS.test(code))return named(`the certificate presented for ${host} is not trusted (${code}). Behind a company proxy that inspects HTTPS, set NODE_EXTRA_CA_CERTS to its root certificate`,false);
  if(code.startsWith('UND_ERR_PROXY') || /proxy/i.test(String(error?.cause?.message||'')))return named(`the proxy refused the connection to ${host}`,false);
  if(DROPPED.has(code))return named(`the connection to ${host} was interrupted (${code})`,true);
  return named(`could not reach ${host}${viaProxy?' through the configured proxy':''}${code?` (${code})`:''}`,true);
}
// retrying runs task again after transient failures with growing pauses
// (1s, 2s, 4s, 8s). Cancellation and permanent errors stop immediately.
export async function retrying(task,{attempts=4,signal,onRetry,wait=pause}={}) {
  for(let attempt=1;;attempt++) {
    try{return await task(attempt);}
    catch(error) {
      if(!error?.transient || attempt>=attempts || signal?.aborted)throw error;
      const delay=Math.min(8000,1000*2**(attempt-1));
      onRetry?.(error,attempt,delay);
      await wait(delay,signal);
    }
  }
}
function pause(ms,signal) {
  return new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);reject(Object.assign(Error('Cancelled'),{cancelled:true}));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
  });
}
