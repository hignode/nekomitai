/**
 * URL rewriting for the Web Mode proxy. Rewrites document/stylesheet URLs so
 * every sub-resource and navigation flows back through /proxy, and injects a
 * small runtime that catches dynamic requests (fetch/XHR/clicks/forms).
 *
 * This is a pragmatic rewriter: it makes ordinary sites browse well. Heavy
 * SPAs (service workers, signed media, DRM playback) remain best-effort by
 * design — see the blueprint's Web Mode tier.
 */

/** Build a proxied URL for an absolute target.
 * proxyBase may already carry a query (the session token), so pick the
 * right separator. */
export const proxify = (absUrl: string, proxyBase: string): string => {
  if (
    !absUrl ||
    absUrl.startsWith("data:") ||
    absUrl.startsWith("blob:") ||
    absUrl.startsWith("javascript:") ||
    absUrl.startsWith("mailto:") ||
    absUrl.startsWith("#")
  )
    return absUrl;
  const sep = proxyBase.includes("?") ? "&" : "?";
  return `${proxyBase}${sep}url=${encodeURIComponent(absUrl)}`;
};

/** Decode HTML entities in an attribute URL (esp. &amp; in query strings —
 * otherwise `?a=1&amp;b=2` proxies as a broken `amp;b` param). */
const htmlDecode = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'");

const absolutize = (url: string, base: string): string => {
  try {
    return new URL(htmlDecode(url), base).href;
  } catch {
    return url;
  }
};

const rewriteSrcset = (val: string, base: string, proxyBase: string): string =>
  val
    .split(",")
    .map((part) => {
      const seg = part.trim();
      const sp = seg.indexOf(" ");
      const url = sp < 0 ? seg : seg.slice(0, sp);
      const desc = sp < 0 ? "" : seg.slice(sp);
      return proxify(absolutize(url, base), proxyBase) + desc;
    })
    .join(", ");

export const rewriteCss = (
  css: string,
  base: string,
  proxyBase: string
): string =>
  css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q, url) => {
      if (url.startsWith("data:")) return `url(${q}${url}${q})`;
      return `url(${q}${proxify(absolutize(url, base), proxyBase)}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q, url) => {
      return `@import ${q}${proxify(absolutize(url, base), proxyBase)}${q}`;
    });

const RUNTIME = (proxyBase: string, origin: string, pageUrl: string) => `
<script>(function(){
  var PROXY=${JSON.stringify(proxyBase)}, ORIGIN=${JSON.stringify(origin)};
  var REAL=${JSON.stringify(pageUrl)};
  function abs(u){try{return new URL(u,REAL).href}catch(e){return u}}
  function px(u){
    if(!u||/^(data:|blob:|javascript:|mailto:|#)/.test(u))return u;
    if(u.indexOf(PROXY)===0)return u;
    var sep=PROXY.indexOf("?")>=0?"&":"?";
    return PROXY+sep+"url="+encodeURIComponent(abs(u));
  }
  var of=window.fetch;
  if(of)window.fetch=function(i,init){
    try{ if(typeof i==="string")i=px(i);
      else if(i&&i.url)i=new Request(px(i.url),i); }catch(e){}
    return of.call(this,i,init);
  };
  var xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{arguments[1]=px(u)}catch(e){}
    return xo.apply(this,arguments);
  };
  var wo=window.open;
  // popups can't open inside the panel — a window.open jump navigates THIS
  // frame instead, so "open in new tab" links land in the current tab and the
  // next page reports its real URL up via the nav message
  window.open=function(u){
    try{ if(u&&!/^about:/.test(String(u))){location.href=px(String(u));return null;} }catch(e){}
    return wo.apply(this,arguments);
  };
  document.addEventListener("click",function(e){
    var a=e.target&&e.target.closest&&e.target.closest("a[href]");
    if(!a)return;
    var h=a.getAttribute("href");
    if(!h||/^(#|javascript:|mailto:)/.test(h))return;
    e.preventDefault();
    // navigate THIS frame (never the panel) — the next page's runtime
    // reports its real URL back up via the nav message below
    location.href=px(h);
  },true);
  document.addEventListener("submit",function(e){
    var f=e.target; if(!f||f.method&&f.method.toLowerCase()==="post")return;
    var action=f.getAttribute("action")||ORIGIN;
    try{f.setAttribute("action",px(action))}catch(e2){}
  },true);

  // ── panel integration: report the real URL + duck/volume control ──
  try{if(parent!==window)parent.postMessage({nm:"nav",url:REAL},"*");}catch(e){}
  var MUSIC=false;
  try{MUSIC=/(open\\.spotify\\.com|(^|\\.)soundcloud\\.com|(^|\\.)bandcamp\\.com|music\\.apple\\.com|(^|\\.)deezer\\.com|(^|\\.)tidal\\.com|music\\.youtube\\.com)/i.test(new URL(REAL).host);}catch(e){}
  var ducked=false, hit=[], wantVol=-1, duckTimer=null;
  function media(){return document.querySelectorAll("video,audio");}
  function tell(m){try{parent.postMessage({nm:"duckState",mode:m},"*");}catch(e){}}
  function applyDuck(){
    var els=media();
    for(var i=0;i<els.length;i++){var m=els[i];
      if(MUSIC){ if(!m.paused&&hit.indexOf(m)<0){try{m.pause();hit.push(m);}catch(e){}} }
      else { if(!m.muted&&hit.indexOf(m)<0){try{m.muted=true;hit.push(m);}catch(e){}} }
    }
  }
  function setDuck(on){
    if(on&&!ducked){
      ducked=true;hit=[];applyDuck();
      duckTimer=setInterval(applyDuck,400); // catch media that starts mid-duck
      tell(MUSIC?"paused":"muted");
    } else if(!on&&ducked){
      ducked=false;
      if(duckTimer){clearInterval(duckTimer);duckTimer=null;}
      for(var i=0;i<hit.length;i++){try{ if(MUSIC)hit[i].play(); else hit[i].muted=false; }catch(e){}}
      hit=[];
      tell(null);
    }
  }
  function applyVol(){ if(wantVol<0)return; var els=media(); for(var i=0;i<els.length;i++){try{els[i].volume=wantVol;}catch(e){}} }
  setInterval(applyVol,800);
  window.addEventListener("message",function(e){
    var d=e.data; if(!d||d.nm!=="cmd")return;
    if(d.action==="duck")setDuck(true);
    else if(d.action==="resume")setDuck(false);
    else if(d.action==="volume"){wantVol=Math.max(0,Math.min(1,+d.value||0));applyVol();}
    // cascade into nested proxied frames (embedded players duck too)
    for(var i=0;i<window.frames.length;i++){try{window.frames[i].postMessage(d,"*");}catch(err){}}
  });
})();</script>`;

export const rewriteHtml = (
  html: string,
  base: string,
  proxyBase: string,
  origin: string
): string => {
  let out = html;

  // drop meta CSP + SRI (we alter resources; both would break the page)
  out = out.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    ""
  );
  out = out.replace(/\sintegrity=(["'])[^"']*\1/gi, "");
  // drop <base> — it would resolve relative URLs off our proxy origin
  out = out.replace(/<base\b[^>]*>/gi, "");
  // strip service-worker registrations (their scope breaks under the proxy)
  out = out.replace(
    /navigator\.serviceWorker\s*\.\s*register\s*\([^)]*\)/gi,
    "Promise.reject()"
  );

  // attribute URLs
  const attrs = ["href", "src", "poster", "action", "formaction", "data-src"];
  for (const attr of attrs) {
    const re = new RegExp(`(\\s${attr}=)(["'])([^"']*)\\2`, "gi");
    out = out.replace(re, (_m, pre, q, url) => {
      if (/^(data:|blob:|javascript:|mailto:|#|about:)/.test(url))
        return `${pre}${q}${url}${q}`;
      return `${pre}${q}${proxify(absolutize(url, base), proxyBase)}${q}`;
    });
  }

  // srcset
  out = out.replace(
    /(\ssrcset=)(["'])([^"']*)\2/gi,
    (_m, pre, q, val) => `${pre}${q}${rewriteSrcset(val, base, proxyBase)}${q}`
  );

  // inline <style> blocks and style="" url()
  out = out.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => open + rewriteCss(css, base, proxyBase) + close
  );

  // inject runtime as early as possible
  if (/<head[^>]*>/i.test(out))
    out = out.replace(/<head[^>]*>/i, (m) => m + RUNTIME(proxyBase, origin, base));
  else out = RUNTIME(proxyBase, origin, base) + out;

  return out;
};
