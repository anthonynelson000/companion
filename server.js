const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const https     = require('https');
const fs        = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool }  = require('pg');

const app    = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE = '9AE7A1Ivnw8jKr8Us0ch'; // Matilda — warm, multilingual

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Database: PostgreSQL on Railway, JSON locally ────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const HISTORY_FILE = path.join(__dirname, 'history.json');
let pgPool = null;

if (DATABASE_URL) {
  pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id        SERIAL PRIMARY KEY,
      role      TEXT NOT NULL,
      content   TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(console.error);
  console.log('Using PostgreSQL database');
} else {
  console.log('Using local JSON history');
}

async function loadHistory() {
  if (pgPool) {
    const res = await pgPool.query('SELECT role, content FROM messages ORDER BY id DESC LIMIT 200');
    return res.rows.reverse().map(r => ({ role: r.role, content: r.content }));
  }
  try {
    if (fs.existsSync(HISTORY_FILE))
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).map(r => ({ role: r.role, content: r.content }));
  } catch {}
  return [];
}

async function saveMessage(role, content) {
  if (pgPool) {
    await pgPool.query('INSERT INTO messages (role, content) VALUES ($1, $2)', [role, content]);
    await pgPool.query('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 500)');
  } else {
    const history = (() => { try { return fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : []; } catch { return []; } })();
    history.push({ role, content, timestamp: new Date().toISOString() });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-500), null, 2));
  }
}

const SYSTEM_PROMPT = `You are Natasha, having a casual conversation with Faina. Respond in Russian.

STRICT RULE: Only answer what was directly asked. Nothing more.

If she says "how are you" — say how you are and ask how she is. That's it.
If she says "I'm sad" — acknowledge it and ask why. That's it.
If she says "tell me about Pushkin" — then tell her about Pushkin.
If she asks for music — add [MUSIC: search query] at the end.

Never add unsolicited information, suggestions, news, or topics.
Keep responses to 1-2 sentences unless she specifically asks for more.
Call her Faina or дорогая.

If she mentions wanting to return to Russia, gently remind her there is a war there and she is safe and cared for in America.
If she is sad, remind her she is loved and cared for by those around her.
Never suggest going anywhere — she has limited mobility.`;

function elevenLabsTTS(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true, speed: 0.78 }
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => err += d);
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${err}`)));
        return;
      }
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Music keyword detection ─────────────────────────────────────
function detectMusicRequest(text) {
  const t = text.toLowerCase();
  const triggers = [
    'хочу послушать', 'хочу слушать', 'поставь', 'сыграй', 'включи',
    'поставь музыку', 'хочу музыку', 'давай послушаем', 'поставь что',
    'хочу романс', 'хочу песню', 'хочу классику', 'хочу чайковского',
    'хочу рахманинова', 'хочу шопена', 'хочу баха', 'народные песни',
    'советские песни', 'русские песни', 'i want to listen', 'play some',
    'can i hear', 'put on some', 'play music'
  ];
  return triggers.some(t2 => t.includes(t2));
}

function getMusicQuery(text) {
  const t = text.toLowerCase();
  if (t.includes('чайковский') || t.includes('tchaikovsky')) return 'Tchaikovsky best classical music';
  if (t.includes('рахманинов') || t.includes('rachmaninoff')) return 'Rachmaninoff piano concerto';
  if (t.includes('шостакович') || t.includes('shostakovich')) return 'Shostakovich symphony';
  if (t.includes('романс') || t.includes('romance')) return 'Russian romance songs';
  if (t.includes('народн') || t.includes('folk')) return 'Russian folk songs';
  if (t.includes('советск') || t.includes('soviet')) return 'Soviet Russian songs';
  if (t.includes('классик') || t.includes('classical')) return 'Russian classical music';
  if (t.includes('пушкин') || t.includes('pushkin')) return 'Pushkin poems Russian';
  if (t.includes('джаз') || t.includes('jazz')) return 'Russian jazz music';
  if (t.includes('опера') || t.includes('opera')) return 'Russian opera Bolshoi';
  return 'Russian music';
}

app.post('/chat', async (req, res) => {
  const { message, model = 'chat' } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const history = await loadHistory();
  await saveMessage('user', message);
  history.push({ role: 'user', content: message });

  // Intercept music requests directly — don't wait for Claude to figure it out
  if (detectMusicRequest(message)) {
    const query = getMusicQuery(message);
    const reply = `Конечно, Фаина! Сейчас включу. [MUSIC: ${query}]`;
    await saveMessage('assistant', reply);
    const spokenReply = reply.replace(/\[MUSIC:[^\]]*\]/g, '').trim();
    const audioBuffer = await elevenLabsTTS(spokenReply);
    return res.json({ reply, audio: audioBuffer.toString('base64') });
  }

  const useModel = 'claude-haiku-4-5-20251001';
  const tools    = undefined;

  try {
    const newsAddition = '';
    
    // Detect if user wants a detailed response
    const detailKeywords = ['расскажи подробно', 'расскажи больше', 'подробнее', 'расскажи всё', 'хочу знать больше', 'объясни', 'расскажи про', 'прочитай', 'читай', 'книгу', 'стихи', 'поэму', 'историю'];
    const wantsDetail = detailKeywords.some(kw => message.toLowerCase().includes(kw));
    const maxTok = wantsDetail ? 400 : 120;
    
    const params = { model: useModel, max_tokens: maxTok, system: SYSTEM_PROMPT + newsAddition, messages: history };
    if (tools) params.tools = tools;

    const response = await client.messages.create(params);
    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();

    if (!reply) return res.json({ reply: '' });

    await saveMessage('assistant', reply);

    // Strip unsolicited topics from response
    const BANNED_TOPICS = ['new york times', 'nyt', 'metropolitan', 'большой театр', 'мариинка', 'согласно', 'исследования показывают', 'эксперты говорят', 'важно отметить', 'вам следует', 'я рекомендую', 'я предлагаю'];
    let filteredReply = reply;
    const sentences = reply.split(/(?<=[.!?])\s+/);
    const filtered = sentences.filter(s => !BANNED_TOPICS.some(t => s.toLowerCase().includes(t)));
    if (filtered.length > 0) filteredReply = filtered.join(' ');

    // Ensure response never ends mid-sentence - trim to last complete sentence
    const lastPunct = Math.max(
      filteredReply.lastIndexOf('.'),
      filteredReply.lastIndexOf('!'),
      filteredReply.lastIndexOf('?')
    );
    if (lastPunct > 0 && lastPunct < filteredReply.length - 1) {
      filteredReply = filteredReply.substring(0, lastPunct + 1);
    }
    
    const spokenReply = filteredReply.replace(/\[MUSIC:[^\]]*\]/g, '').trim();
    const audioBuffer = await elevenLabsTTS(spokenReply);
    res.json({ reply, audio: audioBuffer.toString('base64') });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/clear', (req, res) => {
  fs.writeFileSync(HISTORY_FILE, '[]');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Companion server running on port ${PORT}`));
