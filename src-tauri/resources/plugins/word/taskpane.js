(function(){'use strict';
// 插件版本水印：改动插件后请更新此值；网关注册日志会打印 vXXX，便于确认 live 版本是否最新
const PLUGIN_VERSION='2026-06-28.1';
// ── i18n ─────────────────────────────────────────────────────────────────────
const translations={
zh:{statusConnecting:'正在连接…',statusAuthenticating:'认证中…',statusRegistering:'注册中…',statusReady:'已连接 OpenFlux',statusDisconnected:'连接断开',statusError:'连接失败',reconnectIn:s=>`${s} 秒后自动重连`,retryBtn:'立即重连',logTitle:'📋 操作记录',clearBtn:'清空',emptyHint:'OpenFlux 对当前文档的操作\n将显示在这里',pluginName:n=>`Word - ${n}`,pluginDesc:n=>`Word 插件，当前文档：${n}`,unknownDoc:'未知文档',errConnect:'无法连接',errUnknown:'未知错误',errPrefix:'错误：',
ops:{word_get_body_text:{icon:'📄',action:'读取文档全文'},word_get_selection:{icon:'📍',action:'读取选中内容'},word_insert_text:{icon:'✏️',action:'插入文本'},word_insert_paragraph:{icon:'¶',action:'插入段落'},word_replace_text:{icon:'🔄',action:'查找替换'},word_apply_style:{icon:'🎨',action:'应用样式'},word_set_font:{icon:'🔤',action:'设置字体'},word_get_paragraphs:{icon:'📋',action:'获取段落列表'},word_get_document_properties:{icon:'ℹ️',action:'获取文档属性'},word_search:{icon:'🔍',action:'搜索文本'},word_delete_selection:{icon:'🗑️',action:'删除选中内容'},word_insert_table:{icon:'📊',action:'插入表格'},word_get_tables:{icon:'📊',action:'获取表格列表'},word_navigate_to:{icon:'🔍',action:'定位内容'},word_list_documents:{icon:'📂',action:'列出已连接文档'}}},
en:{statusConnecting:'Connecting…',statusAuthenticating:'Authenticating…',statusRegistering:'Registering…',statusReady:'Connected to OpenFlux',statusDisconnected:'Disconnected',statusError:'Connection failed',reconnectIn:s=>`Reconnecting in ${s}s`,retryBtn:'Reconnect',logTitle:'📋 Activity Log',clearBtn:'Clear',emptyHint:'OpenFlux operations on this document\nwill appear here',pluginName:n=>`Word - ${n}`,pluginDesc:n=>`Word add-in, document: ${n}`,unknownDoc:'Unknown Document',errConnect:'Unable to connect',errUnknown:'Unknown error',errPrefix:'Error: ',
ops:{word_get_body_text:{icon:'📄',action:'Read body text'},word_get_selection:{icon:'📍',action:'Get selection'},word_insert_text:{icon:'✏️',action:'Insert text'},word_insert_paragraph:{icon:'¶',action:'Insert paragraph'},word_replace_text:{icon:'🔄',action:'Find & replace'},word_apply_style:{icon:'🎨',action:'Apply style'},word_set_font:{icon:'🔤',action:'Set font'},word_get_paragraphs:{icon:'📋',action:'Get paragraphs'},word_get_document_properties:{icon:'ℹ️',action:'Get document properties'},word_search:{icon:'🔍',action:'Search text'},word_delete_selection:{icon:'🗑️',action:'Delete selection'},word_insert_table:{icon:'📊',action:'Insert table'},word_get_tables:{icon:'📊',action:'Get tables'},word_navigate_to:{icon:'🔍',action:'Navigate to'},word_list_documents:{icon:'📂',action:'List connected documents'}}}
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
    this.ws.onclose=()=>{clearTimeout(this._cwd);this._stopHeartbeat();this._ready=false;this._setStatus('disconnected');if(!this.destroyed)this._rt=setTimeout(()=>this.connect().catch(()=>{}),5000);};
    this.ws.onerror=e=>{this._setStatus('error','WebSocket error');rej(e);};
  });}
  disconnect(){this.destroyed=true;clearTimeout(this._rt);this._stopHeartbeat();if(this.ws){this.ws.close();this.ws=null;}}
  _startHeartbeat(){this._stopHeartbeat();this._lastPong=Date.now();this._hb=setInterval(()=>{
    if(!this.ws||this.ws.readyState!==WebSocket.OPEN){return;}
    if(Date.now()-this._lastPong>45000){try{this.ws.close();}catch(e){}return;}
    this._send({type:'ping',id:this._uid()});
  },20000);}
  _stopHeartbeat(){if(this._hb){clearInterval(this._hb);this._hb=null;}}
  _handle(msg,res,rej){const{type,id,payload:p}=msg;
    if(type==='welcome'){if(p&&p.requireAuth&&this.cfg.token){this._send({type:'auth',id:this._uid(),payload:{token:this.cfg.token}});}else{this._setStatus('registering');this._register();}}
    else if(type==='auth.success'){this._setStatus('registering');this._register();}
    else if(type==='auth.error'){this._setStatus('error','Auth failed');rej(new Error('Auth failed'));}
    else if(type==='plugin.register.ack'){if(p&&p.success){this._ready=true;clearTimeout(this._cwd);this._setStatus('ready');this._startHeartbeat();res();}else{this._setStatus('error',p&&p.error);rej(new Error(p&&p.error));}}
    else if(type==='pong'){this._lastPong=Date.now();}
    else if(type==='mcp.client.call'&&id){this._callTool(id,p);}
  }
  async _callTool(id,p){const{tool,args={}}=p;const t=this.tools.get(tool);if(this._onCall)this._onCall(tool,args);
    if(!t){const r={success:false,error:`Tool "${tool}" not found`};if(this._onResult)this._onResult(tool,args,r);this._send({type:'mcp.client.result',id,payload:r});return;}
    try{const r=await t.execute(args);if(this._onResult)this._onResult(tool,args,r);this._send({type:'mcp.client.result',id,payload:{success:r.success,result:r}});}
    catch(e){const r={success:false,error:String(e)};if(this._onResult)this._onResult(tool,args,r);this._send({type:'mcp.client.result',id,payload:r});}
  }
  _register(){const tools=Array.from(this.tools.values()).map(t=>({name:t.name,description:t.description,parameters:t.parameters}));
    this._send({type:'plugin.register',id:this._uid(),payload:{pluginId:this.cfg.pluginId,name:this.cfg.name,version:this.cfg.version,description:this.cfg.description||'',icon:this.cfg.icon||'🔌',tools,capabilities:['tools'],metadata:{platform:'office-addin',officeHost:'Word'}}});}
  _send(obj){if(this.ws&&this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(obj));}
  _setStatus(s,m){this.status=s;if(this._onStatus)this._onStatus(s,m);}
  _uid(){return crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2);}
}

// ── Search string sanitizer ──────────────────────────────────────────────────
// Word body.search() rejects: newlines, tabs, wildcard chars (*, ?, [, ], \),
// and strings longer than ~255 bytes. Sanitize before every search call.
function sanitizeQuery(raw, maxLen=100){
  return String(raw)
    .replace(/[\r\n\t]+/g,' ')   // Line break/Tab -> space
    .replace(/[*?\[\]\\]/g,'')   // Remove Word wildcard characters
    .replace(/  +/g,' ')          // Merge consecutive spaces
    .trim()
    .slice(0, maxLen);
}

// ── InsertLocation 适配 ───────────────────────────────────────────────────────
// Office.js 限制：Range(选区) 的 insertParagraph/insertTable 只接受 Before/After；
// 文档首尾(Start/End) 必须走 Body。否则抛 InvalidArgument。
function insertParagraphAt(ctx, text, loc){
  const l = loc || 'End';
  if(l==='Before'||l==='After'){
    return ctx.document.getSelection().insertParagraph(text, l);
  }
  return ctx.document.body.insertParagraph(text, l==='Start'?'Start':'End');
}
function insertTableAt(ctx, rows, cols, loc){
  const l = loc || 'End';
  if(l==='Before'||l==='After'){
    return ctx.document.getSelection().insertTable(rows, cols, l);
  }
  // Replace/Start/End/未指定 -> 走 Body（Range 不支持这些位置）
  return ctx.document.body.insertTable(rows, cols, l==='Start'?'Start':'End');
}

// ── 样式适配 ──────────────────────────────────────────────────────────────────
// 内置样式优先用 styleBuiltIn（locale 无关），避免中文 Word 下英文样式名报 InvalidArgument；
// 自定义样式回退到 style 字符串。
const BUILTIN_STYLE_MAP={
  'normal':'normal','正文':'normal',
  'heading 1':'heading1','heading1':'heading1','标题 1':'heading1','标题1':'heading1',
  'heading 2':'heading2','heading2':'heading2','标题 2':'heading2','标题2':'heading2',
  'heading 3':'heading3','heading3':'heading3','标题 3':'heading3','标题3':'heading3',
  'heading 4':'heading4','标题 4':'heading4','heading 5':'heading5','标题 5':'heading5',
  'heading 6':'heading6','标题 6':'heading6',
  'title':'title','标题':'title','subtitle':'subtitle','副标题':'subtitle',
  'quote':'quote','引用':'quote','intense quote':'intenseQuote',
  'list paragraph':'listParagraph','列表段落':'listParagraph'
};
function applyStyleSafe(obj, styleName){
  if(!styleName)return;
  const key=String(styleName).trim().toLowerCase();
  const builtIn=BUILTIN_STYLE_MAP[key];
  if(builtIn && typeof Word!=='undefined' && Word.BuiltInStyleName && Word.BuiltInStyleName[builtIn]){
    obj.styleBuiltIn=Word.BuiltInStyleName[builtIn];
  } else {
    obj.style=styleName;
  }
}

// ── Error message humanization ───────────────────────────────────────────────────────────
function friendlyError(e){
  const s=String(e);
  if(s.includes('AccessDenied'))return '⚠️ 文档受保护或处于只读模式，请在 Word 中点击「启用编辑」后重试';
  if(s.includes('GeneralException'))return '⚠️ 操作失败，文档可能处于只读模式，请在 Word 中点击「启用编辑」后重试';
  if(s.includes('getCommentedRanges')||s.includes('getComments is not a function')||(s.includes('getComments')&&s.includes('not a function')))return '⚠️ 当前 Word 版本不支持批注查询，需要 Microsoft 365 最新版';
  if(s.includes('SearchStringInvalidOrTooLong'))return '⚠️ 搜索词过长或含非法字符，请缩短后重试（建议不超过 50 字符）';
  if(s.includes('InvalidArgument'))return '⚠️ 参数无效：请检查插入位置(insert_location)、样式名或搜索词是否受支持';
  if(s.includes('ItemNotFound')||s.includes('Text not found'))return s.replace('Error: ','');
  if(s.includes('WordNotRunning'))return '⚠️ Word 未运行，请先打开 Word 文档';
  return s;
}

// Resolve image input to raw base64 (no "data:" prefix). Supports data URL / raw base64 / http(s) URL (fetched).
async function resolveImageBase64(input){
  if(!input)throw new Error('image is required');
  const s=String(input).trim();
  if(s.startsWith('data:')){return s.slice(s.indexOf(',')+1);}
  if(/^https?:\/\//i.test(s)){
    const resp=await fetch(s);if(!resp.ok)throw new Error('Failed to fetch image URL: HTTP '+resp.status);
    const blob=await resp.blob();
    return await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>{const r=String(fr.result);res(r.slice(r.indexOf(',')+1));};fr.onerror=rej;fr.readAsDataURL(blob);});
  }
  if(/^[A-Za-z]:[\\/]|^\//.test(s)||s.startsWith('\\\\'))throw new Error('Local file paths cannot be read inside an Office add-in. Pass base64, a data URL, or an http(s) URL.');
  return s; // assume raw base64
}

// ── Word Tools ────────────────────────────────────────────────────────────────
const WORD_TOOLS=[
{name:'word_get_body_text',description:'Get the full text content of the Word document body.',parameters:{},
 execute:async()=>{try{const text=await Word.run(async ctx=>{const body=ctx.document.body;body.load('text');await ctx.sync();return body.text;});return{success:true,data:{text,charCount:text.length}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_get_selection',description:'Get the currently selected text and its position in the document.',parameters:{},
 execute:async()=>{try{const data=await Word.run(async ctx=>{const sel=ctx.document.getSelection();sel.load(['text','style']);await ctx.sync();return{text:sel.text,style:sel.style,charCount:sel.text.length};});return{success:true,data};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_insert_text',description:'Insert text at the cursor position or replace the current selection.',parameters:{text:{type:'string',description:'Text to insert',required:true},insert_location:{type:'string',description:'"Replace" (replace selection, default), "Before", "After", "Start" (doc start), "End" (doc end)',required:false}},
 execute:async(args)=>{try{await Word.run(async ctx=>{const loc=args.insert_location||'Replace';const sel=ctx.document.getSelection();sel.insertText(args.text,loc);await ctx.sync();});return{success:true,data:{inserted:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_insert_paragraph',description:'Insert a new paragraph with optional text and style.',parameters:{text:{type:'string',description:'Paragraph text',required:false},style:{type:'string',description:'Paragraph style e.g. "Normal","Heading 1","Heading 2","List Paragraph"',required:false},insert_location:{type:'string',description:'"End" (default), "Start", "Before", "After" relative to selection',required:false}},
 execute:async(args)=>{try{await Word.run(async ctx=>{const para=insertParagraphAt(ctx,args.text||'',args.insert_location);if(args.style)applyStyleSafe(para,args.style);await ctx.sync();});return{success:true,data:{inserted:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_replace_text',description:'Find and replace all occurrences of text in the document.',parameters:{find:{type:'string',description:'Text to find',required:true},replace:{type:'string',description:'Replacement text',required:true},match_case:{type:'boolean',description:'Case sensitive search (default false)',required:false},match_whole_word:{type:'boolean',description:'Match whole word only (default false)',required:false}},
 execute:async(args)=>{try{const find=sanitizeQuery(args.find);if(!find)return{success:false,error:'find is empty after sanitization'};const count=await Word.run(async ctx=>{const results=ctx.document.body.search(find,{matchCase:args.match_case||false,matchWholeWord:args.match_whole_word||false});results.load('items');await ctx.sync();results.items.forEach(r=>r.insertText(args.replace==null?'':String(args.replace),'Replace'));await ctx.sync();return results.items.length;});return{success:true,data:{replacedCount:count,queryUsed:find}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_apply_style',description:'Apply a paragraph style to the current selection.',parameters:{style:{type:'string',description:'Style name e.g. "Normal","Heading 1","Heading 2","Heading 3","List Paragraph","Quote"',required:true}},
 execute:async(args)=>{try{await Word.run(async ctx=>{const sel=ctx.document.getSelection();applyStyleSafe(sel,args.style);await ctx.sync();});return{success:true,data:{applied:args.style}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_set_font',description:'Set font properties for the current selection.',parameters:{bold:{type:'boolean',description:'Bold',required:false},italic:{type:'boolean',description:'Italic',required:false},underline:{type:'string',description:'"Single","Double","None" etc.',required:false},size:{type:'number',description:'Font size in points',required:false},color:{type:'string',description:'Font color hex e.g. "#FF0000"',required:false},name:{type:'string',description:'Font name e.g. "Arial","Times New Roman"',required:false}},
 execute:async(args)=>{try{await Word.run(async ctx=>{const sel=ctx.document.getSelection();const f=sel.font;if(args.bold!==undefined)f.bold=args.bold;if(args.italic!==undefined)f.italic=args.italic;if(args.size!==undefined)f.size=args.size;if(args.color!==undefined)f.color=args.color;if(args.name!==undefined)f.name=args.name;if(args.underline!==undefined)f.underline=args.underline;await ctx.sync();});return{success:true,data:{applied:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_get_paragraphs',description:'Get a list of all paragraphs in the document with their text and styles.',parameters:{max:{type:'number',description:'Maximum number of paragraphs to return (default 100)',required:false}},
 execute:async(args)=>{try{const paras=await Word.run(async ctx=>{const ps=ctx.document.body.paragraphs;ps.load('items');await ctx.sync();ps.items.forEach(p=>p.load(['text','style']));await ctx.sync();const limit=args.max||100;return ps.items.slice(0,limit).map(p=>({text:p.text.trim(),style:p.style}));});return{success:true,data:{paragraphs:paras,count:paras.length}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_get_document_properties',description:'Get document properties: title, author, word count, character count, paragraph count.',parameters:{},
 execute:async()=>{try{const props=await Word.run(async ctx=>{const doc=ctx.document;const body=doc.body;body.load(['text']);const ps=body.paragraphs;ps.load('items');await ctx.sync();const text=body.text;const wordCount=text.trim().split(/\s+/).filter(w=>w.length>0).length;return{wordCount,charCount:text.length,paragraphCount:ps.items.length};});return{success:true,data:props};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_search',description:'Search for text in the document. ⚠️ query must be a SHORT phrase (max 100 chars, key words only — do NOT pass full sentences or paragraphs).',parameters:{query:{type:'string',description:'Short search phrase, max 100 characters',required:true},match_case:{type:'boolean',description:'Case sensitive (default false)',required:false},match_whole_word:{type:'boolean',description:'Match whole word (default false)',required:false}},
 execute:async(args)=>{try{const q=sanitizeQuery(args.query);if(!q)return{success:false,error:'query is empty after sanitization'};const results=await Word.run(async ctx=>{const rs=ctx.document.body.search(q,{matchCase:args.match_case||false,matchWholeWord:args.match_whole_word||false});rs.load('items');await ctx.sync();rs.items.forEach(r=>r.load('text'));await ctx.sync();return rs.items.map(r=>r.text);});return{success:true,data:{matches:results,count:results.length,queryUsed:q}};}catch(e){return{success:false,error:friendlyError(e)};}}} ,

{name:'word_delete_selection',description:'Delete the currently selected content.',parameters:{},
 execute:async()=>{try{await Word.run(async ctx=>{ctx.document.getSelection().delete();await ctx.sync();});return{success:true,data:{deleted:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_insert_table',description:'Insert a table at the cursor position.',parameters:{rows:{type:'number',description:'Number of rows',required:true},columns:{type:'number',description:'Number of columns',required:true},values:{type:'array',description:'2D array of cell values e.g. [["Name","Age"],["Alice",30]]',required:false},insert_location:{type:'string',description:'"Before","After","Replace" (default "Replace")',required:false}},
 execute:async(args)=>{try{await Word.run(async ctx=>{const table=insertTableAt(ctx,args.rows,args.columns,args.insert_location);if(args.values&&Array.isArray(args.values)){args.values.forEach((row,ri)=>{if(Array.isArray(row)){row.forEach((cell,ci)=>{if(ri<args.rows&&ci<args.columns)table.getCell(ri,ci).value=String(cell==null?'':cell);});}});}await ctx.sync();});return{success:true,data:{inserted:true,rows:args.rows,columns:args.columns}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_get_tables',description:'Get information about all tables in the document.',parameters:{},
 execute:async()=>{try{const tables=await Word.run(async ctx=>{const ts=ctx.document.body.tables;ts.load('items');await ctx.sync();ts.items.forEach(t=>t.load(['rowCount','columnCount']));await ctx.sync();return ts.items.map((t,i)=>({index:i,rows:t.rowCount,columns:t.columnCount}));});return{success:true,data:{tables,count:tables.length}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_navigate_to',description:'Search for text and scroll to its first occurrence. ⚠️ text must be a SHORT unique phrase (max 100 chars).',parameters:{text:{type:'string',description:'Short unique phrase to find and navigate to, max 100 characters',required:true},match_case:{type:'boolean',description:'Case sensitive (default false)',required:false},document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async(args)=>{try{const q=sanitizeQuery(args.text);if(!q)return{success:false,error:'text is empty after sanitization'};await Word.run(async ctx=>{const rs=ctx.document.body.search(q,{matchCase:args.match_case||false});rs.load('items');await ctx.sync();if(rs.items.length>0){rs.items[0].select();}await ctx.sync();return rs.items.length;});return{success:true,data:{found:true,queryUsed:q}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_list_documents',description:'List all currently connected Word documents (open Word windows with the add-in active). Returns document names and count.',parameters:{},
 execute:async()=>{try{const docName=await Word.run(async ctx=>{ctx.document.load('url');await ctx.sync();const url=ctx.document.url;return url?url.split(/[/\\]/).pop():'Unknown Document';});return{success:true,data:{documents:[docName],count:1,note:'This is the current document only. Gateway aggregates all connected documents.'}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_save',description:'Save the current Word document silently (no dialog). Preserves the original file path.',parameters:{document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async()=>{try{await Word.run(async ctx=>{ctx.document.save();await ctx.sync();});return{success:true,data:{saved:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_save_as',description:'Save the current Word document to a new path without any dialog (handled by Gateway via PowerShell COM). Supports any local or UNC path.',parameters:{target_path:{type:'string',description:'Full destination file path, e.g. C:\\backup\\report.docx',required:true},document_name:{type:'string',description:'Source document name (optional, routes to the correct window in multi-doc mode)',required:false}},
 execute:async(args)=>{return{success:false,error:'word_save_as is handled by the Gateway (PowerShell COM). This fallback should not be called directly.'};} },

// ── Comment tools (Word JS API 1.4+) ─────────────────────────────────────────

{name:'word_add_comment',description:'Add a comment to the current selection, or search for specific text first and comment on it. ⚠️ search_text must be a SHORT unique phrase (max 50 chars). The comment parameter must NOT contain newlines.',
 parameters:{comment:{type:'string',description:'The comment content to add (single line, no newlines)',required:true},search_text:{type:'string',description:'SHORT unique phrase (max 50 chars) to locate the text to annotate. Do NOT pass full sentences.',required:false},document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async(args)=>{try{
  const safeSearch=args.search_text?sanitizeQuery(args.search_text,50):null;
  // Compatible with LLM, three parameter names of comment / text / content may be used
  const rawComment=args.comment||args.text||args.content||'';
  if(!rawComment)return{success:false,error:'comment parameter is required'};
  await Word.run(async ctx=>{let range;
   if(safeSearch){const rs=ctx.document.body.search(safeSearch,{matchCase:false,matchWholeWord:false});rs.load('items');await ctx.sync();if(rs.items.length===0)throw new Error(`Text not found: "${safeSearch}"`);range=rs.items[0];}else{range=ctx.document.getSelection();}
   const safeComment=String(rawComment).replace(/[\r\n]+/g,' ').trim();
   range.insertComment(safeComment);
   range.select();
   await ctx.sync();});return{success:true,data:{added:true,searchText:safeSearch||null}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_get_comments',description:'Get all comments in the document with author, content, creation date, resolved status, and any replies.',
 parameters:{include_resolved:{type:'boolean',description:'Include already-resolved comments (default true)',required:false},document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async(args)=>{try{const comments=await Word.run(async ctx=>{const cc=ctx.document.body.getComments();cc.load('items');await ctx.sync();const metas=cc.items.map(cm=>{const rng=cm.getRange();rng.load('text');cm.load(['authorName','content','creationDate','resolved','id']);cm.replies.load('items');return{cm,rng};});await ctx.sync();metas.forEach(m=>m.cm.replies.items.forEach(r=>r.load(['authorName','content','creationDate'])));await ctx.sync();const includeResolved=args.include_resolved!==false;const result=[];for(const{cm,rng}of metas){if(!includeResolved&&cm.resolved)continue;result.push({text:(rng.text||'').slice(0,100),author:cm.authorName,content:cm.content,date:cm.creationDate,resolved:cm.resolved,replies:cm.replies.items.map(r=>({author:r.authorName,content:r.content,date:r.creationDate}))});}return result;});return{success:true,data:{comments,count:comments.length}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_resolve_comments',description:'Mark comments as resolved. Can resolve all comments, or only comments whose content matches a keyword.',
 parameters:{all:{type:'boolean',description:'If true, resolve all comments. If false, use keyword to filter.',required:false},keyword:{type:'string',description:'Resolve only comments containing this keyword in their content',required:false},document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async(args)=>{try{const count=await Word.run(async ctx=>{const cc=ctx.document.body.getComments();cc.load('items');await ctx.sync();cc.items.forEach(cm=>cm.load(['content','resolved']));await ctx.sync();let resolved=0;for(const cm of cc.items){if(cm.resolved)continue;if(args.all||(args.keyword&&cm.content.includes(args.keyword))||(!args.keyword&&!args.all)){cm.resolved=true;resolved++;}}await ctx.sync();return resolved;});return{success:true,data:{resolved:count}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_delete_comments',description:'Delete comments from the document. Can delete all comments, only resolved comments, or comments matching a keyword.',
 parameters:{all:{type:'boolean',description:'If true, delete ALL comments regardless of state',required:false},resolved_only:{type:'boolean',description:'If true, delete only resolved comments',required:false},keyword:{type:'string',description:'Delete only comments whose content contains this keyword (case-insensitive)',required:false},document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async(args)=>{try{const count=await Word.run(async ctx=>{const cc=ctx.document.body.getComments();cc.load('items');await ctx.sync();cc.items.forEach(cm=>cm.load(['content','resolved']));await ctx.sync();let deleted=0;for(const cm of cc.items){const matchKeyword=!args.keyword||cm.content.toLowerCase().includes(args.keyword.toLowerCase());const matchResolved=!args.resolved_only||cm.resolved;if(args.all||(matchKeyword&&matchResolved)){cm.delete();deleted++;}}await ctx.sync();return deleted;});return{success:true,data:{deleted:count}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_reply_comment',description:'Reply to an existing comment. Finds the comment by matching its content text, then appends a reply.',
 parameters:{match_text:{type:'string',description:'Partial text of the comment to reply to (case-insensitive match)',required:true},reply_text:{type:'string',description:'Reply content',required:true},document_name:{type:'string',description:'Target document name (optional, for multi-document routing)',required:false}},
 execute:async(args)=>{try{const matchText=String(args.match_text??args.matchText??args.keyword??args.text??'').trim();const replyTextRaw=args.reply_text??args.replyText??args.reply??args.content;if(!matchText)return{success:false,error:'match_text is required (partial text of the comment to reply to)'};if(replyTextRaw===undefined||replyTextRaw===null||String(replyTextRaw)==='')return{success:false,error:'reply_text is required'};const ml=matchText.toLowerCase();await Word.run(async ctx=>{const cc=ctx.document.body.getComments();cc.load('items');await ctx.sync();cc.items.forEach(cm=>cm.load(['content']));await ctx.sync();let replied=false;for(const cm of cc.items){if((cm.content||'').toLowerCase().includes(ml)){const safeReply=String(replyTextRaw).replace(/[\r\n]+/g,' ').trim();cm.reply(safeReply);await ctx.sync();replied=true;break;}}if(!replied)throw new Error(`No comment found matching: "${matchText}"`);});return{success:true,data:{replied:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

// ── Media / structure tools ───────────────────────────────────────────────────

{name:'word_insert_picture',description:'Insert an image at the cursor position or replace the current selection. Accepts a base64 string, data URL, or http(s) URL (local file paths are NOT supported inside an add-in).',parameters:{image:{type:'string',description:'Image as raw base64, data URL (data:image/png;base64,...), or http(s) URL',required:true},width:{type:'number',description:'Optional display width in points',required:false},insert_location:{type:'string',description:'"Replace"(default),"Before","After","Start","End"',required:false}},
 execute:async(args)=>{try{const b64=await resolveImageBase64(args.image??args.image_base64??args.imageBase64??args.base64??args.url??args.image_url??args.data);await Word.run(async ctx=>{const loc=args.insert_location||args.insertLocation||'Replace';const sel=ctx.document.getSelection();const pic=sel.insertInlinePictureFromBase64(b64,loc);if(args.width)pic.width=args.width;await ctx.sync();});return{success:true,data:{inserted:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_insert_hyperlink',description:'Insert a hyperlink. Replaces the current selection with linked text (or inserts new linked text).',parameters:{url:{type:'string',description:'Target URL, e.g. https://example.com',required:true},text:{type:'string',description:'Display text (defaults to the URL)',required:false}},
 execute:async(args)=>{try{await Word.run(async ctx=>{const sel=ctx.document.getSelection();const range=sel.insertText(args.text||args.url,'Replace');range.hyperlink=args.url;await ctx.sync();});return{success:true,data:{inserted:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_insert_list',description:'Insert a bulleted or numbered list from an array of items.',parameters:{items:{type:'array',description:'Array of strings, one per list item',required:true},ordered:{type:'boolean',description:'true = numbered list, false = bulleted list (default)',required:false},insert_location:{type:'string',description:'"End"(default),"Start","Before","After" relative to selection',required:false}},
 execute:async(args)=>{try{const items=Array.isArray(args.items)?args.items:[];if(!items.length)return{success:false,error:'items must be a non-empty array'};await Word.run(async ctx=>{const first=insertParagraphAt(ctx,String(items[0]),args.insert_location);const list=first.startNewList();await ctx.sync();for(let i=1;i<items.length;i++){list.insertParagraph(String(items[i]),'End');}await ctx.sync();if(args.ordered){list.setLevelNumbering(0,Word.ListNumbering.arabic);}else{list.setLevelBullet(0,Word.ListBullet.solid);}await ctx.sync();});return{success:true,data:{inserted:items.length,ordered:!!args.ordered}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_insert_page_break',description:'Insert a page break at the cursor position.',parameters:{},
 execute:async()=>{try{await Word.run(async ctx=>{ctx.document.getSelection().insertBreak(Word.BreakType.page,'After');await ctx.sync();});return{success:true,data:{inserted:true}};}catch(e){return{success:false,error:friendlyError(e)};}}},

{name:'word_batch',description:'Execute multiple Word tools in sequence within ONE call to cut down LLM round-trips. Pass operations as an array of {tool, args}. Stops on first failure unless continue_on_error is true.',parameters:{operations:{type:'array',description:'Array of {tool:string, args:object}. tool must be a word_* tool name (word_batch itself is not allowed).',required:true},continue_on_error:{type:'boolean',description:'Continue running remaining operations after a failure (default false)',required:false}},
 execute:async(args)=>{const ops=Array.isArray(args.operations)?args.operations:[];if(!ops.length)return{success:false,error:'operations must be a non-empty array'};const map=new Map(WORD_TOOLS.map(t=>[t.name,t]));const resolveTool=(raw)=>{if(!raw)return undefined;const cand=new Set();cand.add(raw);const snake=String(raw).replace(/([A-Z])/g,'_$1').toLowerCase().replace(/^_/,'');cand.add(snake);for(const x of [raw,snake])cand.add(x.startsWith('word_')?x:'word_'+x);for(const x of cand){const d=map.get(x);if(d)return d;}return undefined;};const results=[];for(let i=0;i<ops.length;i++){const op=ops[i]||{};const tool=op.tool;const def=resolveTool(tool);if(!tool||!def||def.name==='word_batch'){const er=`Unknown or disallowed tool: ${tool}`;results.push({index:i,tool,success:false,error:er});if(!args.continue_on_error)return{success:false,error:er,data:{results}};continue;}let r;try{r=await def.execute(op.args||{});}catch(e){r={success:false,error:friendlyError(e)};}results.push({index:i,tool,success:r&&r.success!==false,data:r&&r.data,error:r&&r.error});if(r&&r.success===false&&!args.continue_on_error)return{success:false,error:`Operation ${i} (${tool}) failed: ${r.error}`,data:{results}};}return{success:true,data:{results,count:results.length}};}}
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
  const detail=args.range||args.text||args.find||args.query||args.style||'';
  const time=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const el=document.createElement('div');
  el.className='log-entry'+(success===false?' entry-error':'');
  el.innerHTML=`<span class="log-entry-icon">${success===false?'❌':meta.icon}</span><div class="log-entry-body"><div class="log-entry-action">${meta.action}</div>${detail?`<div class="log-entry-detail">${detail}</div>`:''}</div><span class="log-entry-time">${time}</span>`;
  box.appendChild(el);box.scrollTop=box.scrollHeight;lastEntry=el;
}

async function startClient(){
  if(client){client.disconnect();client=null;}
  clearCountdown();setStatus('connecting');

  // Get the document name: Office.context.document.getFilePropertiesAsync is official and exclusive API
  let docName = T.unknownDoc;

  // Method 1: getFilePropertiesAsync (most reliable, supports local/UNC/network path)
  try {
    docName = await new Promise((resolve) => {setTimeout(() => resolve(T.unknownDoc), 2000);
      Office.context.document.getFilePropertiesAsync(result => {
        if (result.status === Office.AsyncResultStatus.Succeeded && result.value && result.value.url) {
          const url = result.value.url;
          const name = url.split(/[/\\]/).pop().replace(/#.*$/, '').replace(/%[0-9A-Fa-f]{2}/g, c => decodeURIComponent(c));
          resolve(name || T.unknownDoc);
        } else {
          resolve(T.unknownDoc);
        }
      });
    });
  } catch(e) {}

  // Method 2: Word.run fallback (take document.url or properties.title)
  if (!docName || docName === T.unknownDoc) {
    try {
      docName = await Word.run(async ctx => {
        ctx.document.properties.load('title');
        ctx.document.load('url');
        await ctx.sync();
        const url = ctx.document.url;
        const title = ctx.document.properties.title;
        if (url) return url.split(/[/\\]/).pop().replace(/#.*$/, '') || T.unknownDoc;
        if (title && title.trim()) return title.trim();
        return T.unknownDoc;
      });
    } catch(e) {}
  }

  // pluginId uniqueness: if the document name is unknown, use a random suffix
  const isUnknown = !docName || docName === T.unknownDoc;
  const pluginId = isUnknown
    ? 'word-' + (crypto.randomUUID ? crypto.randomUUID().slice(0,8) : Math.random().toString(36).slice(2,10))
    : 'word-' + docName;

  client=new OpenFluxPluginClient({gatewayUrl:'wss://localhost:18803/ws',token:'',pluginId,name:T.pluginName(docName),version:PLUGIN_VERSION,description:T.pluginDesc(docName),icon:'📝'});

  WORD_TOOLS.forEach(t=>client.registerTool(t));
  client.onStatus((state)=>{
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
  client.onToolResult((name,args,result)=>{if(lastEntry){lastEntry.classList.toggle('entry-error',!result.success);const ic=lastEntry.querySelector('.log-entry-icon');if(ic&&!result.success)ic.textContent='❌';}if(!result.success){const box=$('log-box');const el=document.createElement('div');el.className='log-entry entry-error';el.innerHTML=`<span class="log-entry-icon">⚠️</span><div class="log-entry-body"><div class="log-entry-detail" style="color:#fca5a5">${(T.errPrefix||'Error: ')+((result&&result.error)||T.errUnknown)}</div></div>`;box.appendChild(el);box.scrollTop=box.scrollHeight;}});
  try{await client.connect();}catch(e){setStatus('error');const rb=$('retry-btn');if(rb)rb.style.display='inline-block';}
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
Office.onReady(({host})=>{
  if(host!==Office.HostType.Word)return;
  T=translations[detectLang()]||translations.en;
  const txt=$('status-text');if(txt)txt.textContent=T.statusConnecting;
  const rb=$('retry-btn');if(rb){rb.textContent=T.retryBtn;rb.addEventListener('click',()=>{clearCountdown();startClient();});}
  const lt=$('log-title');if(lt)lt.textContent=T.logTitle;
  const cb=$('clear-btn');if(cb){cb.textContent=T.clearBtn;cb.addEventListener('click',()=>{const b=$('log-box');if(b){b.querySelectorAll('.log-entry').forEach(e=>e.remove());const h=$('empty-hint');if(h)h.style.display='flex';}});}
  const eh=$('empty-hint-text');if(eh)eh.innerHTML=T.emptyHint.replace('\n','<br>');
  startClient();
});
})();
