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

// ── Cat head SVG icon ──
const CAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#8B5CF6"/>
  <polygon points="18,42 12,16 36,34" fill="#A78BFA"/>
  <polygon points="82,42 88,16 64,34" fill="#A78BFA"/>
  <polygon points="20,40 15,20 34,34" fill="#DDD6FE"/>
  <polygon points="80,40 85,20 66,34" fill="#DDD6FE"/>
  <circle cx="50" cy="60" r="30" fill="white"/>
  <ellipse cx="38" cy="54" rx="5.5" ry="6.5" fill="#1a0533"/>
  <ellipse cx="62" cy="54" rx="5.5" ry="6.5" fill="#1a0533"/>
  <circle cx="40" cy="52" r="1.8" fill="white"/>
  <circle cx="64" cy="52" r="1.8" fill="white"/>
  <ellipse cx="50" cy="65" rx="2.5" ry="2" fill="#F9A8D4"/>
  <path d="M46 69 Q50 73 54 69" stroke="#E9D5FF" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <line x1="14" y1="62" x2="36" y2="63" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
  <line x1="14" y1="67" x2="36" y2="66" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
  <line x1="64" y1="63" x2="86" y2="62" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
  <line x1="64" y1="66" x2="86" y2="67" stroke="#DDD6FE" stroke-width="1.2" opacity="0.8"/>
</svg>`;

app.get('/icon.svg', (_, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(CAT_SVG);
});

app.get('/manifest.json', (_, res) => {
  const iconDataUri = 'data:image/svg+xml,' + encodeURIComponent(CAT_SVG);
  res.json({
    name: 'KAT',
    short_name: 'KAT',
    description: 'Agenda personnel de KAT 🐱',
    start_url: '/',
    display: 'standalone',
    background_color: '#8B5CF6',
    theme_color: '#8B5CF6',
    orientation: 'portrait',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: iconDataUri, sizes: '192x192', type: 'image/svg+xml' },
      { src: iconDataUri, sizes: '512x512', type: 'image/svg+xml' }
    ]
  });
});

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

// RFC 5545 line folding: max 75 octets per line
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let pos = 0;
  while (pos < bytes.length) {
    const limit = pos === 0 ? 75 : 74; // first line 75, continuation 74 (space takes 1)
    // Find a safe UTF-8 boundary
    let end = Math.min(pos + limit, bytes.length);
    while (end > pos && (bytes[end] & 0xC0) === 0x80) end--; // don't split multi-byte char
    parts.push((pos > 0 ? ' ' : '') + bytes.slice(pos, end).toString('utf8'));
    pos = end;
  }
  return parts.join('\r\n');
}

function buildICS(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KAT//KAT Agenda//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:KAT Agenda',
    'X-WR-CALDESC:Agenda KAT',
    'X-WR-TIMEZONE:Europe/Paris',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    // VTIMEZONE required for TZID=Europe/Paris
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Paris',
    'X-LIC-LOCATION:Europe/Paris',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  const push = (line) => lines.push(fold(line));

  const allEvs = [];
  for (const [dk, evs] of Object.entries(events)) {
    if (!Array.isArray(evs)) continue;
    evs.forEach(ev => { if (ev.title) allEvs.push({dk, ev}); });
  }

  // Placeholder event so Apple Calendar validates even when calendar is empty
  if (allEvs.length === 0) {
    const d = new Date();
    const p = x => String(x).padStart(2,'0');
    const today  = `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
    // DTEND must be day AFTER for all-day events
    d.setUTCDate(d.getUTCDate() + 1);
    const tomorrow = `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
    push('BEGIN:VEVENT');
    push('UID:kat-placeholder-2026@kat-app');
    push(`DTSTAMP:${nowStamp()}`);
    push(`DTSTART;VALUE=DATE:${today}`);
    push(`DTEND;VALUE=DATE:${tomorrow}`);
    push('SUMMARY:KAT Agenda');
    push('DESCRIPTION:Abonnement actif. Creez des evenements dans KAT.');
    push('STATUS:CONFIRMED');
    push('TRANSP:TRANSPARENT');
    push('END:VEVENT');
  }

  for (const {dk, ev} of allEvs) {
    const dur = parseInt(ev.duration) || 60;
    const [h,mi] = (ev.time||'09:00').split(':').map(Number);
    const tm = h*60+mi+dur;
    const endT = `${String(Math.floor(tm/60)).padStart(2,'0')}:${String(tm%60).padStart(2,'0')}`;
    push('BEGIN:VEVENT');
    push(`UID:${ev.id||dk+'-'+Math.random().toString(36).slice(2)}@kat-app`);
    push(`DTSTAMP:${nowStamp()}`);
    push(`DTSTART;TZID=Europe/Paris:${toD(dk,ev.time)}`);
    push(`DTEND;TZID=Europe/Paris:${toD(dk,endT)}`);
    push(`SUMMARY:${esc(ev.title)}`);
    push(`STATUS:${ev.done?'COMPLETED':'CONFIRMED'}`);
    if (ev.location) push(`LOCATION:${esc(ev.location)}`);
    if (ev.notes)    push(`DESCRIPTION:${esc(ev.notes)}`);
    const rm = {daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
    if (ev.recurrence&&ev.recurrence!=='none') push(`RRULE:FREQ=${rm[ev.recurrence]}`);
    (ev.reminders||[]).forEach(m => {
      if (m>0) {
        push('BEGIN:VALARM');
        push(`TRIGGER:-PT${m}M`);
        push('ACTION:DISPLAY');
        push(`DESCRIPTION:Rappel: ${esc(ev.title)}`);
        push('END:VALARM');
      }
    });
    push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`🐱 KAT v3 on :${PORT}`);
  console.log(`📅 webcal://kat-app.onrender.com/ical`);
});
