// ═══ KAT SERVER v3 ═══
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'kat.json');
const DATA_DIR = path.join(__dirname, 'data');

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Ensure data directory exists ───
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Default categories ───
const DEFAULT_CATS = [
  { id: 'cat1', name: 'Travail',   color: '#007AFF', emoji: '💼' },
  { id: 'cat2', name: 'Sport',     color: '#34C759', emoji: '🏃' },
  { id: 'cat3', name: 'Personnel', color: '#8B5CF6', emoji: '👤' },
  { id: 'cat4', name: 'Loisirs',   color: '#FF9500', emoji: '🎮' },
  { id: 'cat5', name: 'Santé',     color: '#FF3B30', emoji: '❤️' },
  { id: 'cat6', name: 'Social',    color: '#5AC8FA', emoji: '👥' },
];

// ─── Load data ───
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { events: {}, todos: {}, journal: {}, cats: DEFAULT_CATS };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading data file:', e);
    return { events: {}, todos: {}, journal: {}, cats: DEFAULT_CATS };
  }
}

// ─── Save data ───
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── ICS escaping ───
function escIcs(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}

// ─── Format date for ICS ───
function toIcsDate(dateStr, timeStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T' + (timeStr || '00:00') + ':00');
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

// ─── Routes ───

// Ping
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// GET all data
app.get('/api/data', (req, res) => {
  const data = loadData();
  res.json(data);
});

// POST update data
app.post('/api/data', (req, res) => {
  try {
    const current = loadData();
    const incoming = req.body;

    // Merge: remote wins
    if (incoming.events) current.events = incoming.events;
    if (incoming.todos) current.todos = incoming.todos;
    if (incoming.cats) current.cats = incoming.cats;

    // Journal: merge entries, save text+mood+date but strip photos
    if (incoming.journal) {
      if (!current.journal) current.journal = {};
      for (const [dateKey, entry] of Object.entries(incoming.journal)) {
        current.journal[dateKey] = {
          mood: entry.mood,
          text: entry.text,
          date: entry.date,
          // photos intentionally NOT saved to server
        };
      }
    }

    saveData(current);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/data error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET iCal feed
app.get('/ical', (req, res) => {
  const data = loadData();
  const events = data.events || {};
  const lines = [];

  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//KAT App//KAT Agenda//FR');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:KAT 🐱');
  lines.push('X-WR-CALDESC:Agenda personnel KAT');
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT15M');

  const now = new Date();
  const stamp = toIcsDate(
    now.toISOString().split('T')[0],
    now.toTimeString().slice(0,5)
  );

  for (const [dateKey, dayEvents] of Object.entries(events)) {
    if (!Array.isArray(dayEvents)) continue;
    for (const ev of dayEvents) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${ev.id || (dateKey + '-' + Math.random())}@kat-app`);
      lines.push(`DTSTAMP:${stamp}Z`);
      lines.push(`DTSTART:${toIcsDate(dateKey, ev.time || '00:00')}`);

      // Duration / end
      if (ev.duration && ev.time) {
        const [h, m] = (ev.time).split(':').map(Number);
        const totalMin = h * 60 + m + parseInt(ev.duration || 60);
        const endH = String(Math.floor(totalMin / 60)).padStart(2, '0');
        const endM = String(totalMin % 60).padStart(2, '0');
        lines.push(`DTEND:${toIcsDate(dateKey, endH + ':' + endM)}`);
      } else {
        lines.push(`DTEND:${toIcsDate(dateKey, ev.time || '00:00')}`);
      }

      lines.push(`SUMMARY:${escIcs(ev.title)}`);
      if (ev.location) lines.push(`LOCATION:${escIcs(ev.location)}`);
      if (ev.notes) lines.push(`DESCRIPTION:${escIcs(ev.notes)}`);

      // Recurrence
      if (ev.recurrence && ev.recurrence !== 'none') {
        const rruleMap = {
          daily: 'FREQ=DAILY',
          weekly: 'FREQ=WEEKLY',
          monthly: 'FREQ=MONTHLY',
          yearly: 'FREQ=YEARLY',
        };
        const rrule = rruleMap[ev.recurrence];
        if (rrule) lines.push(`RRULE:${rrule}`);
      }

      // Reminders / VALARM
      if (Array.isArray(ev.reminders)) {
        for (const rem of ev.reminders) {
          const mins = parseInt(rem) || 0;
          lines.push('BEGIN:VALARM');
          lines.push('TRIGGER:-PT' + mins + 'M');
          lines.push('ACTION:DISPLAY');
          lines.push(`DESCRIPTION:Rappel: ${escIcs(ev.title)}`);
          lines.push('END:VALARM');
        }
      }

      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');

  const icsContent = lines.join('\r\n');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kat.ics"');
  res.send(icsContent);
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`KAT v3 running on port ${PORT}`);
  console.log(`App: http://localhost:${PORT}`);
  console.log(`iCal: webcal://localhost:${PORT}/ical`);
});
