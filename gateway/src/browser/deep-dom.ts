/**
 * In-page helpers that see the whole rendered tree, not just the top
 * document: open shadow roots and same-origin iframes (any depth). Everything
 * the agent does by "what is on the page" — snapshot, get_html, select,
 * typing verification, wait_for text, console/network — runs on these so a
 * login form inside an iframe or a button inside a web component is as
 * reachable as one in the main document.
 *
 * `DEEP_DOM_SOURCE` is a JavaScript expression (an IIFE) evaluating to the
 * helper object; embed it as `const D=${DEEP_DOM_SOURCE};` at the top of a
 * page expression. It is plain ES2018 so it runs unchanged in WebView2 and
 * WKWebView. The panel (src/panel) and the gateway tool both import it.
 *
 * Coordinates: every helper works in top-viewport coordinates (what CDP
 * Input events use). Frame documents have their own origin, so each root is
 * carried with its offset (`ox`,`oy`) and the clip rectangle of the frames
 * it sits in.
 *
 * Cross-origin frames cannot be read from script; they are reported as
 * opaque boxes so the agent can still click/scroll inside them by position.
 */
export const DEEP_DOM_SOURCE = `(()=>{
  const FRAME=e=>e.tagName==='IFRAME'||e.tagName==='FRAME';
  const sameOriginDoc=f=>{try{const d=f.contentDocument;return d&&d.documentElement?d:null;}catch(e){return null;}};
  const frameLabel=f=>(f.title||f.name||f.id||(f.src||'').replace(/^https?:\\/\\//,'').slice(0,60)||'frame');
  const collect=(root,ox,oy,clip,frame,out)=>{
    out.push({root,ox,oy,clip,frame});
    if(out.length>200)return;
    for(const e of root.querySelectorAll('*')){
      if(e.shadowRoot)collect(e.shadowRoot,ox,oy,clip,frame,out);
      if(FRAME(e)){
        const d=sameOriginDoc(e);if(!d)continue;
        const r=e.getBoundingClientRect();
        const fx=ox+r.left+e.clientLeft,fy=oy+r.top+e.clientTop;
        const c={l:Math.max(clip.l,ox+r.left),t:Math.max(clip.t,oy+r.top),r:Math.min(clip.r,ox+r.right),b:Math.min(clip.b,oy+r.bottom)};
        collect(d,fx,fy,c,(frame?frame+' > ':'')+frameLabel(e),out);
      }
    }
  };
  const allRoots=()=>{const out=[];collect(document,0,0,{l:0,t:0,r:innerWidth,b:innerHeight},'',out);return out;};
  const opaqueFrames=()=>{const out=[];for(const {root,ox,oy,clip,frame} of allRoots())for(const f of root.querySelectorAll('iframe,frame')){if(!sameOriginDoc(f))out.push({frame:f,ox,oy,clip,parent:frame,label:frameLabel(f)});}return out;};
  const elementFromPoint=(x,y)=>{
    let doc=document,ox=0,oy=0,el=null;
    for(let i=0;i<32;i++){
      let e=doc.elementFromPoint(x-ox,y-oy);if(!e)break;
      while(e.shadowRoot){const inner=e.shadowRoot.elementFromPoint(x-ox,y-oy);if(!inner||inner===e)break;e=inner;}
      el=e;
      if(!FRAME(e))break;
      const d=sameOriginDoc(e);if(!d)break;
      const r=e.getBoundingClientRect();ox=ox+r.left+e.clientLeft;oy=oy+r.top+e.clientTop;doc=d;
    }
    return el;
  };
  const activeElement=()=>{
    let el=document.activeElement;
    for(let i=0;i<32&&el;i++){
      if(el.shadowRoot&&el.shadowRoot.activeElement)el=el.shadowRoot.activeElement;
      else if(FRAME(el)){const d=sameOriginDoc(el);if(d&&d.activeElement&&d.activeElement!==d.body)el=d.activeElement;else break;}
      else break;
    }
    return el;
  };
  const rootText=root=>{
    if(root.body)return root.body.innerText||'';
    if(root.host)return [...root.children].filter(c=>!/^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(c.tagName)).map(c=>c.innerText||'').filter(Boolean).join('\\n');
    return '';
  };
  const text=max=>{
    const parts=[];let total=0;
    for(const {root,frame} of allRoots()){
      const t=rootText(root).trim();if(!t)continue;
      parts.push(frame?'[frame: '+frame+']\\n'+t:t);total+=t.length;
      if(total>max)break;
    }
    return parts.join('\\n\\n').slice(0,max);
  };
  const querySelectorAll=(sel,limit)=>{const out=[];for(const r of allRoots()){for(const e of r.root.querySelectorAll(sel)){out.push(e);if(out.length>=limit)return out;}}return out;};
  const recorders=()=>{const out=[];for(const {root,frame} of allRoots()){const w=root.defaultView;if(w&&w.__ofxRec)out.push({rec:w.__ofxRec,frame});}return out;};
  return {allRoots,opaqueFrames,elementFromPoint,activeElement,text,querySelectorAll,recorders,sameOriginDoc,frameLabel};
})()`;

/** Wrap a page expression body so it can use `D` (the deep-DOM helpers). */
export function withDeepDom(body: string): string {
    return `(()=>{const D=${DEEP_DOM_SOURCE};${body}})()`;
}
