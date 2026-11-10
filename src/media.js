// Shared Web-API-only media inspection. No Node globals required on Cloudflare.
export function publicUrl(value) {
  const u=new URL(value); const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw Error('Invalid media URL');
  if (h==='localhost' || !h.includes('.') || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':') || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.)/.test(h)) throw Error('Non-public media URL');
  return u;
}
export async function fetchPublic(value,options={}) {
  let url=publicUrl(value);let headers=new Headers(options.headers);
  for(let i=0;i<5;i++) {
    const r=await fetch(url.href,{...options,headers,redirect:'manual'});
    if(![301,302,303,307,308].includes(r.status))return {response:r,url:url.href};
    const location=r.headers.get('location');await r.body?.cancel();if(!location)throw Error('Invalid redirect');
    const next=publicUrl(new URL(location,url).href);
    if(next.origin!==url.origin){headers.delete('cookie');headers.delete('authorization');}
    url=next;
  }
  throw Error('Too many redirects');
}
export async function readBounded(response,max=16*1024*1024,prefixOnly=false) {
  const reader=response.body?.getReader();if(!reader)throw Error('Empty media');let size=0;const parts=[];
  try {while(true){const p=await reader.read();if(p.done)break;const value=prefixOnly?p.value.subarray(0,max-size):p.value;size+=value.length;if(size>max)throw Error('Media segment exceeds 16 MiB limit');parts.push(value);if(prefixOnly&&size>=max)break;}}
  finally{await reader.cancel().catch(()=>{});}
  const out=new Uint8Array(size);let pos=0;for(const part of parts){out.set(part,pos);pos+=part.length;}return out;
}
export function tsOffset(b) { for(let i=0;i<Math.min(8192,b.length-752);i++)if([0,188,376,564,752].every(d=>b[i+d]===71))return i;return -1; }
export function normalizeSegment(b,type='') {
  const png=[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);const jpg=b[0]===255&&b[1]===216&&b[2]===255;const offset=tsOffset(b);
  if(offset===0||((png||jpg)&&offset>0))return {bytes:b.subarray(offset),type:'video/mp2t',removed:offset};
  if(/^image\//i.test(type)||png||jpg||/^\s*(<!doctype|<html)/i.test(new TextDecoder().decode(b.subarray(0,200))))throw Error('Image/HTML response is not a media segment');
  return {bytes:b,type:type||'application/octet-stream',removed:0};
}
export function byteRange(header,total) {
  if(!header)return null;const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||(!m[1]&&!m[2]))return false;
  let start,end;if(!m[1]){const n=Number(m[2]);if(n<=0||!Number.isSafeInteger(n))return false;start=Math.max(0,total-n);end=total-1;}
  else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),total-1):total-1;}
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<total&&end>=start?{start,end}:false;
}
async function probe(url,headers,signal,depth=0,encrypted=false) {
  const {response:r,url:final}=await fetchPublic(url,{headers:{...headers,Range:'bytes=0-65535'},signal});
  if(!r.ok){await r.body?.cancel();return false;}const b=await readBounded(r,65536,true);if(!b.length)return false;
  const text=new TextDecoder().decode(b).trimStart();
  if(/^\s*(<!doctype|<html|\{|\[)/i.test(text))return false;
  if(text.startsWith('#EXTM3U')){
    if(depth>=3)return false;
    const key=text.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
    if(key){const {response:k}=await fetchPublic(new URL(key[1],final).href,{headers,signal});if(!k.ok){await k.body?.cancel();return false;}if((await readBounded(k,1024)).length!==16)return false;}
    const child=text.split(/\r?\n/).map(s=>s.trim()).find(s=>s&&!s.startsWith('#'));
    return child?probe(new URL(child,final).href,headers,signal,depth+1,!!key || encrypted):false;
  }
  const box=new TextDecoder().decode(b.subarray(4,8));
  return ['ftyp','styp','moof'].includes(box)||[26,69,223,163].every((v,i)=>b[i]===v)||tsOffset(b)>=0 || (encrypted && depth > 0 && b.length >= 16 && b.length % 16 === 0);
}
export async function validateMedia(result) {
  const url=result?.rawStreamUrl||result?.streamUrl;if(!url)return null;
  const headers={...(result.headers||{})};if(result.referer)headers.Referer=result.referer;
  if(result.userAgent&&!headers['User-Agent'])headers['User-Agent']=result.userAgent;
  if(result.signCookie)headers.Cookie=result.signCookie;
  try{return await probe(url,headers,AbortSignal.timeout(4500))?{...result,rawStreamUrl:url,validated:true}:null;}catch(_){return null;}
}
