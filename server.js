// ═══════════════════════════════════════════════
//  KAT SERVER v3 — GitHub persistent storage
// ═══════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = 'leoderoudilhe-cell';
const GITHUB_REPO  = 'kat-backend';
const GITHUB_FILE  = 'data/kat.json';

let _cache = null, _sha = null, _dirty = false, _flushing = false;

const DEFAULT_DATA = {
  events:{}, todos:{}, journal:{},
  cats:[
    {id:'work',   name:'Travail',   color:'#007AFF',emoji:'💼'},
    {id:'sport',  name:'Sport',     color:'#34C759',emoji:'🏃'},
    {id:'perso',  name:'Personnel', color:'#8B5CF6',emoji:'👤'},
    {id:'leisure',name:'Loisirs',   color:'#FF9500',emoji:'🎮'},
    {id:'health', name:'Santé',     color:'#FF3B30',emoji:'❤️'},
    {id:'social', name:'Social',    color:'#5AC8FA',emoji:'👥'},
  ],
};

function ghRequest(method, p, body) {
  return new Promise((resolve, reject) => {
    if (!GITHUB_TOKEN) return resolve(null);
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname:'api.github.com', path:p, method,
      headers:{
        'Authorization':`token ${GITHUB_TOKEN}`,
        'Accept':'application/vnd.github.v3+json',
        'User-Agent':'KAT-App/3.0',
        'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{resolve({s:res.statusCode,b:JSON.parse(d)});}
        catch{resolve({s:res.statusCode,b:d});}
      });
    });
    req.on('error',reject);
    if(bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function loadData() {
  if (_cache) return _cache;
  try {
    const r = await ghRequest('GET',`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`);
    if (r && r.s===200 && r.b.content) {
      _cache = JSON.parse(Buffer.from(r.b.content,'base64').toString('utf8'));
      _sha   = r.b.sha;
      console.log('✅ Loaded from GitHub sha:'+_sha.slice(0,7));
      return _cache;
    }
  } catch(e){ console.warn('GH load failed:',e.message); }
  _cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
  return _cache;
}

async function flush() {
  if (_flushing||!_dirty||!GITHUB_TOKEN) return;
  _flushing=true;
  try {
    const body = {
      message:'KAT sync',
      content:Buffer.from(JSON.stringify(_cache,null,2)).toString('base64'),
    };
    if (_sha) body.sha = _sha; // omit sha for new file creation
    const r = await ghRequest('PUT',`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, body);
    if (r&&(r.s===200||r.s===201)){_sha=r.b.content?.sha||_sha;_dirty=false;console.log('✅ Flushed to GitHub');}
    else console.warn('GH flush failed:',r?.s);
  } catch(e){ console.warn('GH flush error:',e.message); }
  _flushing=false;
}

setInterval(()=>{if(_dirty) flush();}, 30000);

app.use(cors({origin:'*'}));
app.use(express.json({limit:'50mb'}));
app.use(express.static(path.join(__dirname,'public')));

app.get('/api/ping',(_,res)=>res.json({ok:true,ts:Date.now()}));

app.get('/api/data', async (_,res)=>{
  try{ res.json(await loadData()); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/data', async (req,res)=>{
  try {
    const d=await loadData(), b=req.body;
    if(b.events!==undefined)  d.events=b.events;
    if(b.todos!==undefined)   d.todos=b.todos;
    if(b.cats!==undefined)    d.cats=b.cats;
    if(b.journal) for(const[k,v] of Object.entries(b.journal))
      d.journal[k]={mood:v.mood,text:v.text,date:v.date};
    _dirty=true;
    flush().catch(e=>console.warn('async flush:',e.message));
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/ical', async (_,res)=>{
  try {
    const d=await loadData();
    res.set('Content-Type','text/calendar; charset=utf-8');
    res.set('Cache-Control','no-cache');
    res.send(buildICS(d.events||{}));
  } catch(e){ res.status(500).send('Calendar error'); }
});

function esc(s){return(s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\;').replace(/\n/g,'\\n');}
function toD(dateKey,t){
  const[y,m,d]=dateKey.split('-').map(Number);
  const[h,mi]=(t||'09:00').split(':').map(Number);
  const p=n=>String(n).padStart(2,'0');
  return `${y}${p(m)}${p(d)}T${p(h)}${p(mi)}00`;
}
function buildICS(events){
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//KAT//FR','CALSCALE:GREGORIAN',
    'METHOD:PUBLISH','X-WR-CALNAME:KAT 🐱','REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  for(const[dk,evs] of Object.entries(events)){
    if(!Array.isArray(evs)) continue;
    for(const ev of evs){
      if(!ev.title) continue;
      const dur=parseInt(ev.duration)||60;
      const[h,mi]=(ev.time||'09:00').split(':').map(Number);
      const tm=h*60+mi+dur;
      const endT=`${String(Math.floor(tm/60)).padStart(2,'0')}:${String(tm%60).padStart(2,'0')}`;
      L.push('BEGIN:VEVENT',
        `UID:${ev.id||Math.random().toString(36).slice(2)}@kat`,
        `DTSTAMP:${toD(new Date().toISOString().slice(0,10),'00:00')}`,
        `DTSTART:${toD(dk,ev.time)}`,`DTEND:${toD(dk,endT)}`,
        `SUMMARY:${esc(ev.title)}`,`STATUS:${ev.done?'COMPLETED':'CONFIRMED'}`);
      if(ev.location) L.push(`LOCATION:${esc(ev.location)}`);
      if(ev.notes)    L.push(`DESCRIPTION:${esc(ev.notes)}`);
      const rm={daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
      if(ev.recurrence&&ev.recurrence!=='none') L.push(`RRULE:FREQ=${rm[ev.recurrence]}`);
      (ev.reminders||[]).forEach(m=>{if(m>0)L.push('BEGIN:VALARM',`TRIGGER:-PT${m}M`,'ACTION:DISPLAY',`DESCRIPTION:Rappel`,'END:VALARM');});
      L.push('END:VEVENT');
    }
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, async()=>{
  console.log(`🐱 KAT v3 on :${PORT}`);
  await loadData();
  console.log('📅 webcal://kat-app.onrender.com/ical');
});
