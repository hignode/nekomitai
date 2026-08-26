/**
 * The view-surface page served at /view — the localhost-origin page that
 * actually hosts web content inside a tab. It never gets Node access (the
 * panel does not run --mixed-context) and talks to the panel shell only via
 * postMessage ({ nm: "openExternal" | "title" | "nav" | "meta" | "route", ... }).
 */
import type { EmbedResolution } from "./embed";

type EmbedTier = Extract<EmbedResolution, { kind: "embed" }>;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Transport glyphs as inline SVG — the panel's icons are SVG for the same
 * reason (emoji render inconsistently in CEP's Chromium), and view pages can't
 * import icons.tsx. */
const svg = (d: string) =>
  `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${d}</svg>`;
const ICON_PLAY = svg('<path d="M4.5 2.8v10.4L13 8z"/>');
const ICON_PAUSE = svg('<path d="M4.6 3h2.5v10H4.6zM8.9 3h2.5v10H8.9z"/>');
const ICON_PREV = svg('<path d="M4 3h1.7v10H4zM13 3.2v9.6L6.5 8z"/>');
const ICON_NEXT = svg('<path d="M10.3 3H12v10h-1.7zM3 3.2 9.5 8 3 12.8z"/>');
const ICON_SHUFFLE = svg(
  '<path fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'd="M1 4.5h3l7 7h2.5M1 11.5h3l2.3-2.3M8.7 6.8 11 4.5h2.5"/>' +
    '<path d="M12.7 2 16 4.5l-3.3 2.5zM12.7 9 16 11.5l-3.3 2.5z"/>'
);

const SHELL_CSS = `
  html,body{margin:0;height:100%;background:#141416;color:#c8cad2;
    font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden}
  .fill{position:absolute;inset:0;width:100%;height:100%;border:0}
  .stack{display:flex;flex-direction:column;height:100%}
  .stage{position:relative;flex:1;min-height:0}
  .card{display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100%;gap:10px;text-align:center;padding:24px;box-sizing:border-box}
  .card h1{font-size:15px;font-weight:600;margin:0;color:#e8e9ee}
  .card p{font-size:12px;margin:0;max-width:44ch;line-height:1.6}
  .card .url{font-family:Consolas,monospace;font-size:11px;color:#8f97f8;
    word-break:break-all;max-width:60ch}
  .card button{background:#8f97f8;color:#141416;border:0;border-radius:5px;
    padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;margin-top:6px}
  .notice{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:8px 12px;font-size:11px;line-height:1.5;color:#c8cad2;
    background:#1d1e23;border-bottom:1px solid #33343c}
  .notice span{flex:1;min-width:200px}
  .notice button{background:#2b2d34;color:#e8e9ee;border:1px solid #454654;
    border-radius:5px;padding:4px 12px;font-size:11px;cursor:pointer;white-space:nowrap}
  .notice button:hover{border-color:#8f97f8}
  .notice code{font-family:Consolas,monospace;background:#2b2d34;padding:1px 5px;border-radius:3px}
  .rel{position:absolute;inset:0;background:rgba(16,16,20,.96);display:flex;
    flex-direction:column;padding:14px;box-sizing:border-box;overflow-y:auto}
  .rel h2{font-size:12px;font-weight:600;color:#e8e9ee;margin:0 0 10px;padding-right:24px}
  .rel-close{position:absolute;top:8px;right:10px;background:none;border:0;
    color:#c8cad2;font-size:16px;cursor:pointer;line-height:1}
  .rel-close:hover{color:#fff}
  .rel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
  .rel-tile{cursor:pointer;background:#1d1e23;border:1px solid #33343c;border-radius:6px;
    overflow:hidden;text-align:left;padding:0;font-family:inherit}
  .rel-tile:hover{border-color:#8f97f8}
  .rel-tile img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#000}
  .rel-tile .tt{font-size:11px;color:#e8e9ee;padding:6px 8px 0;line-height:1.35;
    overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .rel-tile .ar{font-size:10px;color:#8b8e99;padding:2px 8px 8px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .q-open{position:absolute;top:8px;right:10px;z-index:2;background:rgba(29,30,35,.92);
    color:#e8e9ee;border:1px solid #454654;border-radius:5px;padding:4px 10px;
    font-size:11px;font-family:inherit;cursor:pointer}
  .q-open:hover{border-color:#8f97f8}
  /* Spotify Connect surface */
  .sp{display:flex;flex-direction:column;height:100%;overflow:hidden}
  .sp-head{display:flex;gap:10px;padding:12px 14px;align-items:center;
    border-bottom:1px solid #33343c}
  .sp-head img{width:52px;height:52px;border-radius:4px;object-fit:cover;
    background:#26272d;flex:none}
  .sp-head .h{flex:1;min-width:0}
  .sp-head h1{font-size:14px;font-weight:600;margin:0 0 2px;color:#e8e9ee;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-head .sub{font-size:11px;color:#8b8e99;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .sp-list{flex:1;overflow-y:auto;padding:4px 0}
  .sp-empty{padding:20px 14px;font-size:12px;color:#8b8e99;line-height:1.6}
  .sp-row{display:flex;align-items:center;gap:10px;width:100%;padding:6px 14px;
    background:none;border:0;color:inherit;font-family:inherit;font-size:12px;
    text-align:left;cursor:pointer;box-sizing:border-box}
  .sp-row:hover{background:#1d1e23}
  .sp-row.on{background:#22232a}
  .sp-row.on .t{color:#8f97f8}
  .sp-row .n{width:20px;flex:none;color:#8b8e99;font-size:11px;text-align:right;
    font-variant-numeric:tabular-nums}
  .sp-row img{width:32px;height:32px;border-radius:3px;object-fit:cover;
    background:#26272d;flex:none}
  .sp-row .m{flex:1;min-width:0}
  .sp-row .t{color:#e8e9ee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-row .a{color:#8b8e99;font-size:11px;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .sp-row .d{color:#8b8e99;font-size:11px;flex:none;font-variant-numeric:tabular-nums}
  .sp-bar{border-top:1px solid #33343c;background:#1d1e23;padding:8px 12px;
    display:flex;flex-direction:column;gap:6px}
  .sp-now{display:flex;align-items:center;gap:10px;font-size:12px}
  .sp-now img{width:34px;height:34px;border-radius:3px;object-fit:cover;
    background:#26272d;flex:none}
  .sp-now .m{flex:1;min-width:0}
  .sp-now .t{color:#e8e9ee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-now .a{color:#8b8e99;font-size:11px;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .sp-btns{display:flex;align-items:center;gap:4px;flex:none}
  .sp-btn{background:#2b2d34;border:1px solid #454654;color:#e8e9ee;border-radius:5px;
    min-width:28px;height:26px;cursor:pointer;font-size:11px;font-family:inherit;
    line-height:1;display:flex;align-items:center;justify-content:center;padding:0 6px}
  .sp-btn:hover{border-color:#8f97f8}
  .sp-btn:disabled{opacity:.45;cursor:default}
  .sp-btn.on{color:#8f97f8;border-color:#8f97f8}
  .sp-btn .lbl{margin-left:5px}
  .sp-seek{display:flex;align-items:center;gap:8px;font-size:10px;color:#8b8e99}
  .sp-seek input{flex:1;min-width:40px}
  .sp-foot{display:flex;align-items:center;gap:8px;font-size:11px;color:#8b8e99}
  .sp-foot select{background:#2b2d34;color:#e8e9ee;border:1px solid #454654;
    border-radius:4px;font-size:11px;padding:3px 6px;max-width:160px;font-family:inherit}
  .sp-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sp-msg.err{color:#f8a08f}
`;

export const renderViewPage = (
  target: string,
  resolution: EmbedResolution
): string => {
  // Report the real URL first, on every view page: a frame can arrive here by
  // NAVIGATION (link click on a proxied page → /proxy re-classifies to a view
  // page), and the shell keeps the tab's address in sync from this message.
  const nav = `parent.postMessage({nm:"nav",url:${JSON.stringify(target)}},"*");`;

  if (resolution.kind === "embed" && resolution.provider === "youtube") {
    // Controlled via the YouTube IFrame API so the panel's transport +
    // scrub-sync can drive playback and read currentTime.
    return page(
      `<iframe id="yt" class="fill" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`,
      `
      ${nav}
      parent.postMessage({nm:"meta",provider:"youtube",controllable:true,videoId:${JSON.stringify(
        resolution.videoId
      )}},"*");
      var EMBED=${JSON.stringify(resolution.embedUrl)};
      var f=document.getElementById("yt");
      f.src=EMBED+"&origin="+encodeURIComponent(location.origin);
      var player=null;
      var ready=false;
      var autoMuted=false;
      var wantAutoMute=false;
      var userOverride=false;
      var pendingVol=-1;
      var tag=document.createElement("script");
      tag.src="https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
      window.onYouTubeIframeAPIReady=function(){
        player=new YT.Player("yt",{events:{onReady:function(){
          ready=true;applyAutoMute();applyVol();report();
        }}});
      };
      function tell(m){try{parent.postMessage({nm:"duckState",mode:m},"*");}catch(e){}}
      function applyAutoMute(){
        try{
          if(wantAutoMute){
            if(!userOverride&&!player.isMuted()){player.mute();autoMuted=true;tell("muted");}
          } else if(autoMuted){player.unMute();autoMuted=false;tell(null);}
        }catch(err){}
      }
      function applyVol(){if(pendingVol<0)return;try{player.setVolume(Math.round(pendingVol*100));}catch(e){}}
      window.addEventListener("message",function(e){
        var d=e.data; if(!d||d.nm!=="cmd")return;
        if(d.action==="duck"||d.action==="mute"||d.action==="resume"||d.action==="unmute"){
          var on=(d.action==="duck"||d.action==="mute");
          wantAutoMute=on;
          if(!on)userOverride=false;
          if(ready)applyAutoMute();
          else if(!on)tell(null);
          return;
        }
        if(d.action==="volume"){
          pendingVol=Math.max(0,Math.min(1,+d.value||0));
          if(ready)applyVol();
          return;
        }
        if(!player)return;
        try{
          if(d.action==="play")player.playVideo();
          else if(d.action==="pause")player.pauseVideo();
          else if(d.action==="seek")player.seekTo(d.value,true);
          else if(d.action==="rate")player.setPlaybackRate(d.value);
        }catch(err){}
      });
      // end-screen "more videos" tiles play in-place — follow the video id so
      // the tab's link jumps with them
      var curId=${JSON.stringify(resolution.videoId)};
      var lastSnd=null,lastPlaying=false;
      // Audibility up to the shell — it gates the whole AE duck watchdog, so a
      // paused tab costs AE nothing. While WE duck (wantAutoMute) it must stay
      // "audible" or the watchdog would stop before it can send the resume.
      function snd(on){
        if(on===lastSnd)return;
        lastSnd=on;
        try{parent.postMessage({nm:"sound",on:on},"*");}catch(e){}
      }
      function report(){
        if(player&&player.getCurrentTime){
          try{
            // user unmuted via the YT chrome mid-duck: respect it — clear our
            // claim and stop re-ducks fighting them until the next resume
            if(autoMuted&&!player.isMuted()){autoMuted=false;userOverride=true;tell(null);}
            var vd=player.getVideoData&&player.getVideoData();
            if(vd&&vd.video_id&&vd.video_id!==curId){
              curId=vd.video_id;
              parent.postMessage({nm:"nav",url:"https://www.youtube.com/watch?v="+curId},"*");
              parent.postMessage({nm:"meta",provider:"youtube",controllable:true,videoId:curId},"*");
            }
            lastPlaying=!!(player.getPlayerState&&player.getPlayerState()===1);
            snd(wantAutoMute?true:(lastPlaying&&!player.isMuted()));
            parent.postMessage({nm:"time",current:player.getCurrentTime(),
              duration:player.getDuration(),
              playing:lastPlaying},"*");
          }catch(e){}
        }
      }
      // 250ms keeps the scrubber live while playing; a paused tab only needs
      // an occasional check, so it drops to 1s and stops waking the renderer.
      (function tick(){report();setTimeout(tick,lastPlaying?250:1000);})();
    `
    );
  }

  // Spotify with Connect authorized: our own remote, not a framed player.
  if (
    resolution.kind === "embed" &&
    resolution.provider === "spotify" &&
    resolution.connect
  )
    return spotifyPage(target, resolution);

  if (resolution.kind === "embed") {
    // Vimeo / Dailymotion / SoundCloud / Spotify: play with their own
    // controls, but wire duck/resume/volume through each provider's
    // postMessage API. Music (SoundCloud, Spotify) → duck PAUSES, keeping
    // your place; video sites mute instead.

    // Spotify without Connect is preview-only, and nothing in-panel can change
    // that — so say it plainly rather than letting the 30s cutoff look like a
    // bug, and point at the one thing that does fix it.
    const notice =
      resolution.provider === "spotify"
        ? `<div class="notice"><span><strong>Preview only.</strong> Spotify's embed
           plays 30 seconds unless the page can run Widevine DRM, which After
           Effects panels can't. Connect Spotify in Settings to play full tracks
           through your own Spotify app.</span>
           <button id="setBtn">Open Settings</button></div>`
        : "";
    const queueBtn =
      resolution.provider === "soundcloud"
        ? `<button id="qbtn" class="q-open" style="display:none">Queue</button>`
        : "";

    return page(
      `<div class="stack">${notice}<div class="stage">
        <iframe id="p" class="fill" src="${esc(resolution.embedUrl)}"
          allow="autoplay; encrypted-media; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
          allowfullscreen></iframe>
        ${queueBtn}
        <div id="rel" class="rel" style="display:none"></div>
        <div id="q" class="rel" style="display:none"></div>
      </div></div>`,
      `
      ${nav}
      parent.postMessage({nm:"meta",provider:${JSON.stringify(
        resolution.provider
      )},controllable:false,videoId:${JSON.stringify(resolution.videoId)}},"*");
      var P=${JSON.stringify(resolution.provider)};
      var f=document.getElementById("p");
      var ducked=false;
      var playing=true; // embeds autoplay; refined by widget events where available
      function toPlayer(msg){try{f.contentWindow.postMessage(msg,"*");}catch(e){}}
      function tell(m){try{parent.postMessage({nm:"duckState",mode:m},"*");}catch(e){}}
      // Audibility up to the shell (gates the AE duck watchdog). Providers with
      // no play/pause events (Vimeo, Dailymotion) just stay "audible" — the
      // watchdog then behaves exactly as before, never worse. Ducked counts as
      // audible so the watchdog stays alive to send the resume.
      var lastSnd=null;
      function snd(){
        var on=ducked||playing;
        if(on===lastSnd)return;
        lastSnd=on;
        try{parent.postMessage({nm:"sound",on:on},"*");}catch(e){}
      }
      snd();
      var setBtn=document.getElementById("setBtn");
      if(setBtn)setBtn.onclick=function(){
        parent.postMessage({nm:"route",to:"settings"},"*");
      };
      if(P==="soundcloud"){
        window.addEventListener("message",function(e){
          if(e.source!==f.contentWindow)return;
          var d=e.data;
          if(typeof d==="string"){try{d=JSON.parse(d);}catch(err){return;}}
          if(!d||!d.method)return;
          // reply to our getCurrentSoundIndex poll — drives the queue highlight
          if(d.method==="getCurrentSoundIndex"&&typeof d.value==="number"){
            markQueue(d.value);return;
          }
          if(d.method==="play"||d.method==="playProgress")playing=true;
          else if(d.method==="pause")playing=false;
          else if(d.method==="finish"){playing=false;showRelated();}
          snd();
        });
        f.addEventListener("load",function(){
          setTimeout(function(){
            toPlayer(JSON.stringify({method:"addEventListener",value:"play"}));
            toPlayer(JSON.stringify({method:"addEventListener",value:"pause"}));
            toPlayer(JSON.stringify({method:"addEventListener",value:"finish"}));
          },1200);
        });
      }
      if(P==="spotify"){
        // The embed talks the same postMessage protocol Spotify's own
        // iframe-api script drives — speaking it directly means no external
        // script to fetch, so the player still works with blocking on or the
        // API host unreachable. Volume is not part of it: duck can only pause.
        window.addEventListener("message",function(e){
          if(e.source!==f.contentWindow)return;
          var d=e.data;
          if(typeof d==="string"){try{d=JSON.parse(d);}catch(err){return;}}
          if(!d||d.type!=="playback_update"||!d.payload)return;
          playing=!d.payload.isPaused;
          snd();
        });
        // Every other tier autoplays; the embed waits to be told to.
        f.addEventListener("load",function(){
          setTimeout(function(){toPlayer({command:"play"});},900);
        });
      }
      function duck(on){
        if(on===ducked)return;
        if(P==="soundcloud"||P==="spotify"){
          var pause=P==="spotify"?{command:"pause"}:JSON.stringify({method:"pause"});
          var play=P==="spotify"?{command:"play"}:JSON.stringify({method:"play"});
          if(on){ if(playing){toPlayer(pause);ducked=true;tell("paused");} }
          else { ducked=false;toPlayer(play);tell(null); }
        } else if(P==="vimeo"){
          ducked=on;
          toPlayer(JSON.stringify({method:"setMuted",value:on}));
          tell(on?"muted":null);
        } else {
          ducked=on;
          toPlayer({command:on?"mute":"unmute",parameters:[]});
          tell(on?"muted":null);
        }
        snd();
      }
      window.addEventListener("message",function(e){
        var d=e.data; if(!d||d.nm!=="cmd")return;
        if(d.action==="duck")duck(true);
        else if(d.action==="resume")duck(false);
        else if(d.action==="volume"){
          var v=Math.max(0,Math.min(1,+d.value||0));
          if(P==="spotify")return; // no volume in the embed's protocol
          if(P==="soundcloud")toPlayer(JSON.stringify({method:"setVolume",value:Math.round(v*100)}));
          else if(P==="vimeo")toPlayer(JSON.stringify({method:"setVolume",value:v}));
          else toPlayer({command:"volume",parameters:[v]});
        }
      });
      // Our own end screen when a SoundCloud track finishes. The widget's
      // "Play more tracks like…" tiles are target=_blank links (its HTML has
      // <base target=_blank>) — popups never open inside CEP, so they're dead,
      // and the widget API exposes no click event. This overlay covers them
      // with tiles that navigate THIS frame; the next view page reports its
      // URL up, so the tab follows.
      var TARGET=${JSON.stringify(target)};
      var TOK=new URLSearchParams(location.search).get("t")||"";
      var relBox=document.getElementById("rel");
      var relLoaded=false;
      function showRelated(){
        if(P!=="soundcloud")return;
        if(relLoaded){relBox.style.display="flex";return;}
        relLoaded=true;
        fetch("/sc/related?url="+encodeURIComponent(TARGET)+"&t="+encodeURIComponent(TOK))
          .then(function(r){return r.json();})
          .then(function(r){
            if(!r||!r.ok||!r.tracks||!r.tracks.length)return;
            var close=document.createElement("button");
            close.className="rel-close";close.textContent="\\u00d7";
            close.onclick=function(){relBox.style.display="none";};
            var head=document.createElement("h2");
            head.textContent="Play more tracks";
            var grid=document.createElement("div");
            grid.className="rel-grid";
            r.tracks.forEach(function(t){
              var b=document.createElement("button");
              b.className="rel-tile";
              b.onclick=function(){
                location.href="/view?target="+encodeURIComponent(t.url)+"&t="+encodeURIComponent(TOK);
              };
              var img=document.createElement("img");
              img.src=t.artwork||"";img.alt="";
              var tt=document.createElement("div");
              tt.className="tt";tt.textContent=t.title;
              var ar=document.createElement("div");
              ar.className="ar";ar.textContent=t.artist;
              b.appendChild(img);b.appendChild(tt);b.appendChild(ar);
              grid.appendChild(b);
            });
            relBox.appendChild(close);relBox.appendChild(head);relBox.appendChild(grid);
            relBox.style.display="flex";
          })
          .catch(function(){});
      }

      // SoundCloud sets: the widget DOES queue a playlist and auto-advance,
      // but in the visual layout its own tracklist is a cramped afterthought
      // and, like the end-screen tiles, it can't tell us what was clicked. So
      // mirror the set here — click any track and skip(i) jumps the widget
      // straight to it.
      var qBox=document.getElementById("q");
      var qBtn=document.getElementById("qbtn");
      var qRows=[];
      function fmt(msv){
        var s=Math.max(0,Math.round((msv||0)/1000));
        var m=Math.floor(s/60);
        var r=s%60;
        return m+":"+(r<10?"0":"")+r;
      }
      function markQueue(i){
        for(var n=0;n<qRows.length;n++)
          qRows[n].className="sp-row"+(n===i?" on":"");
      }
      function buildQueue(title,tracks){
        var close=document.createElement("button");
        close.className="rel-close";close.textContent="\\u00d7";
        close.onclick=function(){qBox.style.display="none";};
        var head=document.createElement("h2");
        head.textContent=title||"Queue";
        qBox.appendChild(close);qBox.appendChild(head);
        tracks.forEach(function(t,i){
          var b=document.createElement("button");
          b.className="sp-row";
          b.onclick=function(){
            toPlayer(JSON.stringify({method:"skip",value:i}));
            markQueue(i);
            qBox.style.display="none";
          };
          var n=document.createElement("span");
          n.className="n";n.textContent=String(i+1);
          var img=document.createElement("img");
          img.src=t.artwork||"";img.alt="";
          var m=document.createElement("span");
          m.className="m";
          var tt=document.createElement("div");
          tt.className="t";tt.textContent=t.title;
          var ar=document.createElement("div");
          ar.className="a";ar.textContent=t.artist;
          m.appendChild(tt);m.appendChild(ar);
          var d=document.createElement("span");
          d.className="d";d.textContent=fmt(t.durationMs);
          b.appendChild(n);b.appendChild(img);b.appendChild(m);b.appendChild(d);
          qBox.appendChild(b);
          qRows.push(b);
        });
      }
      if(P==="soundcloud"){
        fetch("/sc/playlist?url="+encodeURIComponent(TARGET)+"&t="+encodeURIComponent(TOK))
          .then(function(r){return r.json();})
          .then(function(r){
            if(!r||!r.ok||r.kind!=="playlist"||!r.tracks||!r.tracks.length)return;
            buildQueue(r.title,r.tracks);
            qBtn.style.display="block";
            qBtn.onclick=function(){
              qBox.style.display=qBox.style.display==="flex"?"none":"flex";
            };
            // The widget answers this with the index it is on; if a widget
            // release ever stops replying, the list just never highlights —
            // click-to-skip keeps working.
            setInterval(function(){
              toPlayer(JSON.stringify({method:"getCurrentSoundIndex"}));
            },1500);
          })
          .catch(function(){});
      }`
    );
  }

  if (resolution.kind === "media") {
    const isVideo = /\.(mp4|webm|m4v|mov|ogv)(\?.*)?$/i.test(resolution.url);
    const isAudio = /\.(mp3|wav|ogg|aac|flac)(\?.*)?$/i.test(resolution.url);
    if (!isVideo && !isAudio) {
      return page(
        `<div class="card"><img src="${esc(
          resolution.url
        )}" style="max-width:100%;max-height:100%;object-fit:contain"/></div>`,
        `${nav}parent.postMessage({nm:"meta",provider:"image",controllable:false,mediaUrl:${JSON.stringify(
          resolution.url
        )}},"*");parent.postMessage({nm:"sound",on:false},"*");`
      );
    }
    const tag = isVideo
      ? `<video id="v" class="fill" src="${esc(
          resolution.url
        )}" autoplay style="object-fit:contain;background:#000"></video>`
      : `<div class="card"><audio id="v" src="${esc(
          resolution.url
        )}" autoplay style="width:80%"></audio></div>`;
    return page(
      tag,
      `
      ${nav}
      parent.postMessage({nm:"meta",provider:"media",controllable:true,mediaUrl:${JSON.stringify(
        resolution.url
      )}},"*");
      var v=document.getElementById("v");
      var MUSIC=${isAudio ? "true" : "false"}; // audio file = music → duck pauses
      var ducked=false;
      function tell(m){try{parent.postMessage({nm:"duckState",mode:m},"*");}catch(e){}}
      // Audibility up to the shell (gates the AE duck watchdog); ducked counts
      // as audible so the watchdog stays alive to send the resume.
      var lastSnd=null;
      function snd(){
        var on=ducked||(!v.paused&&!v.muted&&v.volume>0);
        if(on===lastSnd)return;
        lastSnd=on;
        try{parent.postMessage({nm:"sound",on:on},"*");}catch(e){}
      }
      window.addEventListener("message",function(e){
        var d=e.data; if(!d||d.nm!=="cmd")return;
        if(d.action==="duck"||d.action==="mute"){
          if(!ducked){
            if(MUSIC){ if(!v.paused){v.pause();ducked=true;} }
            else if(!v.muted){v.muted=true;ducked=true;}
            if(ducked)tell(MUSIC?"paused":"muted");
          }
        }
        else if(d.action==="resume"||d.action==="unmute"){
          if(ducked){
            ducked=false;
            try{ if(MUSIC)v.play(); else v.muted=false; }catch(e2){}
            tell(null);
          }
        }
        else if(d.action==="volume"){try{v.volume=Math.max(0,Math.min(1,+d.value||0));}catch(e2){}}
        else if(d.action==="play")v.play();
        else if(d.action==="pause")v.pause();
        else if(d.action==="seek")v.currentTime=d.value;
        else if(d.action==="rate")v.playbackRate=d.value;
      });
      function rep(){snd();parent.postMessage({nm:"time",current:v.currentTime||0,
        duration:v.duration||0,playing:!v.paused},"*");}
      v.addEventListener("timeupdate",rep);
      v.addEventListener("loadedmetadata",rep);
      v.addEventListener("play",rep); v.addEventListener("pause",rep);
      v.addEventListener("volumechange",snd); v.addEventListener("ended",snd);
      snd();
    `
    );
  }

  // Web tier is 302-redirected to /proxy in server.ts before reaching here;
  // this is only a safety net.
  return page(
    `<div class="card"><h1>Opening…</h1><div class="url">${esc(target)}</div></div>`,
    `${nav}parent.postMessage({nm:"sound",on:false},"*");`
  );
};

/**
 * Spotify Connect surface.
 *
 * Everything here is a REMOTE. The audio comes out of the user's real Spotify
 * client, so this page renders state and sends commands and never pretends to
 * be a player — which is also why it needs no iframe, no DRM, and no cookies.
 * It keeps the same postMessage contract as every other view page, so the
 * panel's auto-duck works unchanged: for music, duck means pause, and pause is
 * exactly what the Web API gives us.
 */
const spotifyPage = (target: string, resolution: EmbedTier): string => {
  const kind = resolution.spKind || "track";
  const isLibrary = kind === "library";
  return page(
    `<div class="sp">
      <div class="sp-head">
        <img id="ctxArt" alt=""/>
        <div class="h">
          <h1 id="ctxName">Loading…</h1>
          <div class="sub" id="ctxSub"></div>
        </div>
        <button class="sp-btn" id="shufPlayBtn" title="Play this shuffled"
          style="display:none">${ICON_SHUFFLE}<span class="lbl">Shuffle</span></button>
        ${isLibrary ? "" : `<button class="sp-btn" id="libBtn">Playlists</button>`}
        <button class="sp-btn" id="extBtn">Open in Spotify</button>
      </div>
      <div class="sp-list" id="list"></div>
      <div class="sp-bar">
        <div class="sp-now">
          <img id="nowArt" alt=""/>
          <div class="m">
            <div class="t" id="nowTitle">Nothing playing</div>
            <div class="a" id="nowArtist"></div>
          </div>
          <div class="sp-btns">
            <button class="sp-btn" id="shufBtn" title="Shuffle">${ICON_SHUFFLE}</button>
            <button class="sp-btn" id="prevBtn" title="Previous">${ICON_PREV}</button>
            <button class="sp-btn" id="ppBtn" title="Play / pause">${ICON_PLAY}</button>
            <button class="sp-btn" id="nextBtn" title="Next">${ICON_NEXT}</button>
          </div>
        </div>
        <div class="sp-seek">
          <span id="tCur">0:00</span>
          <input id="seek" type="range" min="0" max="1000" value="0"/>
          <span id="tDur">0:00</span>
        </div>
        <div class="sp-foot">
          <select id="dev" title="Which Spotify device plays"></select>
          <span class="sp-msg" id="msg"></span>
        </div>
      </div>
    </div>`,
    `
    parent.postMessage({nm:"nav",url:${JSON.stringify(target)}},"*");
    parent.postMessage({nm:"meta",provider:"spotify",controllable:false,
      videoId:${JSON.stringify(resolution.videoId)}},"*");

    var TARGET=${JSON.stringify(target)};
    var KIND=${JSON.stringify(kind)};
    var ID=${JSON.stringify(resolution.videoId)};
    var TOK=new URLSearchParams(location.search).get("t")||"";
    var ICON_PLAY=${JSON.stringify(ICON_PLAY)};
    var ICON_PAUSE=${JSON.stringify(ICON_PAUSE)};

    var ctx=null;         // the playlist/album/track this tab is showing
    var st=null;          // last playback snapshot
    var ducked=false;     // WE paused it for an AE preview
    var seeking=false;    // user has the scrubber grabbed
    var baseProg=0, baseAt=0;
    var pollTimer=null, volTimer=null, lastVol=-1;
    var autoplayed=false;

    var $=function(id){return document.getElementById(id);};
    function tell(m){try{parent.postMessage({nm:"duckState",mode:m},"*");}catch(e){}}
    // Audibility up to the shell (gates the AE duck watchdog); ducked counts
    // as audible so the watchdog stays alive to send the resume.
    var lastSnd=null;
    function snd(){
      var on=ducked||!!(st&&st.playing);
      if(on===lastSnd)return;
      lastSnd=on;
      try{parent.postMessage({nm:"sound",on:on},"*");}catch(e){}
    }
    function fmt(msv){
      var s=Math.max(0,Math.round((msv||0)/1000));
      var m=Math.floor(s/60);
      var r=s%60;
      return m+":"+(r<10?"0":"")+r;
    }
    function api(path,opts){
      return fetch(path+(path.indexOf("?")>=0?"&":"?")+"t="+encodeURIComponent(TOK),opts)
        .then(function(r){return r.json();});
    }
    function say(text,isErr){
      var el=$("msg");
      el.textContent=text||"";
      el.className="sp-msg"+(isErr?" err":"");
    }
    function cmd(c){
      return api("/spotify/cmd",{method:"POST",body:JSON.stringify(c)})
        .then(function(r){
          if(r&&r.ok===false)say(r.error,true);
          else{say("");poll(true);}
          return r;
        })
        .catch(function(e){say(String(e),true);});
    }
    function go(url){
      location.href="/view?target="+encodeURIComponent(url)+"&t="+encodeURIComponent(TOK);
    }

    $("extBtn").onclick=function(){
      parent.postMessage({nm:"openExternal",url:TARGET},"*");
    };
    var libBtn=$("libBtn");
    if(libBtn)libBtn.onclick=function(){go("https://open.spotify.com/");};

    $("ppBtn").onclick=function(){
      if(st&&st.playing)cmd({action:"pause"});
      else cmd({action:"play"});
    };
    $("prevBtn").onclick=function(){cmd({action:"previous"});};
    $("nextBtn").onclick=function(){cmd({action:"next"});};
    $("shufBtn").onclick=function(){cmd({action:"shuffle",on:!(st&&st.shuffle)});};
    $("shufPlayBtn").onclick=function(){
      if(!ctx||!ctx.uri)return;
      autoplayed=true; // this IS the play — don't let autoplay fire an unshuffled one
      cmd({action:"shuffle",on:true}).then(function(r){
        var pre=r&&r.ok!==false;
        cmd({action:"play",contextUri:ctx.uri}).then(function(p){
          // Spotify may refuse shuffle while idle — set it again now that
          // playback exists, so the button always means what it says.
          if(!pre&&p&&p.ok!==false)cmd({action:"shuffle",on:true});
        });
      });
    };

    var seek=$("seek");
    seek.addEventListener("mousedown",function(){seeking=true;});
    seek.addEventListener("change",function(){
      seeking=false;
      var dur=(st&&st.durationMs)||0;
      if(dur>0)cmd({action:"seek",positionMs:Math.round(dur*(+seek.value/1000))});
    });
    $("dev").addEventListener("change",function(){
      var id=$("dev").value;
      if(id)cmd({action:"transfer",deviceId:id});
    });

    // ── the context (what this tab is showing) ────────────────────────
    function row(item,index,onClick){
      var b=document.createElement("button");
      b.className="sp-row";
      b.onclick=onClick;
      if(index>=0){
        var n=document.createElement("span");
        n.className="n";n.textContent=String(index+1);
        b.appendChild(n);
      }
      var img=document.createElement("img");
      img.src=item.image||"";img.alt="";
      var m=document.createElement("span");
      m.className="m";
      var tt=document.createElement("div");
      tt.className="t";tt.textContent=item.name;
      var ar=document.createElement("div");
      ar.className="a";ar.textContent=item.subtitle;
      m.appendChild(tt);m.appendChild(ar);
      b.appendChild(img);b.appendChild(m);
      if(item.durationMs){
        var d=document.createElement("span");
        d.className="d";d.textContent=fmt(item.durationMs);
        b.appendChild(d);
      }
      b.setAttribute("data-uri",item.uri||"");
      return b;
    }

    function renderContext(c){
      ctx=c;
      $("ctxName").textContent=c.ok?c.name:"Couldn't open this";
      $("ctxSub").textContent=c.ok?c.subtitle:(c.error||"");
      var art=$("ctxArt");
      if(c.image)art.src=c.image; else art.style.visibility="hidden";
      $("shufPlayBtn").style.display=(c.ok&&c.playableContext&&c.uri)?"":"none";
      var list=$("list");
      list.innerHTML="";
      if(!c.ok||!c.items.length){
        var p=document.createElement("div");
        p.className="sp-empty";
        // A partial failure (some pages fetched, some refused) arrives as
        // ok:true with an error — say why instead of a blank shrug.
        p.textContent=c.error||(c.ok?"Nothing to show here.":"");
        list.appendChild(p);
        return;
      }
      c.items.forEach(function(it,i){
        // Playlists in the library are places to go; tracks are things to play.
        if(it.kind==="playlist"||it.kind==="album"){
          list.appendChild(row(it,-1,function(){go(it.href);}));
        } else {
          list.appendChild(row(it,i,function(){
            cmd(c.playableContext
              ? {action:"play",contextUri:c.uri,uri:it.uri}
              : {action:"play",uri:it.uri});
          }));
        }
      });
      paint();
      maybeAutoplay(); // don't make the user wait for the next poll tick
    }

    // ── playback state ────────────────────────────────────────────────
    function paint(){
      if(!st)return;
      snd();
      var it=st.item;
      $("nowTitle").textContent=it?it.name:(st.active?"…":"Nothing playing");
      $("nowArtist").textContent=it?it.artist:"";
      var na=$("nowArt");
      na.src=(it&&it.image)||"";
      na.style.visibility=it&&it.image?"visible":"hidden";
      $("ppBtn").innerHTML=st.playing?ICON_PAUSE:ICON_PLAY;
      $("shufBtn").className="sp-btn"+(st.shuffle?" on":"");

      var prog=baseProg+(st.playing?Date.now()-baseAt:0);
      var dur=st.durationMs||0;
      if(dur>0&&prog>dur)prog=dur;
      $("tCur").textContent=fmt(prog);
      $("tDur").textContent=fmt(dur);
      if(!seeking)seek.value=dur>0?String(Math.round((prog/dur)*1000)):"0";
      seek.disabled=!(dur>0);

      // highlight whatever row is currently sounding
      var uri=it?it.uri:"";
      var rows=$("list").children;
      for(var i=0;i<rows.length;i++){
        if(rows[i].hasAttribute&&rows[i].hasAttribute("data-uri"))
          rows[i].className="sp-row"+
            (uri&&rows[i].getAttribute("data-uri")===uri?" on":"");
      }

      var sel=$("dev");
      var want=st.devices.map(function(d){return d.id+"|"+d.name;}).join(",");
      if(sel.getAttribute("data-sig")!==want){
        sel.setAttribute("data-sig",want);
        sel.innerHTML="";
        if(!st.devices.length){
          var o=document.createElement("option");
          o.textContent="No Spotify device";o.value="";
          sel.appendChild(o);
        }
        st.devices.forEach(function(d){
          var o=document.createElement("option");
          o.value=d.id;o.textContent=d.name+" ("+d.type+")";
          if(d.active)o.selected=true;
          sel.appendChild(o);
        });
      }

      if(st.error)say(st.error,true);
      else if(!st.premium)say("Browsing works, but Spotify Premium is required to control playback.",true);
      else if(!st.devices.length)say("Open Spotify on your computer or phone to give Nekomitai something to play on.");
      else if(ducked)say("Paused for the After Effects preview.");
    }

    function poll(force){
      return api("/spotify/state"+(force?"?force=1":""))
        .then(function(s){
          if(!s)return;
          st=s;
          baseProg=s.progressMs||0;
          baseAt=Date.now();
          paint();
          maybeAutoplay();
        })
        .catch(function(){});
    }

    // Every other tier autoplays what you opened, so this does too — but only
    // once, and never if that context is already the thing playing (a tab
    // restored from the last session must not restart your music).
    function maybeAutoplay(){
      if(autoplayed||!ctx||!ctx.ok||KIND==="library")return;
      autoplayed=true;
      if(st&&st.playing&&ctx.uri&&(st.contextUri===ctx.uri||
        (st.item&&st.item.uri===ctx.uri)))return;
      if(ctx.playableContext&&ctx.uri)cmd({action:"play",contextUri:ctx.uri});
      else if(ctx.items.length)cmd({action:"play",uri:ctx.items[0].uri});
    }

    function loop(){
      clearTimeout(pollTimer);
      // Poll fast enough for the scrubber to feel live while something is
      // playing, slow enough to stay well inside Spotify's rate limit when
      // nothing is. The gateway also coalesces, so extra tabs are free.
      pollTimer=setTimeout(function(){
        poll(false).then(loop);
      },st&&st.playing?1500:4000);
    }

    api("/spotify/context?kind="+encodeURIComponent(KIND)+"&id="+encodeURIComponent(ID))
      .then(renderContext)
      .catch(function(e){
        renderContext({ok:false,items:[],error:String(e)});
      });
    poll(true).then(loop);
    setInterval(function(){if(st&&st.playing&&!seeking)paint();},250);

    // ── the panel's transport messages ────────────────────────────────
    window.addEventListener("message",function(e){
      var d=e.data; if(!d||d.nm!=="cmd")return;
      if(d.action==="duck"){
        // Music ducks by pausing — and only if it is actually playing, so
        // releasing the duck never starts music the user had stopped.
        if(!ducked&&st&&st.playing){
          ducked=true;
          cmd({action:"pause"});
          tell("paused");
        }
      } else if(d.action==="resume"){
        if(ducked){
          ducked=false;
          cmd({action:"play"});
          tell(null);
        }
      } else if(d.action==="pause"){
        cmd({action:"pause"});
      } else if(d.action==="play"){
        cmd({action:"play"});
      } else if(d.action==="seek"){
        cmd({action:"seek",positionMs:Math.round((+d.value||0)*1000)});
      } else if(d.action==="volume"){
        // The panel's slider is the reference-volume control, so it moves the
        // volume of the Spotify device. Debounced: dragging a slider would
        // otherwise fire a request per pixel.
        var pct=Math.round(Math.max(0,Math.min(1,+d.value||0))*100);
        if(pct===lastVol)return;
        lastVol=pct;
        clearTimeout(volTimer);
        volTimer=setTimeout(function(){
          api("/spotify/cmd",{method:"POST",
            body:JSON.stringify({action:"volume",volumePercent:pct})}).catch(function(){});
        },300);
      }
    });
  `
  );
};

const page = (body: string, script = "") => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${SHELL_CSS}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
