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
  return {
    async fetch(url, init={}) {
      let parsed;try{parsed=new URL(url);}catch{throw Error('Invalid bootstrap request URL');}
      if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.hash)throw Error('Bootstrap requires credential-free HTTPS request URLs');
      try{return await fetcher(parsed.href,{...init,redirect:'error',dispatcher});}
      catch {throw Error('Secure bootstrap request failed; check connection, proxy or certificate trust');}
    },
    close:()=>dispatcher.close()
  };
}
