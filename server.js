// ═══════════════════════════════════════
//  KAT SERVER v3 — final clean version
// ═══════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kat.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT = {
  events:{}, todos:{}, journal:{}, settings:{},
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
  // Also update public/kat.ics on GitHub so subscription URL is always fresh
  updateGithubICS(d.events || {}).catch(() => {});
}

// GitHub credentials for static iCal hosting
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = 'leoderoudilhe-cell';
const GH_REPO  = 'kat-backend';
const GH_ICS_PATH = 'public/kat.ics';
let _icsSha = null; // cached SHA for updates

function ghPut(filePath, content, sha) {
  return new Promise((resolve, reject) => {
    if (!GH_TOKEN) return resolve(null);
    const body = JSON.stringify({
      message: 'KAT calendar update',
      content: Buffer.from(content).toString('base64'),
      ...(sha ? { sha } : {}),
    });
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
      method: 'PUT',
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'KAT/3.0',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getIcsSha() {
  if (_icsSha) return _icsSha;
  try {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_ICS_PATH}`,
      method: 'GET',
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'KAT/3.0',
      },
    };
    const res = await new Promise((resolve, reject) => {
      const req = https.request(opts, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve({ status: r.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: r.statusCode, body: {} }); } });
      });
      req.on('error', reject);
      req.end();
    });
    if (res.status === 200 && res.body.sha) {
      _icsSha = res.body.sha;
      return _icsSha;
    }
  } catch(e) {}
  return null;
}

async function updateGithubICS(events) {
  if (!GH_TOKEN) return;
  const icsContent = buildICS(events);
  const sha = await getIcsSha();
  const result = await ghPut(GH_ICS_PATH, icsContent, sha);
  if (result && (result.status === 200 || result.status === 201)) {
    _icsSha = result.body?.content?.sha || sha;
    console.log('✅ GitHub kat.ics updated');
  } else {
    console.warn('GitHub ICS update failed:', result?.status);
    _icsSha = null; // reset to force re-fetch next time
  }
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
    // Détection des events supprimés avant merge
    let deletedIds = [];
    if (b.events !== undefined) {
      const prevEvents = d.events || {};
      const prevIds = new Set();
      for (const evs of Object.values(prevEvents)) {
        if (Array.isArray(evs)) evs.forEach(ev => { if (ev.id) prevIds.add(ev.id); });
      }
      const newIds = new Set();
      for (const evs of Object.values(b.events || {})) {
        if (Array.isArray(evs)) evs.forEach(ev => { if (ev.id) newIds.add(ev.id); });
      }
      for (const id of prevIds) {
        if (!newIds.has(id)) deletedIds.push(id);
      }
    }
    if (b.events  !== undefined) d.events  = b.events;
    if (b.todos   !== undefined) d.todos   = b.todos;
    if (b.cats    !== undefined) d.cats    = b.cats;
    // Ne jamais écraser des données existantes avec une liste vide
    if (b.courses !== undefined) {
      const incomingItems = (b.courses.items || []).length;
      const existingItems = (d.courses && d.courses.items || []).length;
      if (incomingItems > 0 || existingItems === 0) d.courses = b.courses;
    }
    if (b.ptodos !== undefined) {
      if (b.ptodos.length > 0 || !d.ptodos || d.ptodos.length === 0) d.ptodos = b.ptodos;
    }
    if (b.settings !== undefined) d.settings = b.settings;
    if (b.journal !== undefined && b.journal !== null) {
      for (const [k, v] of Object.entries(b.journal))
        d.journal[k] = { mood: v.mood, text: v.text, date: v.date };
        // Include photos (max 500KB per entry to avoid giant files)
        if (Array.isArray(v.photos) && v.photos.length) {
          let photosStr = JSON.stringify(v.photos);
          d.journal[k].photos = photosStr.length < 500000 ? v.photos : v.photos.slice(0,2);
        }
    }
    saveData(d);
    // Batch CalDAV — debounced 3s to group rapid changes
    if (b.events !== undefined) {
      clearTimeout(app._icloudTimer);
      const eventsSnapshot = d.events;
      const deletedSnapshot = [...deletedIds];
      app._icloudTimer = setTimeout(() => {
        syncToiCloud(eventsSnapshot).catch(e => console.warn('iCloud sync failed:', e.message));
        deletedSnapshot.forEach(id => deleteFromiCloud(id).catch(() => {}));
        if (deletedSnapshot.length) console.log(`🗑️ iCloud delete: ${deletedSnapshot.join(', ')}`);
      }, 3000);
    }
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
  return (s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\\;').replace(/\n/g,'\\n');
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
    'PRODID:-//KAT App//KAT Agenda//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:KAT',
  ];

  const push = (line) => lines.push(fold(line));

  const allEvs = [];
  for (const [dk, evs] of Object.entries(events)) {
    if (!Array.isArray(evs)) continue;
    evs.forEach(ev => { if (ev.title) allEvs.push({dk, ev}); });
  }

  // Placeholder — future event, proper UID format
  if (allEvs.length === 0) {
    push('BEGIN:VEVENT');
    push('UID:kat-agenda-init-2027@kat-app.onrender.com');
    push(`DTSTAMP:${nowStamp()}`);
    push('DTSTART:20270101T100000Z');
    push('DTEND:20270101T110000Z');
    push('SUMMARY:KAT Agenda');
    push('END:VEVENT');
  }

  for (const {dk, ev} of allEvs) {
    // Convert local Paris time to UTC (Paris = UTC+1 winter, UTC+2 summer)
    const [y,m,d] = dk.split('-').map(Number);
    const [h,mi] = (ev.time||'09:00').split(':').map(Number);
    const dur = parseInt(ev.duration) || 60;
    // Determine UTC offset for Paris (simple: +1 Oct-Mar, +2 Apr-Sep)
    const utcOffset = (m >= 4 && m <= 9) ? 2 : 1;
    const utcH = h - utcOffset;
    const startDate = new Date(Date.UTC(y, m-1, d, utcH, mi, 0));
    const endDate   = new Date(startDate.getTime() + dur * 60000);
    const fmtUTC = dt => {
      const p = x => String(x).padStart(2,'0');
      return `${dt.getUTCFullYear()}${p(dt.getUTCMonth()+1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00Z`;
    };
    push('BEGIN:VEVENT');
    push(`UID:${ev.id||(dk+"-"+(ev.title||"").slice(0,6).replace(/[^a-z0-9]/gi,""))}@kat`);
    push(`DTSTAMP:${nowStamp()}`);
    push(`DTSTART:${fmtUTC(startDate)}`);
    push(`DTEND:${fmtUTC(endDate)}`);
    push(`SUMMARY:${esc(ev.title)}`);
    if (ev.location) push(`LOCATION:${esc(ev.location)}`);
    if (ev.notes)    push(`DESCRIPTION:${esc(ev.notes)}`);
    const rm = {daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
    if (ev.recurrence&&ev.recurrence!=='none') push(`RRULE:FREQ=${rm[ev.recurrence]}`);
    (ev.reminders||[]).forEach(min => {
      if (min>0) {
        push('BEGIN:VALARM');
        push(`TRIGGER:-PT${min}M`);
        push('ACTION:DISPLAY');
        push(`DESCRIPTION:Rappel`);
        push('END:VALARM');
      }
    });
    push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ── Sync depuis iCloud → KAT ──
app.get('/api/sync-from-icloud', async (req, res) => {
  if (!ICLOUD_CAL_URL || !ICLOUD_EMAIL || !ICLOUD_PASSWORD) {
    return res.status(503).json({ error: 'iCloud credentials non configurés' });
  }
  try {
    // PROPFIND pour lister les .ics
    const propfindBody = `<?xml version="1.0" encoding="UTF-8"?>\
<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getcontenttype/></D:prop></D:propfind>`;
    const listResp = await caldavRequest('PROPFIND', ICLOUD_CAL_URL, propfindBody, {
      'Depth': '1',
      'Content-Type': 'application/xml; charset=utf-8',
    });
    if (!listResp || listResp.status >= 400) {
      return res.status(502).json({ error: 'PROPFIND failed: ' + (listResp && listResp.status) });
    }
    // Parse hrefs des .ics
    const hrefMatches = listResp.body.match(/<[^:]*:?href[^>]*>([^<]+\.ics[^<]*)<\/[^:]*:?href>/gi) || [];
    const hrefs = hrefMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(h => h.endsWith('.ics'));

    const events = [];
    for (const href of hrefs) {
      try {
        const parsedBase = new URL(ICLOUD_CAL_URL);
        const fullUrl = href.startsWith('http') ? href : `${parsedBase.protocol}//${parsedBase.host}${href}`;
        const evResp = await caldavRequest('GET', fullUrl, null, {});
        if (!evResp || evResp.status !== 200) continue;
        const ics = evResp.body;
        // Parse minimal iCal
        const get = (field) => {
          const m = ics.match(new RegExp(field + '[^:]*:([^\\r\\n]+)'));
          return m ? m[1].replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\;/g, ';').trim() : '';
        };
        const uid = get('UID');
        const summary = get('SUMMARY');
        const dtstart = get('DTSTART');
        const dtend   = get('DTEND');
        const location= get('LOCATION');
        const desc    = get('DESCRIPTION');
        if (!uid || !summary) continue;
        // Parse DTSTART → date + time
        let dateKey = '', time = '';
        const dtClean = dtstart.replace(/TZID=[^:]+:/, '');
        if (dtClean.length >= 8) {
          const y = dtClean.slice(0,4), mo = dtClean.slice(4,6), dy = dtClean.slice(6,8);
          dateKey = `${y}-${mo}-${dy}`;
          if (dtClean.length >= 13 && dtClean[8] === 'T') {
            const h = dtClean.slice(9,11), mi2 = dtClean.slice(11,13);
            time = `${h}:${mi2}`;
          }
        }
        // Duration
        let duration = 60;
        if (dtend) {
          const endClean = dtend.replace(/TZID=[^:]+:/, '');
          if (endClean.length >= 13 && dtClean.length >= 13) {
            const sMin = parseInt(dtClean.slice(9,11))*60 + parseInt(dtClean.slice(11,13));
            const eMin = parseInt(endClean.slice(9,11))*60 + parseInt(endClean.slice(11,13));
            if (eMin > sMin) duration = eMin - sMin;
          }
        }
        events.push({ id: uid.replace(/@.*/, ''), title: summary, date: dateKey, time, duration, location, notes: desc });
      } catch(e2) { /* skip malformed */ }
    }
    console.log(`📥 iCloud → KAT: ${events.length} event(s) parsés`);
    res.json({ ok: true, events });
  } catch(e) {
    console.error('sync-from-icloud error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete a specific event from iCloud CalDAV
app.post('/api/delete-event', async (req, res) => {
  const { evId } = req.body || {};
  if (!evId) return res.status(400).json({ error: 'evId required' });
  try {
    await deleteFromiCloud(evId);
    console.log('🗑 Deleted from iCloud:', evId);
    res.json({ ok: true });
  } catch(e) {
    console.warn('Delete from iCloud failed:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app._icloudTimer = null;
app.listen(PORT, () => {
  console.log(`🐱 KAT v3 on :${PORT}`);
  console.log(`📅 webcal://kat-app.onrender.com/ical`);
  // Nettoyage one-time des events de test iCloud
  const TEST_IDS = ['kat-test-001','kat-sync-v2-001','kat-final-test-001','kat-https-fix-001','kat-final-v5','kat-caldav-test-001'];
  setTimeout(() => {
    TEST_IDS.forEach(id => deleteFromiCloud(id).catch(() => {}));
    console.log('🧹 Cleanup events test iCloud lancé');
  }, 5000);
});

// ═══════════════════════════════════════════════
//  iCLOUD CALDAV SYNC — Auto-sync to Apple Calendar
// ═══════════════════════════════════════════════
const ICLOUD_EMAIL    = process.env.ICLOUD_EMAIL;
const ICLOUD_PASSWORD = process.env.ICLOUD_PASSWORD;
const ICLOUD_CAL_URL  = process.env.ICLOUD_CAL_URL;

function caldavRequest(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!ICLOUD_EMAIL || !ICLOUD_PASSWORD || !ICLOUD_CAL_URL) return resolve(null);
    const creds = Buffer.from(`${ICLOUD_EMAIL}:${ICLOUD_PASSWORD}`).toString('base64');
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method,
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'text/calendar; charset=utf-8',
        'User-Agent': 'KAT-App/3.0',
        ...extraHeaders,
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildEventICS(dk, ev) {
  const CRLF = '\r\n';
  const esc = s => (s||'').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\;').replace(/\n/g,'\\n');
  const toD = (dateKey, t) => {
    const [y,m,d] = dateKey.split('-').map(Number);
    const [h,mi] = (t||'09:00').split(':').map(Number);
    const p = x => String(x).padStart(2,'0');
    return `${y}${p(m)}${p(d)}T${p(h)}${p(mi)}00`;
  };
  const dur = parseInt(ev.duration) || 60;
  const [h,mi] = (ev.time||'09:00').split(':').map(Number);
  const tm = h*60+mi+dur;
  const endT = `${String(Math.floor(tm/60)).padStart(2,'0')}:${String(tm%60).padStart(2,'0')}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KAT App//KAT Agenda//FR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.id}@kat-app`,
    `DTSTAMP:${nowStamp()}`,
    `DTSTART:${toD(dk, ev.time)}`,
    `DTEND:${toD(dk, endT)}`,
    `SUMMARY:${esc(ev.title)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
  if (ev.notes)    lines.push(`DESCRIPTION:${esc(ev.notes)}`);
  const rm = {daily:'DAILY',weekly:'WEEKLY',monthly:'MONTHLY',yearly:'YEARLY'};
  if (ev.recurrence && ev.recurrence !== 'none') lines.push(`RRULE:FREQ=${rm[ev.recurrence]}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join(CRLF);
}

async function syncToiCloud(events) {
  if (!ICLOUD_CAL_URL) return;
  const allEvs = [];
  for (const [dk, evs] of Object.entries(events || {})) {
    if (!Array.isArray(evs)) continue;
    evs.forEach(ev => { if (ev.id && ev.title) allEvs.push({ dk, ev }); });
  }
  // Upsert all events
  for (const { dk, ev } of allEvs) {
    try {
      const ics = buildEventICS(dk, ev);
      const url = ICLOUD_CAL_URL + ev.id + '.ics';
      const r = await caldavRequest('PUT', url, ics, { 'If-Match': '*' });
      // If event doesn't exist yet (412 = precondition failed), create it
      if (r && r.status === 412) {
        await caldavRequest('PUT', url, ics, { 'If-None-Match': '*' });
      }
    } catch(e) { console.warn('iCloud sync error:', ev.id, e.message); }
  }
  console.log(`✅ iCloud sync: ${allEvs.length} event(s)`);
}

async function deleteFromiCloud(evId) {
  if (!ICLOUD_CAL_URL || !evId) return;
  try {
    const url = ICLOUD_CAL_URL + evId + '.ics';
    await caldavRequest('DELETE', url, null, {});
  } catch(e) {}
}

// ═══ AUTO-SYNC iCloud → KAT toutes les 5 minutes ═══
async function autoSyncFromiCloud() {
  if (!ICLOUD_CAL_URL || !ICLOUD_EMAIL || !ICLOUD_PASSWORD) return;
  try {
    const propfindBody = `<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`;
    const listResp = await caldavRequest('PROPFIND', ICLOUD_CAL_URL, propfindBody,
      { 'Depth': '1', 'Content-Type': 'application/xml' });
    if (!listResp || listResp.status >= 400) return;

    const hrefMatches = listResp.body.match(/<[^:]*:?href[^>]*>([^<]+\.ics[^<]*)<\/[^:]*:?href>/gi) || [];
    const hrefs = hrefMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).filter(h => h.endsWith('.ics'));

    const data = loadData();
    const allKatIds = new Set(Object.values(data.events).flat().map(e => e.id));
    let changed = false;

    for (const href of hrefs) {
      try {
        const parsedBase = new URL(ICLOUD_CAL_URL);
        const fullUrl = href.startsWith('http') ? href : `${parsedBase.protocol}//${parsedBase.host}${href}`;
        const evResp = await caldavRequest('GET', fullUrl, null, {});
        if (!evResp || evResp.status !== 200) continue;
        const ics = evResp.body;
        const get = f => { const m = ics.match(new RegExp(f + '[^:]*:([^\\r\\n]+)')); return m ? m[1].trim() : ''; };
        const uid = get('UID'), summary = get('SUMMARY'), dtstart = get('DTSTART');
        if (!uid || !summary || !dtstart) continue;
        // Don't skip @kat-app events — they need to come back if KAT lost its data
        const evId = uid.replace(/@.*/,'').slice(0,40);
        if (allKatIds.has(evId)) continue; // already in KAT

        const dtc = dtstart.replace(/TZID=[^:]+:/,'').replace('Z','');
        if (dtc.length < 8) continue;
        const dk = `${dtc.slice(0,4)}-${dtc.slice(4,6)}-${dtc.slice(6,8)}`;
        const time = dtc.length >= 13 ? `${dtc.slice(9,11)}:${dtc.slice(11,13)}` : '09:00';
        if (!data.events[dk]) data.events[dk] = [];
        data.events[dk].push({ id: evId, title: summary, time, duration: 60, catId: 'work', done: false, fromApple: true });
        allKatIds.add(evId);
        changed = true;
      } catch(e2) {}
    }

    if (changed) {
      saveData(data);
      console.log('✅ Auto-sync: nouveaux events Apple Calendar importés dans KAT');
    }
  } catch(e) { console.warn('autoSyncFromiCloud error:', e.message); }
}

// Lancer au démarrage (après 10s) puis toutes les 5 minutes
setTimeout(() => {
  autoSyncFromiCloud();
  setInterval(autoSyncFromiCloud, 5 * 60 * 1000);
}, 10000);
