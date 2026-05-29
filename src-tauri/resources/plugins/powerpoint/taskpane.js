(function(){'use strict';
// ── i18n ─────────────────────────────────────────────────────────────────────
const translations={
zh:{statusConnecting:'正在连接…',statusAuthenticating:'认证中…',statusRegistering:'注册中…',statusReady:'已连接 OpenFlux',statusDisconnected:'连接断开',statusError:'连接失败',reconnectIn:s=>`${s} 秒后自动重连`,retryBtn:'立即重连',logTitle:'📋 操作记录',clearBtn:'清空',emptyHint:'OpenFlux 对当前演示文稿的操作\n将显示在这里',pluginName:n=>`PowerPoint - ${n}`,pluginDesc:n=>`PowerPoint 插件，当前文档：${n}`,unknownDoc:'未知文档',errConnect:'无法连接',errUnknown:'未知错误',errPrefix:'错误：',
ops:{
  ppt_get_presentation_info:{icon:'ℹ️',action:'获取演示文稿信息'},
  ppt_get_slides:{icon:'📑',action:'获取幻灯片列表'},
  ppt_get_slide_content:{icon:'📄',action:'读取幻灯片内容'},
  ppt_get_slide_details:{icon:'🔬',action:'分析幻灯片详情'},
  ppt_clear_slide:{icon:'🧹',action:'清空幻灯片'},
  ppt_move_resize_shape:{icon:'↔️',action:'调整形状'},
  ppt_replace_placeholder:{icon:'✍️',action:'替换占位文字'},
  ppt_add_slide:{icon:'➕',action:'新增幻灯片'},
  ppt_delete_slide:{icon:'🗑️',action:'删除幻灯片'},
  ppt_delete_slides:{icon:'🗑️',action:'批量删除幻灯片'},
  ppt_duplicate_slide:{icon:'📋',action:'复制幻灯片'},
  ppt_move_slide:{icon:'↕️',action:'移动幻灯片'},
  ppt_navigate_to_slide:{icon:'🔍',action:'跳转幻灯片'},
  ppt_set_slide_background:{icon:'🎨',action:'设置幻灯片背景'},
  ppt_add_text_box:{icon:'✏️',action:'添加文本框'},
  ppt_update_shape_text:{icon:'🔤',action:'更新形状文本'},
  ppt_format_shape_text:{icon:'🎨',action:'格式化文字'},
  ppt_add_shape:{icon:'🔷',action:'添加形状'},
  ppt_delete_shape:{icon:'🗑️',action:'删除形状'},
  ppt_set_shape_fill:{icon:'🖌️',action:'设置形状填充'},
  ppt_add_image:{icon:'🖼️',action:'插入图片'},
  ppt_add_table:{icon:'📊',action:'插入表格'},
  ppt_set_slide_layout:{icon:'📐',action:'应用幻灯片版式'},
  ppt_save:{icon:'💾',action:'保存演示文稿'},
  ppt_list_presentations:{icon:'📂',action:'列出已连接文档'},
}},
en:{statusConnecting:'Connecting…',statusAuthenticating:'Authenticating…',statusRegistering:'Registering…',statusReady:'Connected to OpenFlux',statusDisconnected:'Disconnected',statusError:'Connection failed',reconnectIn:s=>`Reconnecting in ${s}s`,retryBtn:'Reconnect',logTitle:'📋 Activity Log',clearBtn:'Clear',emptyHint:'OpenFlux operations on this presentation\nwill appear here',pluginName:n=>`PowerPoint - ${n}`,pluginDesc:n=>`PowerPoint add-in, document: ${n}`,unknownDoc:'Unknown Presentation',errConnect:'Unable to connect',errUnknown:'Unknown error',errPrefix:'Error: ',
ops:{
  ppt_get_presentation_info:{icon:'ℹ️',action:'Get presentation info'},
  ppt_get_slides:{icon:'📑',action:'Get slides list'},
  ppt_get_slide_content:{icon:'📄',action:'Read slide content'},
  ppt_get_slide_details:{icon:'🔬',action:'Analyze slide details'},
  ppt_clear_slide:{icon:'🧹',action:'Clear slide'},
  ppt_move_resize_shape:{icon:'↔️',action:'Move/resize shape'},
  ppt_replace_placeholder:{icon:'✍️',action:'Replace placeholder text'},
  ppt_add_slide:{icon:'➕',action:'Add slide'},
  ppt_delete_slide:{icon:'🗑️',action:'Delete slide'},
  ppt_delete_slides:{icon:'🗑️',action:'Delete multiple slides'},
  ppt_duplicate_slide:{icon:'📋',action:'Duplicate slide'},
  ppt_move_slide:{icon:'↕️',action:'Move slide'},
  ppt_navigate_to_slide:{icon:'🔍',action:'Navigate to slide'},
  ppt_set_slide_background:{icon:'🎨',action:'Set slide background'},
  ppt_add_text_box:{icon:'✏️',action:'Add text box'},
  ppt_update_shape_text:{icon:'🔤',action:'Update shape text'},
  ppt_format_shape_text:{icon:'🎨',action:'Format text'},
  ppt_add_shape:{icon:'🔷',action:'Add shape'},
  ppt_delete_shape:{icon:'🗑️',action:'Delete shape'},
  ppt_set_shape_fill:{icon:'🖌️',action:'Set shape fill'},
  ppt_add_image:{icon:'🖼️',action:'Insert image'},
  ppt_add_table:{icon:'📊',action:'Insert table'},
  ppt_set_slide_layout:{icon:'📐',action:'Apply slide layout'},
  ppt_save:{icon:'💾',action:'Save presentation'},
  ppt_list_presentations:{icon:'📂',action:'List connected presentations'},
}}
};
function detectLang(){let l='';try{if(typeof Office!=='undefined'&&Office.context&&Office.context.displayLanguage)l=Office.context.displayLanguage;}catch(e){}if(!l)l=navigator.language||'';return l.toLowerCase().startsWith('zh')?'zh':'en';}

// ── CSS ───────────────────────────────────────────────────────────────────────
const css=`*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#1a1a2e;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}.status-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#16213e;border-bottom:1px solid #0f3460;flex-shrink:0}.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;transition:background .3s}.status-ready{background:#4ade80;box-shadow:0 0 6px #4ade8088}.status-connecting{background:#facc15;animation:pulse 1.2s infinite}.status-idle{background:#6b7280}.status-error{background:#f87171}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}.status-info{flex:1;display:flex;flex-direction:column;gap:1px}#status-text{font-size:13px;font-weight:500;color:#e0e0e0}.reconnect-hint{font-size:11px;color:#9ca3af}.retry-btn{padding:4px 10px;background:#0f3460;color:#93c5fd;border:1px solid #1d4ed8;border-radius:4px;cursor:pointer;font-size:11px;transition:background .2s;white-space:nowrap}.retry-btn:hover{background:#1e40af}.log-section{flex:1;display:flex;flex-direction:column;overflow:hidden}.log-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px 6px;border-bottom:1px solid #0f3460;flex-shrink:0}.log-title{font-size:11px;font-weight:600;color:#6b7280;letter-spacing:.05em;text-transform:uppercase}.clear-btn{background:transparent;border:none;color:#4b5563;font-size:11px;cursor:pointer;padding:2px 6px;border-radius:3px;transition:color .2s}.clear-btn:hover{color:#9ca3af}.log-box{flex:1;overflow-y:auto;padding:8px 0}.empty-hint{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;min-height:120px;color:#4b5563;text-align:center;line-height:1.6;padding:24px}.empty-icon{font-size:28px;opacity:.5}.log-entry{display:flex;gap:8px;padding:7px 12px;border-bottom:1px solid #0f346022;animation:slideIn .2s ease}.log-entry:last-child{border-bottom:none}.log-entry.entry-error{background:#7f1d1d22}@keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}.log-entry-icon{font-size:14px;flex-shrink:0;line-height:1.6}.log-entry-body{flex:1;min-width:0}.log-entry-action{font-size:12px;font-weight:500;color:#cbd5e1;line-height:1.5}.log-entry-detail{font-size:11px;color:#6b7280;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.log-entry-time{font-size:10px;color:#374151;flex-shrink:0;line-height:2}`;
const styleEl=document.createElement('style');styleEl.textContent=css;document.head.appendChild(styleEl);

// ── OpenFluxPluginClient ──────────────────────────────────────────────────────
class OpenFluxPluginClient{
  constructor(cfg){this.ws=null;this.tools=new Map;this.pending=new Map;this.status='disconnected';this.destroyed=false;this.cfg=cfg;}
  registerTool(t){this.tools.set(t.name,t);return this;}
  onStatus(fn){this._onStatus=fn;return this;}
  onToolCall(fn){this._onCall=fn;return this;}
  onToolResult(fn){this._onResult=fn;return this;}
  async connect(){this.destroyed=false;this._setStatus('connecting');return new Promise((res,rej)=>{
    try{this.ws=new WebSocket(this.cfg.gatewayUrl);}catch(e){this._setStatus('error',String(e));return rej(e);}clearTimeout(this._cwd);this._ready=false;this._cwd=setTimeout(()=>{if(!this._ready){try{this.ws&&this.ws.close();}catch(e){}}},8000);
    this.ws.onopen=()=>this._setStatus('authenticating');
    this.ws.onmessage=ev=>{try{this._handle(JSON.parse(ev.data),res,rej);}catch(e){}};
    this.ws.onclose=()=>{clearTimeout(this._cwd);this._ready=false;this._setStatus('disconnected');if(!this.destroyed)this._rt=setTimeout(()=>this.connect().catch(()=>{}),5000);};
    this.ws.onerror=e=>{this._setStatus('error','WebSocket error');rej(e);};
  });}
  disconnect(){this.destroyed=true;clearTimeout(this._rt);if(this.ws){this.ws.close();this.ws=null;}}
  _handle(msg,res,rej){const{type,id,payload:p}=msg;
    if(type==='welcome'){if(p&&p.requireAuth&&this.cfg.token){this._send({type:'auth',id:this._uid(),payload:{token:this.cfg.token}});}else{this._setStatus('registering');this._register();}}
    else if(type==='auth.success'){this._setStatus('registering');this._register();}
    else if(type==='auth.error'){this._setStatus('error','Auth failed');rej(new Error('Auth failed'));}
    else if(type==='plugin.register.ack'){if(p&&p.success){this._ready=true;clearTimeout(this._cwd);this._setStatus('ready');res();}else{this._setStatus('error',p&&p.error);rej(new Error(p&&p.error));}}
    else if(type==='mcp.client.call'&&id){this._callTool(id,p);}
  }
  async _callTool(id,p){const{tool,args={}}=p;const t=this.tools.get(tool);if(this._onCall)this._onCall(tool,args);
    if(!t){const r={success:false,error:`Tool "${tool}" not found`};if(this._onResult)this._onResult(tool,args,r);this._send({type:'mcp.client.result',id,payload:r});return;}
    try{const r=await t.execute(args);if(this._onResult)this._onResult(tool,args,r);this._send({type:'mcp.client.result',id,payload:{success:r.success,result:r}});}
    catch(e){const r={success:false,error:String(e)};if(this._onResult)this._onResult(tool,args,r);this._send({type:'mcp.client.result',id,payload:r});}
  }
  _register(){const tools=Array.from(this.tools.values()).map(t=>({name:t.name,description:t.description,parameters:t.parameters}));
    this._send({type:'plugin.register',id:this._uid(),payload:{pluginId:this.cfg.pluginId,name:this.cfg.name,version:this.cfg.version,description:this.cfg.description||'',icon:this.cfg.icon||'📽️',tools,capabilities:['tools'],metadata:{platform:'office-addin',officeHost:'PowerPoint'}}});}
  _send(obj){if(this.ws&&this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(obj));}
  _setStatus(s,m){this.status=s;if(this._onStatus)this._onStatus(s,m);}
  _uid(){return crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2);}
}

// ── helpers ───────────────────────────────────────────────────────────────────
// 十六进制色值 → Office RGB 整数（Office API 接受 0xRRGGBB 格式）
function hexToInt(hex){
  const h=(hex||'').replace('#','');
  if(h.length===3)return parseInt(h[0]+h[0]+h[1]+h[1]+h[2]+h[2],16);
  if(h.length===6)return parseInt(h,16);
  return null;
}

// Office 百分比坐标 → pt（幻灯片默认宽 10in=720pt, 高 7.5in=540pt）
// 若传入的值 <=1 视为百分比，否则视为 pt 直接使用
function toPoints(v, total){
  if(v===undefined||v===null)return undefined;
  return v<=1 ? Math.round(v*total) : v;
}

const SLIDE_W=720, SLIDE_H=540; // standard 10×7.5 inch in points

// 错误友好化
function friendlyError(e){
  const s=String(e);
  if(s.includes('InvalidArgument'))return '⚠️ 参数无效，请检查坐标/颜色/索引等参数';
  if(s.includes('ItemNotFound'))return '⚠️ 未找到目标幻灯片或形状，请检查索引';
  if(s.includes('AccessDenied'))return '⚠️ 文档受保护或只读，请先启用编辑';
  if(s.includes('GeneralException'))return '⚠️ 操作失败，文档可能处于只读状态';
  return s;
}

// ── PPT 工具集（设计 + 生产导向）────────────────────────────────────────────
const PPT_TOOLS=[

// ── 信息读取 ──────────────────────────────────────────────────────────────────
{name:'ppt_get_presentation_info',
 description:'Get basic information about the current PowerPoint presentation: title, slide count, slide size.',
 parameters:{},
 execute:async()=>{try{
   const info=await PowerPoint.run(async ctx=>{
     const p=ctx.presentation;
     p.load('title');
     const slides=p.slides;
     slides.load('items');
     await ctx.sync();
     return{title:p.title||'Untitled',slideCount:slides.items.length};
   });
   return{success:true,data:info};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_get_slides',
 description:'Get the list of all slides: index (0-based), id, and shape count.',
 parameters:{},
 execute:async()=>{try{
   const slides=await PowerPoint.run(async ctx=>{
     const items=ctx.presentation.slides;
     items.load('items');
     await ctx.sync();
     items.items.forEach(s=>s.shapes.load('items'));
     await ctx.sync();
     return items.items.map((s,i)=>({index:i,id:s.id,shapeCount:s.shapes.items.length}));
   });
   return{success:true,data:{slides,count:slides.length}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_get_slide_content',
 description:'Get all text content from a specific slide by index (0-based). Returns each shape\'s name and text.',
 parameters:{slide_index:{type:'number',description:'Slide index, 0-based',required:true}},
 execute:async(args)=>{try{
   const content=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(sh=>{sh.load('name');sh.textFrame.load('text');});
     await ctx.sync();
     return slide.shapes.items.map(sh=>({name:sh.name,text:sh.textFrame.text||''}));
   });
   return{success:true,data:{shapes:content,count:content.length}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_list_presentations',
 description:'Return information about the currently connected presentation.',
 parameters:{},
 execute:async()=>{try{
   const name=await PowerPoint.run(async ctx=>{
     ctx.presentation.load('title');
     await ctx.sync();
     return ctx.presentation.title||'Untitled';
   });
   return{success:true,data:{presentations:[name],count:1}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

// ── 内容分析（AI 决策核心）───────────────────────────────────────────────────
{name:'ppt_get_slide_details',
 description:'Get full details of every shape on a slide: name, type (textBox/placeholder/picture/table/geometricShape/etc.), text content, position (left/top/width/height in points). Use this FIRST to understand existing layout before making edits. Identifies default placeholders created by PowerPoint.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index (default 0)',required:false},
   all_slides:{type:'boolean',description:'If true, analyze ALL slides and return a summary. Overrides slide_index.',required:false},
 },
 execute:async(args)=>{try{
   const result=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const analyzeSlide=async(slide,idx)=>{
       slide.shapes.load('items');
       await ctx.sync();
       slide.shapes.items.forEach(sh=>{
         sh.load('name,shapeType,left,top,width,height,textFrame/hasText');
       });
       await ctx.sync();
       // Load text for shapes that have it
       const withText=slide.shapes.items.filter(sh=>sh.textFrame&&sh.textFrame.hasText!==false);
       withText.forEach(sh=>{try{sh.textFrame.load('text');}catch(e){}});
       await ctx.sync();
       return{
         slideIndex:idx,
         shapeCount:slide.shapes.items.length,
         shapes:slide.shapes.items.map(sh=>({
           name:sh.name,
           type:sh.shapeType||'unknown',
           left:Math.round(sh.left),
           top:Math.round(sh.top),
           width:Math.round(sh.width),
           height:Math.round(sh.height),
           text:sh.textFrame&&sh.textFrame.hasText!==false?(sh.textFrame.text||'').trim():'',
           isEmpty:!sh.textFrame||(sh.textFrame.text||'').trim()==='',
         })),
       };
     };
     if(args.all_slides){
       const all=[];
       for(let i=0;i<slides.items.length;i++){
         all.push(await analyzeSlide(slides.items[i],i));
       }
       return{slides:all,totalSlides:slides.items.length};
     }else{
       const idx=args.slide_index||0;
       if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
       return await analyzeSlide(slides.items[idx],idx);
     }
   });
   return{success:true,data:result};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_clear_slide',
 description:'Remove ALL shapes from a slide, leaving it completely blank. Use when the slide has unwanted default placeholders or you need to rebuild the layout from scratch. Optionally keep specific shapes by name.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index (default 0)',required:false},
   keep_shape_names:{type:'array',description:'Array of shape names to keep. All others will be deleted. Omit to delete everything.',required:false},
 },
 execute:async(args)=>{try{
   const deleted=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(sh=>sh.load('name'));
     await ctx.sync();
     const keepSet=new Set(args.keep_shape_names||[]);
     const toDelete=slide.shapes.items.filter(sh=>!keepSet.has(sh.name));
     toDelete.forEach(sh=>sh.delete());
     await ctx.sync();
     return{deletedCount:toDelete.length,keptCount:keepSet.size};
   });
   return{success:true,data:deleted};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_move_resize_shape',
 description:'Move and/or resize an existing shape on a slide. Useful for repositioning default placeholders or adjusting layout. Provide only the properties you want to change.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index',required:true},
   shape_name:{type:'string',description:'Shape name to target (from ppt_get_slide_details)',required:false},
   shape_index:{type:'number',description:'0-based shape index on the slide',required:false},
   left:{type:'number',description:'New left position in points',required:false},
   top:{type:'number',description:'New top position in points',required:false},
   width:{type:'number',description:'New width in points',required:false},
   height:{type:'number',description:'New height in points',required:false},
 },
 execute:async(args)=>{try{
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const slide=slides.items[args.slide_index||0];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(s=>s.load('name'));
     await ctx.sync();
     let shape=null;
     if(args.shape_name){shape=slide.shapes.items.find(s=>s.name===args.shape_name)||null;}
     if(!shape&&args.shape_index!==undefined){shape=slide.shapes.items[args.shape_index]||null;}
     if(!shape)throw new Error('ItemNotFound: shape not found');
     if(args.left!==undefined)shape.left=args.left;
     if(args.top!==undefined)shape.top=args.top;
     if(args.width!==undefined)shape.width=args.width;
     if(args.height!==undefined)shape.height=args.height;
     await ctx.sync();
   });
   return{success:true,data:{moved:true}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_replace_placeholder',
 description:'Replace text in existing shapes by shape identifier name (from ppt_get_slide_details). Use shape_name values like "Title 1", "Subtitle 2", "TextBox 3" — NOT text content. Accepts single object or array.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index (default 0)',required:false},
   replacements:{type:'array',description:'Array of {shape_name, text}. shape_name is the identifier from ppt_get_slide_details (e.g. "Title 1"). Example: [{"shape_name":"Title 1","text":"My Title"},{"shape_name":"Subtitle 2","text":"Subtitle"}]',required:true},
   font_size:{type:'number',description:'Font size override (optional)',required:false},
   font_color:{type:'string',description:'Font color hex override e.g. "#ffffff" (optional)',required:false},
   bold:{type:'boolean',description:'Bold override (optional)',required:false},
 },
 execute:async(args)=>{try{
   // Normalize: accept single object or array
   let reps=args.replacements;
   if(!Array.isArray(reps)){
     if(reps&&typeof reps==='object'&&reps.shape_name)reps=[reps];
     else return{success:false,error:'replacements must be [{shape_name,text},...]. Call ppt_get_slide_details first to get valid shape_name identifiers.'};
   }
   if(reps.length===0)return{success:false,error:'replacements array is empty'};
   const applied=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(s=>s.load('name'));
     await ctx.sync();
     // Build name→shape map
     const nameMap=new Map(slide.shapes.items.map(s=>[s.name,s]));
     const availableNames=slide.shapes.items.map(s=>s.name);
     const results=[];
     for(const rep of reps){
       let shape=nameMap.get(rep.shape_name)||null;
       // Fallback by index if provided
       if(!shape&&rep.shape_index!==undefined)shape=slide.shapes.items[rep.shape_index]||null;
       if(!shape){
         results.push({shape_name:rep.shape_name,success:false,
           error:`Shape "${rep.shape_name}" not found. Available: ${availableNames.join(', ')}`});
         continue;
       }
       const tr=shape.textFrame.textRange;
       tr.text=rep.text||'';
       if(args.font_size)tr.font.size=args.font_size;
       if(args.font_color)tr.font.color=args.font_color.replace('#','');
       if(args.bold!==undefined)tr.font.bold=args.bold;
       results.push({shape_name:rep.shape_name,success:true});
     }
     await ctx.sync();
     return{results,availableShapeNames:availableNames};
   });
   return{success:true,data:{results:applied.results,count:applied.results.filter(r=>r.success).length,availableShapeNames:applied.availableShapeNames}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},


// ── 幻灯片管理 ────────────────────────────────────────────────────────────────
{name:'ppt_add_slide',
 description:'Add a new blank slide at the end of the presentation. All default placeholders (title/subtitle text boxes) are automatically deleted so the slide starts completely empty. Pass keep_placeholders:true to retain them.',
 parameters:{
   slide_layout_name:{type:'string',description:'Optional layout name (e.g. "Blank"). Ignored unless keep_placeholders is true.',required:false},
   keep_placeholders:{type:'boolean',description:'Default false. If true, default title/subtitle boxes are kept. If false (default), they are deleted automatically.',required:false},
 },
 execute:async(args)=>{try{
   const result=await PowerPoint.run(async ctx=>{
     let layoutId=undefined;
     if(args.slide_layout_name){
       try{
         const masters=ctx.presentation.slideMasters;
         masters.load('items');
         await ctx.sync();
         if(masters.items.length>0){
           const layouts=masters.items[0].layouts;
           layouts.load('items');
           await ctx.sync();
           layouts.items.forEach(l=>l.load('name,id'));
           await ctx.sync();
           const found=layouts.items.find(l=>l.name.toLowerCase().includes((args.slide_layout_name||'').toLowerCase()));
           if(found)layoutId=found.id;
         }
       }catch(le){/* layout lookup failed, add blank */}
     }
     const addOpts=layoutId?{layoutId}:{};
     ctx.presentation.slides.add(addOpts);
     await ctx.sync();
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const newSlide=slides.items[slides.items.length-1];
     let clearedCount=0;
     if(!args.keep_placeholders){
       newSlide.shapes.load('items');
       await ctx.sync();
       const toDelete=newSlide.shapes.items.slice();
       toDelete.forEach(sh=>sh.delete());
       clearedCount=toDelete.length;
       await ctx.sync();
     }
     return{added:true,totalSlides:slides.items.length,clearedPlaceholders:clearedCount};
   });
   return{success:true,data:result};
 }catch(e){return{success:false,error:friendlyError(e)};}}},


{name:'ppt_delete_slide',
 description:'Delete ONE slide by 0-based index. WARNING: Do NOT call this in parallel for multiple slides — indices shift after each deletion causing errors. Use ppt_delete_slides (plural) to delete multiple slides in one call.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index to delete',required:true},
 },
 execute:async(args)=>{try{
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx} (total: ${slides.items.length})`);
     slides.items[idx].delete();
     await ctx.sync();
   });
   return{success:true,data:{deleted:true,index:args.slide_index}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_delete_slides',
 description:'Delete MULTIPLE slides in one call. Always use this instead of calling ppt_delete_slide repeatedly. Slides are deleted from highest index to lowest so indices do not shift during deletion.',
 parameters:{
   slide_indices:{type:'array',description:'Array of 0-based slide indices to delete, e.g. [1,2,3,4]. Order does not matter — they are sorted internally.',required:true},
 },
 execute:async(args)=>{try{
   if(!Array.isArray(args.slide_indices)||args.slide_indices.length===0){
     return{success:false,error:'slide_indices must be a non-empty array of numbers'};
   }
   const result=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const total=slides.items.length;
     // Deduplicate and sort descending to avoid index shifting
     const indices=[...new Set(args.slide_indices)]
       .filter(i=>typeof i==='number'&&i>=0&&i<total)
       .sort((a,b)=>b-a);
     const skipped=args.slide_indices.filter(i=>i<0||i>=total);
     indices.forEach(i=>slides.items[i].delete());
     await ctx.sync();
     slides.load('items');
     await ctx.sync();
     return{deleted:indices.length,remaining:slides.items.length,skipped};
   });
   return{success:true,data:result};
 }catch(e){return{success:false,error:friendlyError(e)};}}},


{name:'ppt_duplicate_slide',
 description:'Duplicate a slide at the given index and insert the copy at the end of the presentation.',
 parameters:{
   slide_index:{type:'number',description:'0-based index of slide to duplicate',required:true},
 },
 execute:async(args)=>{try{
   const result=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     // Correct API: slides.add({ copiedFrom: sourceSlide })
     const source=slides.getItemAt(idx);
     ctx.presentation.slides.add({copiedFrom:source});
     await ctx.sync();
     slides.load('items');
     await ctx.sync();
     return{duplicated:true,sourceIndex:idx,totalSlides:slides.items.length};
   });
   return{success:true,data:result};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_navigate_to_slide',
 description:'Navigate (select/activate) a slide by 0-based index so the user can see it.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index',required:true},
 },
 execute:async(args)=>{try{
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     slides.items[idx].setSelectedSlides([slides.items[idx]]);
     await ctx.sync();
   });
   return{success:true,data:{navigated:true,index:args.slide_index}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

// ── 幻灯片背景 ────────────────────────────────────────────────────────────────
{name:'ppt_set_slide_background',
 description:'Set the background color of one or all slides.',
 parameters:{
   color:{type:'string',description:'Hex color code, e.g. "#1a1a2e" or "#ffffff"',required:true},
   slide_index:{type:'number',description:'0-based slide index. Omit to apply to ALL slides.',required:false},
 },
 execute:async(args)=>{try{
   const hex=(args.color||'').replace('#','');
   if(!hex)return{success:false,error:'Invalid color format. Use hex like #ff5500'};
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const targets=args.slide_index!==undefined?[slides.items[args.slide_index]]:slides.items;
     // Correct API: slide.background.setSolidColor(rrggbb)
     targets.forEach(slide=>{
       slide.background.setSolidColor(hex);
     });
     await ctx.sync();
   });
   return{success:true,data:{color:args.color,appliedTo:args.slide_index!==undefined?`slide ${args.slide_index}`:'all slides'}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},


// ── 文本框操作 ────────────────────────────────────────────────────────────────
{name:'ppt_add_text_box',
 description:'Add a text box to a slide with precise position and rich formatting. Coordinates are in points (1 inch = 72pt). Slide is 720×540pt by default.',
 parameters:{
   text:{type:'string',description:'Text content to insert',required:true},
   slide_index:{type:'number',description:'0-based slide index (default 0 = current slide)',required:false},
   left:{type:'number',description:'Left position in points (default 72 = 1 inch)',required:false},
   top:{type:'number',description:'Top position in points (default 72 = 1 inch)',required:false},
   width:{type:'number',description:'Width in points (default 576 = 8 inches)',required:false},
   height:{type:'number',description:'Height in points (default 72 = 1 inch)',required:false},
   font_size:{type:'number',description:'Font size in points (default 24)',required:false},
   font_name:{type:'string',description:'Font name, e.g. "Arial", "微软雅黑", "Times New Roman"',required:false},
   bold:{type:'boolean',description:'Bold text',required:false},
   italic:{type:'boolean',description:'Italic text',required:false},
   color:{type:'string',description:'Text color hex, e.g. "#ffffff"',required:false},
   align:{type:'string',description:'Horizontal alignment: "Left", "Center", "Right", "Justify"',required:false},
 },
 execute:async(args)=>{try{
   const shapeName=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     const opts={
       left:args.left||72,
       top:args.top||72,
       width:args.width||576,
       height:args.height||72,
     };
     const shape=slide.shapes.addTextBox(args.text,opts);
     shape.load('name');
     // Apply text formatting
     const tf=shape.textFrame;
     tf.load('paragraphs');
     await ctx.sync();
     // Font on the whole textRange
     const tr=tf.textRange;
     if(args.font_size)tr.font.size=args.font_size;
     if(args.font_name)tr.font.name=args.font_name;
     if(args.bold!==undefined)tr.font.bold=args.bold;
     if(args.italic!==undefined)tr.font.italic=args.italic;
     if(args.color)tr.font.color=args.color.replace('#','');
     if(args.align)tr.paragraphFormat.horizontalAlignment=PowerPoint.ParagraphHorizontalAlignment[args.align]||args.align;
     await ctx.sync();
     return shape.name;
   });
   return{success:true,data:{added:true,shapeName}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_update_shape_text',
 description:'Update the text of ONE existing shape. shape_name is the shape IDENTIFIER like "Title 1", "TextBox 3" from ppt_get_slide_details — never the text content. Use shape_index (0-based) if shape_name is unknown.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index',required:true},
   shape_name:{type:'string',description:'Shape identifier from ppt_get_slide_details (e.g. "Title 1"). NOT text content.',required:false},
   shape_index:{type:'number',description:'0-based shape index (use when shape_name is unknown)',required:false},
   text:{type:'string',description:'New text content to set',required:true},
 },
 execute:async(args)=>{try{
   const result=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const slide=slides.items[args.slide_index||0];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(s=>s.load('name'));
     await ctx.sync();
     const availableNames=slide.shapes.items.map(s=>s.name);
     let shape=null;
     // 1. Exact shape identifier match
     if(args.shape_name)shape=slide.shapes.items.find(s=>s.name===args.shape_name)||null;
     // 2. shape_index
     if(!shape&&args.shape_index!==undefined)shape=slide.shapes.items[args.shape_index]||null;
     // 3. Fuzzy: current text contains or is contained by shape_name arg
     if(!shape&&args.shape_name&&slide.shapes.items.length>0){
       slide.shapes.items.forEach(s=>{try{s.textFrame.load('text');}catch(e){}});
       await ctx.sync();
       shape=slide.shapes.items.find(s=>{
         try{
           const t=(s.textFrame.text||'').trim();
           const q=(args.shape_name||'').trim();
           return t&&(t.includes(q)||q.includes(t));
         }catch(e){return false;}
       })||null;
     }
     // 4. Last resort: first shape on slide
     if(!shape&&slide.shapes.items.length>0&&args.shape_index===undefined){
       // Only use this if shape_index was explicitly 0 would be confusing, skip
     }
     if(!shape){
       throw new Error(`Shape not found. Available shapes on slide ${args.slide_index||0}: [${availableNames.map(n=>'"'+n+'"').join(', ')}]. Use one of these as shape_name.`);
     }
     shape.textFrame.textRange.text=args.text;
     await ctx.sync();
     return{updated:true,shapeName:shape.name};
   });
   return{success:true,data:result};
 }catch(e){return{success:false,error:String(e).replace('Error: ','')};}}},

{name:'ppt_format_shape_text',
 description:'Apply rich text formatting (font, size, color, bold, italic, alignment) to an existing shape\'s text.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index',required:true},
   shape_name:{type:'string',description:'Shape name (preferred)',required:false},
   shape_index:{type:'number',description:'0-based shape index on the slide',required:false},
   font_size:{type:'number',description:'Font size in points',required:false},
   font_name:{type:'string',description:'Font name',required:false},
   bold:{type:'boolean',description:'Bold',required:false},
   italic:{type:'boolean',description:'Italic',required:false},
   color:{type:'string',description:'Text color hex e.g. "#ff0000"',required:false},
   align:{type:'string',description:'"Left","Center","Right","Justify"',required:false},
 },
 execute:async(args)=>{try{
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const slide=slides.items[args.slide_index||0];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(s=>s.load('name'));
     await ctx.sync();
     let shape=null;
     if(args.shape_name){shape=slide.shapes.items.find(s=>s.name===args.shape_name)||null;}
     if(!shape&&args.shape_index!==undefined){shape=slide.shapes.items[args.shape_index]||null;}
     if(!shape)throw new Error('ItemNotFound: shape not found');
     const tr=shape.textFrame.textRange;
     if(args.font_size)tr.font.size=args.font_size;
     if(args.font_name)tr.font.name=args.font_name;
     if(args.bold!==undefined)tr.font.bold=args.bold;
     if(args.italic!==undefined)tr.font.italic=args.italic;
     if(args.color)tr.font.color=args.color.replace('#','');
     if(args.align)tr.paragraphFormat.horizontalAlignment=args.align;
     await ctx.sync();
   });
   return{success:true,data:{formatted:true}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

// ── 形状操作 ──────────────────────────────────────────────────────────────────
{name:'ppt_add_shape',
 description:'Add a geometric shape (rectangle, circle, arrow, etc.) to a slide with fill color and optional text label.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index (default 0)',required:false},
   shape_type:{type:'string',description:'Shape type: "Rectangle", "RoundedRectangle", "Ellipse", "Triangle", "RightTriangle", "Diamond", "Pentagon", "Hexagon", "Arrow", "Heart", "Star4", "Star5", "Star8", "Cloud", "Line". Default: "Rectangle"',required:false},
   left:{type:'number',description:'Left position in points',required:false},
   top:{type:'number',description:'Top position in points',required:false},
   width:{type:'number',description:'Width in points (default 144)',required:false},
   height:{type:'number',description:'Height in points (default 108)',required:false},
   fill_color:{type:'string',description:'Fill color hex e.g. "#4f46e5"',required:false},
   line_color:{type:'string',description:'Border color hex e.g. "#ffffff". Use "none" for no border.',required:false},
   text:{type:'string',description:'Optional text label inside the shape',required:false},
   font_size:{type:'number',description:'Font size for label (default 18)',required:false},
   font_color:{type:'string',description:'Text color hex (default "#ffffff")',required:false},
 },
 execute:async(args)=>{try{
   const shapeName=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     // Map friendly name → GeometricShapeType enum
     const typeMap={
       Rectangle:'rectangle',RoundedRectangle:'roundedRectangle',Ellipse:'ellipse',
       Triangle:'triangle',RightTriangle:'rightTriangle',Diamond:'diamond',
       Pentagon:'pentagon',Hexagon:'hexagon',Arrow:'rightArrow',
       Heart:'heart',Star4:'star4',Star5:'star5',Star8:'star8',Cloud:'cloud',
     };
     const shapeType=typeMap[args.shape_type||'Rectangle']||'rectangle';
     const opts={
       left:args.left||144,top:args.top||144,
       width:args.width||144,height:args.height||108,
     };
     const shape=slide.shapes.addGeometricShape(shapeType,opts);
     shape.load('name');
     await ctx.sync();
     // Fill color
     if(args.fill_color){
       shape.fill.setSolidColor(args.fill_color.replace('#',''));
     }
     // Border
     if(args.line_color==='none'){
       shape.lineFormat.visible=false;
     } else if(args.line_color){
       shape.lineFormat.color=args.line_color.replace('#','');
     }
     // Text label
     if(args.text){
       shape.textFrame.textRange.text=args.text;
       shape.textFrame.textRange.font.size=args.font_size||18;
       shape.textFrame.textRange.font.color=(args.font_color||'#ffffff').replace('#','');
     }
     await ctx.sync();
     return shape.name;
   });
   return{success:true,data:{added:true,shapeName}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_delete_shape',
 description:'Delete a shape from a slide by name or index.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index',required:true},
   shape_name:{type:'string',description:'Shape name (preferred)',required:false},
   shape_index:{type:'number',description:'0-based shape index',required:false},
 },
 execute:async(args)=>{try{
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const slide=slides.items[args.slide_index||0];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(s=>s.load('name'));
     await ctx.sync();
     let shape=null;
     if(args.shape_name){shape=slide.shapes.items.find(s=>s.name===args.shape_name)||null;}
     if(!shape&&args.shape_index!==undefined){shape=slide.shapes.items[args.shape_index]||null;}
     if(!shape)throw new Error('ItemNotFound: shape not found');
     shape.delete();
     await ctx.sync();
   });
   return{success:true,data:{deleted:true}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_set_shape_fill',
 description:'Change the fill color, transparency, or gradient of an existing shape.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index',required:true},
   shape_name:{type:'string',description:'Shape name',required:false},
   shape_index:{type:'number',description:'0-based shape index',required:false},
   fill_color:{type:'string',description:'Solid fill hex color e.g. "#e11d48"',required:false},
   transparency:{type:'number',description:'Fill transparency 0.0 (opaque) to 1.0 (fully transparent)',required:false},
   no_fill:{type:'boolean',description:'If true, remove fill (make transparent)',required:false},
 },
 execute:async(args)=>{try{
   await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const slide=slides.items[args.slide_index||0];
     slide.shapes.load('items');
     await ctx.sync();
     slide.shapes.items.forEach(s=>s.load('name'));
     await ctx.sync();
     let shape=null;
     if(args.shape_name){shape=slide.shapes.items.find(s=>s.name===args.shape_name)||null;}
     if(!shape&&args.shape_index!==undefined){shape=slide.shapes.items[args.shape_index]||null;}
     if(!shape)throw new Error('ItemNotFound: shape not found');
     if(args.no_fill){shape.fill.clear();}
     else if(args.fill_color){shape.fill.setSolidColor(args.fill_color.replace('#',''));}
     if(args.transparency!==undefined&&!args.no_fill){shape.fill.transparency=args.transparency;}
     await ctx.sync();
   });
   return{success:true,data:{updated:true}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

// ── 图片操作 ──────────────────────────────────────────────────────────────────
{name:'ppt_add_image',
 description:'Insert an image into a slide from a Base64-encoded string or a public URL. For URLs, the gateway should fetch and encode the image first.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index (default 0)',required:false},
   image_base64:{type:'string',description:'Base64-encoded image data (PNG/JPEG/GIF/BMP). Do NOT include the data:image/... prefix.',required:false},
   image_url:{type:'string',description:'Publicly accessible image URL (http/https). Note: CORS restrictions may apply in Office.',required:false},
   left:{type:'number',description:'Left position in points (default 72)',required:false},
   top:{type:'number',description:'Top position in points (default 72)',required:false},
   width:{type:'number',description:'Width in points (default 288 = 4 inches). Aspect ratio preserved if only one dimension given.',required:false},
   height:{type:'number',description:'Height in points. Omit to auto-calculate from width.',required:false},
 },
 execute:async(args)=>{try{
   if(!args.image_base64&&!args.image_url)return{success:false,error:'Provide image_base64 or image_url'};
   let base64=args.image_base64;
   // If URL provided, try to fetch and convert
   if(!base64&&args.image_url){
     const resp=await fetch(args.image_url);
     if(!resp.ok)throw new Error(`Failed to fetch image: ${resp.status}`);
     const blob=await resp.blob();
     base64=await new Promise((res,rej)=>{
       const reader=new FileReader();
       reader.onload=()=>res(reader.result.toString().split(',')[1]);
       reader.onerror=rej;
       reader.readAsDataURL(blob);
     });
   }
   const shapeName=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     const opts={
       left:args.left||72,
       top:args.top||72,
       width:args.width||288,
     };
     if(args.height)opts.height=args.height;
     const shape=slide.shapes.addImage(base64,opts);
     shape.load('name');
     await ctx.sync();
     return shape.name;
   });
   return{success:true,data:{inserted:true,shapeName}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

// ── 表格操作 ──────────────────────────────────────────────────────────────────
{name:'ppt_add_table',
 description:'Insert a table on a slide with data, header formatting, and colors.',
 parameters:{
   slide_index:{type:'number',description:'0-based slide index (default 0)',required:false},
   rows:{type:'number',description:'Number of rows',required:true},
   columns:{type:'number',description:'Number of columns',required:true},
   values:{type:'array',description:'2D array of cell values, e.g. [["Name","Score"],["Alice","95"],["Bob","88"]]',required:false},
   left:{type:'number',description:'Left position in points (default 72)',required:false},
   top:{type:'number',description:'Top position in points (default 144)',required:false},
   width:{type:'number',description:'Table width in points (default 576)',required:false},
   header_fill_color:{type:'string',description:'Header row fill color hex (default "#1e40af")',required:false},
   header_font_color:{type:'string',description:'Header row text color hex (default "#ffffff")',required:false},
   font_size:{type:'number',description:'Font size for all cells (default 14)',required:false},
 },
 execute:async(args)=>{try{
   const shapeName=await PowerPoint.run(async ctx=>{
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const idx=args.slide_index||0;
     if(idx>=slides.items.length)throw new Error(`ItemNotFound: slide index ${idx}`);
     const slide=slides.items[idx];
     const tableOpts={
       rowCount:args.rows,
       columnCount:args.columns,
       left:args.left||72,
       top:args.top||144,
       width:args.width||576,
     };
     const shape=slide.shapes.addTable(tableOpts.rowCount,tableOpts.columnCount,tableOpts);
     shape.load('name');
     await ctx.sync();
     // Fill cells with values
     if(args.values&&Array.isArray(args.values)){
       const table=shape.table;
       args.values.forEach((row,ri)=>{
         if(ri>=args.rows)return;
         if(Array.isArray(row))row.forEach((cell,ci)=>{
           if(ci>=args.columns)return;
           const tc=table.getCell(ri,ci);
           tc.textFrame.textRange.text=String(cell==null?'':cell);
           if(args.font_size)tc.textFrame.textRange.font.size=args.font_size;
         });
       });
     }
     // Style header row
     if(args.values&&args.values.length>0){
       const table=shape.table;
       const hColor=(args.header_fill_color||'#1e40af').replace('#','');
       const hFontColor=(args.header_font_color||'#ffffff').replace('#','');
       for(let ci=0;ci<args.columns;ci++){
         const cell=table.getCell(0,ci);
         cell.fill.setSolidColor(hColor);
         cell.textFrame.textRange.font.color=hFontColor;
         cell.textFrame.textRange.font.bold=true;
       }
     }
     await ctx.sync();
     return shape.name;
   });
   return{success:true,data:{inserted:true,rows:args.rows,columns:args.columns,shapeName}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

// ── 版式 ──────────────────────────────────────────────────────────────────────
{name:'ppt_set_slide_layout',
 description:'Apply a slide layout (master template) to one or all slides by layout name.',
 parameters:{
   layout_name:{type:'string',description:'Layout name, e.g. "Title Slide", "Title and Content", "Blank", "Two Content", "Comparison", "Section Header"',required:true},
   slide_index:{type:'number',description:'0-based slide index to apply to. Omit to apply to all slides.',required:false},
 },
 execute:async(args)=>{try{
   const applied=await PowerPoint.run(async ctx=>{
     const layouts=ctx.presentation.slideLayouts;
     layouts.load('items');
     await ctx.sync();
     layouts.items.forEach(l=>l.load('name'));
     await ctx.sync();
     const layout=layouts.items.find(l=>l.name.toLowerCase().includes(args.layout_name.toLowerCase()));
     if(!layout)throw new Error(`Layout "${args.layout_name}" not found`);
     const slides=ctx.presentation.slides;
     slides.load('items');
     await ctx.sync();
     const targets=args.slide_index!==undefined?[slides.items[args.slide_index]]:slides.items;
     targets.forEach(slide=>slide.layout=layout);
     await ctx.sync();
     return{layout:layout.name,count:targets.length};
   });
   return{success:true,data:applied};
 }catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'ppt_save',
 description:'Save the current PowerPoint presentation. In Microsoft 365 the file is auto-saved continuously; this call is a best-effort trigger. Returns success even if the save API is unavailable (auto-save handles it).',
 parameters:{},
 execute:async()=>{try{
   let saved=false;
   // Strategy 1: Office document saveAsync
   if(typeof Office!=='undefined'&&Office.context&&Office.context.document&&typeof Office.context.document.saveAsync==='function'){
     await new Promise((res,rej)=>{
       Office.context.document.saveAsync(result=>{
         if(result.status===Office.AsyncResultStatus.Succeeded){saved=true;res();}
         else res(); // non-fatal, try next
       });
     });
   }
   // Strategy 2: PowerPoint.run presentation.save (some builds)
   if(!saved){
     try{
       await PowerPoint.run(async ctx=>{
         if(ctx.presentation&&typeof ctx.presentation.save==='function'){
           ctx.presentation.save();
           await ctx.sync();
           saved=true;
         }
       });
     }catch(e2){/* ignore */}
   }
   // Strategy 3: M365 auto-saves — return success silently
   return{success:true,data:{saved:true,method:saved?'explicit':'auto-save'}};
 }catch(e){return{success:false,error:friendlyError(e)};}}},



];

// ── UI helpers ────────────────────────────────────────────────────────────────
let T=null,client=null,reconnectTimer=null,countdown=0,lastEntry=null;
const $=id=>document.getElementById(id);

function setStatus(state,msg){
  const dot=$('status-dot'),txt=$('status-text');
  if(!dot||!txt)return;
  dot.className='status-dot';
  const map={ready:{cls:'status-ready',label:T.statusReady},connecting:{cls:'status-connecting',label:T.statusConnecting},authenticating:{cls:'status-connecting',label:T.statusAuthenticating},registering:{cls:'status-connecting',label:T.statusRegistering},disconnected:{cls:'status-idle',label:T.statusDisconnected},error:{cls:'status-error',label:T.statusError}};
  const info=map[state]||{cls:'status-idle',label:state};
  dot.classList.add(info.cls);txt.textContent=info.label;
}
function clearCountdown(){if(reconnectTimer){clearInterval(reconnectTimer);reconnectTimer=null;}const h=$('reconnect-hint');if(h)h.style.display='none';}
function addLogEntry(toolName,args,success){
  const box=$('log-box'),hint=$('empty-hint');
  if(hint)hint.style.display='none';
  const meta=(T.ops&&T.ops[toolName])||{icon:'🔧',action:toolName};
  const detail=args.text||(args.slide_index!==undefined?`slide ${args.slide_index}`:(args.layout_name||args.color||''));  
  const time=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const el=document.createElement('div');
  el.className='log-entry'+(success===false?' entry-error':'');
  el.innerHTML=`<span class="log-entry-icon">${success===false?'❌':meta.icon}</span><div class="log-entry-body"><div class="log-entry-action">${meta.action}</div>${detail?`<div class="log-entry-detail">${detail}</div>`:''}</div><span class="log-entry-time">${time}</span>`;
  box.appendChild(el);box.scrollTop=box.scrollHeight;lastEntry=el;
}

async function startClient(){
  if(client){client.disconnect();client=null;}
  clearCountdown();setStatus('connecting');

  let docName=T.unknownDoc;
  try{
    docName=await new Promise(resolve=>{setTimeout(()=>resolve(T.unknownDoc),2000);
      Office.context.document.getFilePropertiesAsync(result=>{
        if(result.status===Office.AsyncResultStatus.Succeeded&&result.value&&result.value.url){
          const url=result.value.url;
          const name=url.split(/[/\\]/).pop().replace(/#.*$/,'').replace(/%[0-9A-Fa-f]{2}/g,c=>decodeURIComponent(c));
          resolve(name||T.unknownDoc);
        }else{resolve(T.unknownDoc);}
      });
    });
  }catch(e){}

  const isUnknown=!docName||docName===T.unknownDoc;
  const pluginId=isUnknown
    ?'ppt-'+(crypto.randomUUID?crypto.randomUUID().slice(0,8):Math.random().toString(36).slice(2,10))
    :'ppt-'+docName;

  client=new OpenFluxPluginClient({gatewayUrl:'ws://localhost:18801',token:'',pluginId,name:T.pluginName(docName),version:'1.0.0',description:T.pluginDesc(docName),icon:'📽️'});
  PPT_TOOLS.forEach(t=>client.registerTool(t));
  client.onStatus(state=>{
    setStatus(state);
    if(state==='ready'){clearCountdown();const rb=$('retry-btn');if(rb)rb.style.display='none';}
    else if(state==='disconnected'){
      clearCountdown();countdown=5;
      const hint=$('reconnect-hint');if(hint)hint.style.display='block';
      const tick=()=>{if(hint)hint.textContent=T.reconnectIn(countdown);if(countdown<=0){clearCountdown();startClient();}else countdown--;};
      tick();reconnectTimer=setInterval(tick,1000);
    }else if(state==='error'){const rb=$('retry-btn');if(rb)rb.style.display='inline-block';}
  });
  client.onToolCall((name,args)=>addLogEntry(name,args,null));
  client.onToolResult((name,args,result)=>{
    if(lastEntry){lastEntry.classList.toggle('entry-error',!result.success);const ic=lastEntry.querySelector('.log-entry-icon');if(ic&&!result.success)ic.textContent='❌';}
    if(!result.success){const box=$('log-box');const el=document.createElement('div');el.className='log-entry entry-error';el.innerHTML=`<span class="log-entry-icon">⚠️</span><div class="log-entry-body"><div class="log-entry-detail" style="color:#fca5a5">${(T.errPrefix||'Error: ')+((result&&result.error)||T.errUnknown)}</div></div>`;box.appendChild(el);box.scrollTop=box.scrollHeight;}
  });
  try{await client.connect();}catch(e){setStatus('error');const rb=$('retry-btn');if(rb)rb.style.display='inline-block';}
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
Office.onReady(({host})=>{
  if(host!==Office.HostType.PowerPoint)return;
  T=translations[detectLang()]||translations.en;
  const txt=$('status-text');if(txt)txt.textContent=T.statusConnecting;
  const rb=$('retry-btn');if(rb){rb.textContent=T.retryBtn;rb.addEventListener('click',()=>{clearCountdown();startClient();});}
  const lt=$('log-title');if(lt)lt.textContent=T.logTitle;
  const cb=$('clear-btn');if(cb){cb.textContent=T.clearBtn;cb.addEventListener('click',()=>{const b=$('log-box');if(b){b.querySelectorAll('.log-entry').forEach(e=>e.remove());const h=$('empty-hint');if(h)h.style.display='flex';}});}
  const eh=$('empty-hint-text');if(eh)eh.innerHTML=T.emptyHint.replace('\n','<br>');
  startClient();
});
})();
