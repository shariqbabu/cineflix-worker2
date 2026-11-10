import { proxyMedia, corsHeaders } from './playlist.js';
import { resolveStream } from './moviebox.js';
import { validateMedia, publicUrl } from './media.js';

const inFlight=new Map(), cache=new Map();
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:corsHeaders({'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'})});
const enc=encodeURIComponent;
function clientResult(result,origin) {
  const raw=result.rawStreamUrl||result.streamUrl;
  const headers=result.headers||{};
  const ua=headers['User-Agent']||result.userAgent||'';
  const ref=result.referer||headers.Referer||'';
  const cookie=result.signCookie||'';
  const format=result.format||(/\.m3u8(?:\?|$)/i.test(raw)?'HLS':'MP4');
  const path=format==='HLS'||/\.m3u8(?:\?|$)/i.test(raw)?'/api/live/proxy.m3u8':'/api/live/chunk';
  const proxy=`${origin}${path}?url=${enc(raw)}&ref=${enc(ref)}&ua=${enc(ua)}${cookie?'&cookie='+enc(cookie):''}`;
  return {...result,success:true,validated:true,streamUrl:proxy,proxyUrl:proxy,rawStreamUrl:raw,headers,userAgent:ua,referer:ref,signCookie:cookie,format};
}
async function backendResolve(request,env,path,id,season,episode) {
  const configured=String(env.BACKEND_URL||'').trim().replace(/\/+$/,'');
  if(configured) {
    const backend=publicUrl(configured);
    if(backend.protocol!=='https:'||backend.origin===new URL(request.url).origin)throw Error('BACKEND_URL must be a separate trusted HTTPS backend');
    const target=new URL(path,backend.origin);
    if(season>0){target.searchParams.set('s',String(season));target.searchParams.set('e',String(episode));}
    const appKey=env.BACKEND_APP_KEY||request.headers.get('x-app-key')||'';
    const response=await fetch(target.href,{headers:{Accept:'application/json',...(appKey?{'x-app-key':appKey}:{})},redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(!response.ok){await response.body?.cancel();return {error:`Backend resolver HTTP ${response.status}`,status:response.status>=300&&response.status<400?502:response.status};}
    const data=await response.json();
    if(data.success!==true)return {error:'Backend returned no stream',status:404};
    const validated=await validateMedia(data);
    return validated?{data:validated}:{error:'Backend candidate failed media validation',status:404};
  }
  if(!path.startsWith('/api/resolve/'))return {error:'Set BACKEND_URL to enable this provider route',status:503};
  const found=await resolveStream({id,title:id,isSeries:season>0,season,episode,tmdbKey:env.TMDB_API_KEY});
  const validated=await validateMedia(found);
  return validated?{data:validated}:{error:'No validated MovieBox stream; configure BACKEND_URL for multi-provider fallback',status:404};
}
export default {
  async fetch(request,env={}) {
    const url=new URL(request.url), path=url.pathname;
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders()});
    if(!['GET','HEAD'].includes(request.method))return json({success:false,error:'Method not allowed'},405);
    try {
      if(path==='/'||path==='/health')return json({ok:true,service:'cineflix-verified-worker',mediaNormalization:true,backendConfigured:!!env.BACKEND_URL});
      const resolve=/^\/api\/resolve\/(.+)$/.exec(path);
      const custom=/^\/api\/stream\/(vidnest|slast|vidsrc|fourkhd|nitro)\/(.+)$/.exec(path);
      const idRoute=/^\/id\/([^/]+)(?:\/(\d+)\/(\d+))?\/(?:movie\/)?index\.m3u8$/.exec(path);
      const isApi=resolve||custom||idRoute||path==='/api/availability/direct'||path==='/api/workers';
      if(isApi && env.APP_SECRET_KEY && request.headers.get('x-app-key')!==env.APP_SECRET_KEY)return json({success:false,error:'Unauthorized'},401);
      if(path==='/api/workers')return json({success:true,workers:[url.origin]});
      if(path==='/api/availability/direct') {
        const result=await validateMedia({streamUrl:url.searchParams.get('url')||''});
        return json({success:!!result,validated:!!result});
      }
      if(resolve||custom||idRoute) {
        if(custom?.[1]==='nitro')return json({success:false,error:'Nitro disabled: upstream decryption is not repaired'},410);
        const id=decodeURIComponent(resolve?.[1]||custom?.[2]||idRoute?.[1]||'');
        const season=Math.max(0,parseInt(url.searchParams.get('s')||idRoute?.[2]||'0',10)||0);
        const episode=Math.max(0,parseInt(url.searchParams.get('e')||idRoute?.[3]||'0',10)||0);
        // fourkhd/vidsrc legacy selectors use the compatible Auto backend rather than nonexistent route aliases.
        const apiPath=custom&&['vidnest','slast'].includes(custom[1])?`/api/stream/${custom[1]}/${enc(id)}`:`/api/resolve/${enc(id)}`;
        const key=JSON.stringify([env.BACKEND_URL,request.headers.get('x-app-key'),apiPath,season,episode]);
        let result=cache.get(key)?.until>Date.now()?cache.get(key).value:null;
        if(!result){
          let pending=inFlight.get(key);
          if(!pending){pending=backendResolve(request,env,apiPath,id,season,episode).finally(()=>inFlight.delete(key));inFlight.set(key,pending);}
          result=await pending;
          if(result.data){if(cache.size>300)cache.delete(cache.keys().next().value);cache.set(key,{value:result,until:Date.now()+20000});}
        }
        if(!result.data)return json({success:false,error:result.error},result.status||404);
        const output=clientResult(result.data,url.origin);
        if(idRoute)return Response.redirect(output.proxyUrl,302);
        return json(output);
      }
      if(['/api/live/proxy.m3u8','/api/live/sub.m3u8','/api/proxy','/api/mb','/api/live/chunk'].includes(path)) {
        const target=url.searchParams.get('url')||url.searchParams.get('u');
        if(!target)return json({success:false,error:'Missing url'},400);
        return await proxyMedia(target,request,url.origin,path.endsWith('.m3u8'));
      }
      return json({success:false,error:'Unknown route'},404);
    } catch(e) {return json({success:false,error:e.name==='TimeoutError'?'Upstream timeout':e.message},502);}
  }
};
