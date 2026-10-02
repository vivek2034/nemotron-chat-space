const $ = id => document.getElementById(id);
const DEFAULT_PROMPT = "You are Nemotron 3 Ultra, a helpful, harmless, and honest AI assistant created by NVIDIA. Reason step-by-step when appropriate.";
const state = { sessions: [], currentId: null, settings: { theme:"dark", temperature:.6, top_p:.95, max_tokens:8192, system_prompt:DEFAULT_PROMPT, auto_scroll:true, reduced_motion:false, enable_thinking:true }, model:"nvidia/nemotron-3-ultra-550b-a55b", generating:false, aborter:null, sortNewest:true };
const uid = () => Math.random().toString(36).slice(2,8) + Date.now().toString(36);
const current = () => state.sessions.find(s => s.id === state.currentId);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(message){ const t=$('toast'); t.textContent=message; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2600); }

function formatApiError(data) {
    if (!data) return 'Unknown API error';

    if (typeof data === 'string') return data;

    if (data.error) {
        if (typeof data.error === 'string') return data.error;
        if (data.error.message) return data.error.message;
    }

    if (data.message) return data.message;

    try {
        return JSON.stringify(data);
    } catch {
        return 'Unknown API error';
    }
}
function saveLocalState(){ return fetch('/api/store',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessions:state.sessions,settings:state.settings})}).then(r=>{if(!r.ok)throw new Error('Could not save workspace');}); }
function titleFrom(text){return text.trim().replace(/\s+/g,' ').slice(0,42)||'New conversation';}
function tokenEstimate(){const s=current();const text=(s?.messages||[]).map(m=>m.content||'').join(' ');return Math.max(0,Math.ceil(text.length/4));}
function renderHistory(){
 const q=$('historySearch').value.toLowerCase(); const list=$('historyList'); list.innerHTML='';
 const sessions=[...state.sessions].sort((a,b)=>state.sortNewest?b.updated-a.updated:a.updated-b.updated).filter(s=>s.title.toLowerCase().includes(q));
 if(!sessions.length){list.innerHTML='<div class="muted" style="font-size:10px;padding:12px">No conversations yet</div>';return;}
 sessions.forEach(s=>{const b=document.createElement('button');b.className='history-item'+(s.id===state.currentId?' selected':'');b.innerHTML=`<b>${esc(s.title)}</b><small>${new Date(s.updated).toLocaleDateString([], {month:'short',day:'numeric'})} · ${s.messages.length} messages</small><span class="delete-session" title="Delete conversation">×</span>`;b.onclick=e=>{if(e.target.classList.contains('delete-session')){e.stopPropagation();deleteSession(s.id);}else switchSession(s.id);};list.appendChild(b);});
}
function renderMessages(){
 const s=current(); const box=$('messages');box.innerHTML='';
 $('welcome').classList.toggle('hidden',!!(s?.messages?.length));
 if(!s)return;
 s.messages.forEach((m,i)=>box.appendChild(messageElement(m,i)));
 $('crumbTitle').textContent=s.title;$('tokenCount').textContent=`≈ ${tokenEstimate().toLocaleString()} tokens`;
 if(state.settings.auto_scroll)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;
}
function markdown(text){
 if(!window.marked)return esc(text).replace(/\n/g,'<br>');
 marked.setOptions({breaks:true,gfm:true,headerIds:false,mangle:false});
 return marked.parse(text||'');
}
function messageElement(m,index){
 const wrap=document.createElement('article');wrap.className='message '+(m.role==='user'?'user':'assistant');wrap.dataset.index=index;
 const isUser=m.role==='user';
 wrap.innerHTML=`<div class="message-avatar">${isUser?'V':'N'}</div><div class="message-body"><div class="message-meta"><b>${isUser?'You':'Nemotron 3 Ultra'}</b><span>${new Date(m.timestamp||Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div>${m.reasoning?`<details class="reasoning"><summary>Reasoning process</summary><div class="reasoning-body">${esc(m.reasoning)}</div></details>`:''}<div class="message-content">${m.content?markdown(m.content):'<div class="typing"><span></span><span></span><span></span></div>'}</div>${!isUser?`<div class="message-actions"><button data-action="copy">Copy</button><button data-action="regenerate">Regenerate</button><button data-action="delete">Delete</button></div>`:''}</div>`;
 wrap.querySelectorAll('pre code').forEach(el=>window.hljs?.highlightElement(el));
 wrap.querySelectorAll('[data-action]').forEach(btn=>btn.addEventListener('click',()=>messageAction(btn.dataset.action,index)));
 return wrap;
}
function refreshMessage(index){const old=$('messages').querySelector(`[data-index="${index}"]`);const m=current().messages[index];if(!old)return;const fresh=messageElement(m,index);old.replaceWith(fresh);}
function newSession(){
 if(state.generating)return;
 const s={id:uid(),title:'New conversation',created:Date.now(),updated:Date.now(),messages:[]};
 state.sessions.unshift(s);state.currentId=s.id;renderHistory();renderMessages();saveLocalState().catch(()=>toast('Could not save workspace'));
 $('messageInput').focus();$('sidebar').classList.remove('open');
}
function switchSession(id){if(state.generating)return;state.currentId=id;renderHistory();renderMessages();$('sidebar').classList.remove('open');}
function deleteSession(id){if(state.generating)return;state.sessions=state.sessions.filter(s=>s.id!==id);if(state.currentId===id)state.currentId=state.sessions[0]?.id||null;if(!state.currentId)newSession();else{renderHistory();renderMessages();saveLocalState();}toast('Conversation deleted');}
function updateSession(){const s=current();s.updated=Date.now();if(s.title==='New conversation'){const first=s.messages.find(m=>m.role==='user');if(first)s.title=titleFrom(first.content);}renderHistory();$('crumbTitle').textContent=s.title;}
function setGenerating(value){state.generating=value;$('sendBtn').classList.toggle('hidden',value);$('stopBtn').classList.toggle('hidden',!value);$('messageInput').disabled=value;$('statusText').textContent=value?'Nemotron is thinking…':'AI can make mistakes. Verify important information.';}
async function sendMessage(text){
 const s=current();if(!s||state.generating)return;
 text=(text??$('messageInput').value).trim();if(!text)return;
 $('messageInput').value='';resizeInput();s.messages.push({role:'user',content:text,timestamp:Date.now()});updateSession();renderMessages();await saveLocalState().catch(()=>{});
 await generate();
}
async function generate(){
 const s=current();if(!s||state.generating)return;
 const assistant={role:'assistant',content:'',reasoning:'',timestamp:Date.now()};s.messages.push(assistant);const index=s.messages.length-1;
 setGenerating(true);renderMessages();state.aborter=new AbortController();
 const body={messages:s.messages.slice(0,-1).map(m=>({role:m.role,content:m.content})),temperature:Number(state.settings.temperature),top_p:Number(state.settings.top_p),max_tokens:Number(state.settings.max_tokens),system_prompt:state.settings.system_prompt,enable_thinking:state.settings.enable_thinking};
 try{

    const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: state.aborter.signal
    });

    if (!response.ok) {
        let data;

        try {
            data = await response.json();
        } catch {
            data = await response.text().catch(() => '');
        }

        throw new Error(formatApiError(data));
    }
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){
   const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
   const events=buffer.split('\n\n');buffer=events.pop()||'';
   for(const event of events){
    const line=event.split('\n').find(x=>x.startsWith('data:'));if(!line)continue;
    const data=line.slice(5).trim();if(data==='[DONE]')continue;
    let chunk;try{chunk=JSON.parse(data)}catch{continue}
    if (chunk.error) {
        throw new Error(formatApiError(chunk));
    }
    const delta=chunk.choices?.[0]?.delta;if(!delta)continue;
    if(delta.reasoning_content){assistant.reasoning+=delta.reasoning_content;}
    if(typeof delta.content==='string')assistant.content+=delta.content;
    refreshMessage(index);
    if(state.settings.auto_scroll)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;
   }
  }
 }catch(err){
  if(err.name==='AbortError'){if(!assistant.content)assistant.content='*Generation stopped.*';}
  else{assistant.content=assistant.content?assistant.content+`\n\n**Request error:** ${err.message}`:`**Request error:** ${err.message}`;toast(err.message.slice(0,130));}
 }finally{
  state.aborter=null;setGenerating(false);assistant.timestamp=Date.now();s.updated=Date.now();updateSession();refreshMessage(index);$('tokenCount').textContent=`≈ ${tokenEstimate().toLocaleString()} tokens`;saveLocalState().catch(()=>toast('Could not save workspace'));$('messageInput').focus();
 }
}
function stopGeneration(){state.aborter?.abort();}
function messageAction(action,index){
 const s=current(),m=s.messages[index];if(!m)return;
 if(action==='copy'){navigator.clipboard.writeText(m.content).then(()=>toast('Copied to clipboard')).catch(()=>toast('Clipboard unavailable'));}
 if(action==='delete'){s.messages.splice(index,1);renderMessages();saveLocalState();}
 if(action==='regenerate'){if(state.generating)return;s.messages=s.messages.slice(0,index);renderMessages();saveLocalState().then(generate);}
}
function resizeInput(){const el=$('messageInput');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,180)+'px';}
function openSettings(){
 const s=state.settings;$('themeSetting').value=s.theme;$('motionSetting').checked=!!s.reduced_motion;$('autoScrollSetting').checked=s.auto_scroll!==false;$('temperatureSetting').value=s.temperature;$('temperatureValue').value=Number(s.temperature).toFixed(2);$('topPSetting').value=s.top_p;$('topPValue').value=Number(s.top_p).toFixed(2);$('maxTokensSetting').value=s.max_tokens;$('systemPromptSetting').value=s.system_prompt;$('thinkingSetting').checked=s.enable_thinking!==false;$('settingsOverlay').classList.remove('hidden');
}
function closeSettings(){$('settingsOverlay').classList.add('hidden');}
function saveSettings(){
 Object.assign(state.settings,{theme:$('themeSetting').value,reduced_motion:$('motionSetting').checked,auto_scroll:$('autoScrollSetting').checked,temperature:Number($('temperatureSetting').value),top_p:Number($('topPSetting').value),max_tokens:Math.max(256,Math.min(32768,Number($('maxTokensSetting').value)||8192)),system_prompt:$('systemPromptSetting').value,enable_thinking:$('thinkingSetting').checked});
 document.body.classList.toggle('light',state.settings.theme==='light');document.body.classList.toggle('reduce-motion',state.settings.reduced_motion);closeSettings();saveLocalState().then(()=>toast('Preferences saved')).catch(()=>toast('Could not save settings'));
}
function exportSession(){const s=current();if(!s)return;const blob=new Blob([JSON.stringify(s,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`nemotron-${s.title.replace(/[^a-z0-9]+/gi,'-').toLowerCase()||'conversation'}.json`;a.click();URL.revokeObjectURL(a.href);}
async function importSession(file){try{const data=JSON.parse(await file.text());if(!Array.isArray(data.messages))throw new Error('This file is not a conversation export.');data.id=uid();data.title=(data.title||'Imported conversation')+' (imported)';data.updated=Date.now();state.sessions.unshift(data);state.currentId=data.id;renderHistory();renderMessages();await saveLocalState();closeSettings();toast('Conversation imported');}catch(e){toast(e.message);}}
async function boot(){
 const auth=await fetch('/api/auth/status').then(r=>r.json());
 if(!auth.authenticated){$('loginScreen').classList.remove('hidden');return;}
 $('app').classList.remove('hidden');
 const data=await fetch('/api/bootstrap').then(async r=>{if(!r.ok)throw new Error('Unable to load workspace');return r.json()});
 state.sessions=data.sessions||[];state.settings={...state.settings,...(data.settings||{})};state.model=data.model||state.model;
 $('modelName').textContent=state.model.split('/').pop();$('modelShort').textContent='NVIDIA API · '+state.model.split('/').pop();$('connectionText').textContent='Workspace online';
 document.body.classList.toggle('light',state.settings.theme==='light');
 if(!state.sessions.length)newSession();else{state.sessions.sort((a,b)=>b.updated-a.updated);state.currentId=state.sessions[0].id;renderHistory();renderMessages();}
 fetch('/api/health').then(r=>r.json()).then(h=>{if(!h.configured){$('connectionText').textContent='API key required';toast('Add NVIDIA_API_KEY in your server environment.');}});
}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('loginPassword').value})});if(!r.ok){$('loginError').textContent=(await r.json()).error;return;}location.reload();});
$('newChat').onclick=newSession;$('sendBtn').onclick=()=>sendMessage();$('stopBtn').onclick=stopGeneration;$('messageInput').addEventListener('input',resizeInput);$('messageInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{ $('messageInput').value=b.dataset.prompt;resizeInput();$('messageInput').focus();});
$('settingsOpen').onclick=$('settingsTop').onclick=openSettings;$('settingsClose').onclick=$('settingsCancel').onclick=closeSettings;$('settingsSave').onclick=saveSettings;$('settingsOverlay').addEventListener('click',e=>{if(e.target===$('settingsOverlay'))closeSettings();});
$('temperatureSetting').oninput=e=>$('temperatureValue').value=Number(e.target.value).toFixed(2);$('topPSetting').oninput=e=>$('topPValue').value=Number(e.target.value).toFixed(2);
$('exportChat').onclick=exportSession;$('importButton').onclick=()=>$('importFile').click();$('importFile').onchange=e=>e.target.files[0]&&importSession(e.target.files[0]);
$('searchToggle').onclick=()=>{$('historySearch').classList.toggle('hidden');$('historySearch').focus();};$('historySearch').oninput=renderHistory;$('sortHistory').onclick=()=>{state.sortNewest=!state.sortNewest;renderHistory();};
$('menuToggle').onclick=()=>$('sidebar').classList.add('open');$('closeSidebar').onclick=()=>$('sidebar').classList.remove('open');$('allChats').onclick=()=>{if(!state.generating){if(current())renderMessages();$('sidebar').classList.remove('open');}};
$('logoutBtn').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.reload();};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();newSession();}if(e.key==='Escape'){closeSettings();$('sidebar').classList.remove('open');}});
boot().catch(e=>{console.error(e);toast(e.message);});
