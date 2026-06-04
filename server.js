// ═══════════════════════════════════════
//  KAT SERVER v3 — final clean version
// ═══════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kat.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT = {
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

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.warn('load error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT));
}

function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
  catch(e) { console.warn('save error:', e.message); }
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/data', (_, res) => {
  res.json(loadData());
});

app.post('/api/data', (req, res) => {
  try {
    const d = loadData(), b = req.body;
    if (b.events  !== undefined) d.events  = b.events;
    if (b.todos   !== undefined) d.todos   = b.todos;
    if (b.cats    !== undefined) d.cats    = b.cats;
    if (b.journal) {
      for (const [k, v] of Object.entries(b.journal))
        d.journal[k] = { mood: v.mood, text: v.text, date: v.date };
    }
    saveData(d);
    res.json({ ok: true });
  } catch(e) {
    console.error('POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apple Calendar iCal feed
app.get('/ical', (_, res) => {
  const d = loadData();
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(buildICS(d.events || {}));
});

function esc(s) {
  return (s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\;').replace(/\n/g,'\\n');
}
function toD(dk, t) {
  const [y,m,d] = dk.split('-').map(Number);
  const [h,mi]  = (t||'09:00').split(':').map(Number);
  const p = n => String(n).padStart(2,'0');
  return `${y}${p(m)}${p(d)}T${p(h)}${p(mi)}00`;
}
function nowStamp() {
  const n = new Date();
  const p = x => String(x).padStart(2,'0');
  return `${n.getUTCFullYear()}${p(n.getUTCMonth()+1)}${p(n.getUTCDate())}T${p(n.getUTCHours())}${p(n.getUTCMinutes())}${p(n.getUTCSeconds())}Z`;
}

function buildICS(events) {
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KAT App//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:KAT Agenda',
    'X-WR-CALDESC:Agenda personnel KAT',
    'X-WR-TIMEZONE:Europe/Paris',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ];

  // Always include at least one VEVENT so Apple Calendar accepts the feed
  const allEvs = [];
  for (const [dk, evs] of Object.entries(events)) {
    if (!Array.isArray(evs)) continue;
    evs.forEach(ev => { if (ev.title) allEvs.push({dk, ev}); });
  }

  // If no events yet, add a placeholder so Apple Calendar validates
  if (allEvs.length === 0) {
    const today = new Date().toISOString().slice(0,10);
    L.push(
      'BEGIN:VEVENT',
      `UID:kat-placeholder@kat-app`,
      `DTSTAMP:${nowStamp()}`,
      `DTSTART;VALUE=DATE:${today.replace(/-/g,'')}`,
      `DTEND;VALUE=DATE:${today.replace(/-/g,'')}`,
      'SUMMARY:KAT Agenda',
      'DESCRIPTION:Abonnement KAT actif. Creez des evenements dans KAT pour les voir ici.',
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  for (const {dk, ev} of allEvs) {
    const dur = parseInt(ev.duration) || 60;
    const [h,mi] = (ev.time||'09:00').split(':').map(Number);
    const tm = h*60+mi+dur;
    const endT = `${String(Math.floor(tm/60)).padStart(2,'0')}:${String(tm%60).padStart(2,'0')}`;
    // Use TZID for local Paris time
    L.push(
      'BEGIN:VEVENT',
      `UID:${ev.id||dk+'-'+Math.random().toString(36).slice(2)}@kat-app`,
      `DTSTAMP:${nowStamp()}`,
      `DTSTART;TZID=Europe/Paris:${toD(dk,ev.time)}`,
      `DTEND;TZID=Europe/Paris:${toD(dk,endT)}`,
      `SUMMARY:${esc(ev.title)}`,
      `STATUS:${ev.done?'COMPLETED':'CONFIRMED'}`
    );
    if (ev.location) L.push(`LOCATION:${esc(ev.location)}`);
    if (ev.notes)    L.push(`DESCRIPTION:${esc(ev.notes)}`);
    const rm = {daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
    if (ev.recurrence&&ev.recurrence!=='none') L.push(`RRULE:FREQ=${rm[ev.recurrence]}`);
    (ev.reminders||[]).forEach(m => {
      if (m>0) {
        L.push('BEGIN:VALARM',`TRIGGER:-PT${m}M`,'ACTION:DISPLAY',`DESCRIPTION:Rappel: ${esc(ev.title)}`,'END:VALARM');
      }
    });
    L.push('END:VEVENT');
  }

  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`🐱 KAT v3 on :${PORT}`);
  console.log(`📅 webcal://kat-app.onrender.com/ical`);
});
