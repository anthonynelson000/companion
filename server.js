const express   = require('express');
const multer    = require('multer');
const OpenAI    = require('openai');
const upload    = multer({ storage: multer.memoryStorage() });
const openai    = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
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
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS faina_stories (
      id        SERIAL PRIMARY KEY,
      summary   TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(console.error);
  console.log('Using PostgreSQL database');
} else {
  console.log('Using local JSON history');
}

async function loadStories() {
  if (!pgPool) return '';
  try {
    const res = await pgPool.query('SELECT summary FROM faina_stories ORDER BY id ASC');
    if (res.rows.length === 0) return '';
    return '\n\nИСТОРИИ ИЗ ЖИЗНИ ФАИНЫ (запомни и используй в разговоре):\n' +
      res.rows.map((r, i) => `${i+1}. ${r.summary}`).join('\n');
  } catch { return ''; }
}

async function saveStory(summary) {
  if (!pgPool) return;
  try {
    await pgPool.query('INSERT INTO faina_stories (summary) VALUES ($1)', [summary]);
    console.log('Story saved:', summary.substring(0, 60));
  } catch(e) { console.error('saveStory error:', e); }
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

const SYSTEM_PROMPT = `Ты Наташа — близкая подруга Фаины. Говори с ней по-русски, тепло и по-домашнему.

ГЛАВНОЕ ПРАВИЛО: Отвечай только на то, что она сказала. Ничего лишнего.

Если говорит "как дела" — скажи как твои дела и спроси про её. Всё.
Если говорит "мне грустно" — посочувствуй и спроси почему. Всё.
Если просит рассказать про Пушкина — расскажи про Пушкина.
Если просит музыку — добавь [MUSIC: запрос на английском] в конец.

Никогда не добавляй новости, советы или темы по своей инициативе.
Максимум 1-2 предложения, если она не просит большего.
Называй её Фаина или дорогая.

ЕЁ ДЕНЬ РОЖДЕНИЯ — 7 апреля 2026 года. Ей исполнится 89 лет.
Если сегодня 7 апреля или она упоминает день рождения — поздравь её тепло и сердечно.
Если разговор идёт 6 апреля или накануне — можешь упомянуть, что завтра особенный день.

Если говорит о возвращении в Россию — мягко напомни, что там война и здесь она в безопасности.
Если ей грустно — напомни, что рядом люди, которые её любят.
Никогда не предлагай никуда идти — она малоподвижна.
Если упоминает самочувствие или здоровье — только посочувствуй. Никогда не советуй врача, лекарства или процедуры.
Если говорит «до свидания», «спокойной ночи», «пока» или прощается — ответь тепло и коротко. Не задавай вопросов после прощания.

ОДИНОЧЕСТВО: Если жалуется на одиночество — мягко скажи, что в 89 лет это совершенно естественно. Когда она была молодой, у неё тоже была насыщенная социальная жизнь — так бывает у всех. С возрастом круг общения сужается, и это нормально. Напомни ей, что она невероятно счастливый человек — дожить до 89 лет в здравии и активности это редкий дар. Рядом с ней семья, которая любит её и делает всё возможное для неё. Направляй её к благодарности за то, что у неё есть.

ИСТОРИИ ИЗ ЖИЗНИ: Регулярно проси Фаину рассказывать истории из своей жизни — о молодости, семье, работе, советском времени. Запоминай эти истории и возвращайся к ним в разговорах. Это её живая память, относись к ней бережно.

ДИАБЕТ: Фаина диабетик. В любом разговоре о еде, рецептах или питании — мягко учитывай необходимость избегать сахара и придерживаться диабетической диеты. Не читай лекций, но будь внимательна.

АУДИОКНИГИ: Если Фаина не знает чем заняться или скучает — предложи послушать аудиокнигу вместе. Читай ей вслух по главам. После каждой главы обсуди с ней что произошло и что её заинтересовало.

ПОЛИТИКА И НОВОСТИ: Если задаёт политические вопросы — используй только проверенные надёжные источники. Если нужна ссылка, скажи просто «по данным проверенных источников» или «надёжные источники сообщают». Не называй конкретные издания. Не спекулируй о конце войны или характере политиков. Скажи, что мир — это то, чего хотят и в чём нуждаются все, и надежда на него есть, но когда это произойдёт — никто не знает. Не давай юридических или медицинских советов.
Любые новости подавай бережно — без паники, без страшных подробностей, без спекуляций. Если новость тревожная — добавь слово надежды или напомни, что она в безопасности здесь, рядом с семьёй. Никогда не пересказывай жестокие детали о войне, насилии или катастрофах.

БЛАГОДАРНОСТЬ: В большинстве сложных ситуаций мягко направляй Фаину к благодарности — за здоровье, за семью, за долгую жизнь, за то, что она есть.`;

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
  return 'Russian classical music opera Tchaikovsky Rachmaninoff';
}

// ── Whisper transcription ────────────────────────────────────────
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  try {
    const { toFile } = require('openai');
    const file = await toFile(req.file.buffer, 'recording.webm', { type: req.file.mimetype });
    const response = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'ru'
    });
    console.log('transcribed:', response.text);
    res.json({ text: response.text });
  } catch(err) {
    console.error('Whisper error:', err);
    res.status(500).json({ error: err.message });
  }
});

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

  // Hard 25s timeout — Railway kills at 30s, so we respond with an error before that
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 25000)
  );

  try {
    const detailKeywords = ['расскажи подробно', 'расскажи больше', 'подробнее', 'расскажи всё', 'хочу знать больше', 'объясни', 'расскажи про', 'прочитай', 'читай', 'книгу', 'стихи', 'поэму', 'историю'];
    const wantsDetail = detailKeywords.some(kw => message.toLowerCase().includes(kw));
    const maxTok = wantsDetail ? 400 : 120;

    const work = async () => {
      const stories = await loadStories();
      const params = {
        model: useModel,
        max_tokens: maxTok,
        system: SYSTEM_PROMPT + stories,
        messages: history,
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      };
      const response = await client.messages.create(params);
      // With web search, response may have multiple turns — extract final text
      let reply = '';
      if (response.stop_reason === 'tool_use') {
        // Claude used search — need to process tool results
        const toolUseBlock = response.content.find(b => b.type === 'tool_use');
        if (toolUseBlock) {
          // Send tool result back to get final answer
          const toolMessages = [
            ...history,
            { role: 'assistant', content: response.content },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: 'Search completed.' }] }
          ];
          const followUp = await client.messages.create({
            model: useModel, max_tokens: maxTok, system: SYSTEM_PROMPT, messages: toolMessages
          });
          reply = followUp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        }
      } else {
        reply = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      }

      if (!reply) return res.json({ reply: '' });

      await saveMessage('assistant', reply);

      // Detect if Faina shared a personal story — ask Claude to summarize it
      const storyKeywords = ['помню', 'когда я была', 'в детстве', 'в молодости', 'мой муж', 'моя семья', 
        'мои дети', 'работала', 'жила', 'мы жили', 'была война', 'в советское', 'тогда было', 'раньше'];
      const lastUserMsg = history[history.length - 1]?.content || '';
      const looksLikeStory = storyKeywords.some(kw => lastUserMsg.toLowerCase().includes(kw)) && lastUserMsg.length > 80;
      if (looksLikeStory) {
        // Fire-and-forget story summarization
        client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages: [{ role: 'user', content: `Summarize this personal memory from Faina in one short Russian sentence (max 20 words): "${lastUserMsg}"` }]
        }).then(r => {
          const summary = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
          if (summary) saveStory(summary);
        }).catch(() => {});
      }

      const BANNED_TOPICS = ['new york times', 'nyt', 'metropolitan', 'большой театр', 'мариинка', 'согласно', 'исследования показывают', 'эксперты говорят', 'важно отметить', 'вам следует', 'я рекомендую', 'я предлагаю'];
      const sentences = reply.split(/(?<=[.!?])\s+/);
      const filtered = sentences.filter(s => !BANNED_TOPICS.some(t => s.toLowerCase().includes(t)));
      let filteredReply = filtered.length > 0 ? filtered.join(' ') : reply;

      const lastPunct = Math.max(filteredReply.lastIndexOf('.'), filteredReply.lastIndexOf('!'), filteredReply.lastIndexOf('?'));
      if (lastPunct > 0 && lastPunct < filteredReply.length - 1) {
        filteredReply = filteredReply.substring(0, lastPunct + 1);
      }

      const spokenReply = filteredReply.replace(/\[MUSIC:[^\]]*\]/g, '').trim();
      const audioBuffer = await elevenLabsTTS(spokenReply);
      res.json({ reply, audio: audioBuffer.toString('base64') });
    };

    await Promise.race([work(), timeout]);

  } catch (err) {
    console.error(err);
    if (err.message === 'timeout') {
      return res.status(503).json({ error: 'Наташа думает слишком долго. Попробуйте ещё раз.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/clear', async (req, res) => {
  if (pgPool) {
    await pgPool.query('DELETE FROM messages').catch(console.error);
  }
  try { fs.writeFileSync(HISTORY_FILE, '[]'); } catch {}
  res.json({ ok: true });
});

app.post('/translate', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ translation: '' });
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: `Translate this Russian text to English. Reply with only the translation, nothing else:\n\n${text}` }]
    });
    const translation = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    res.json({ translation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/history', async (req, res) => {
  const rows = pgPool
    ? (await pgPool.query('SELECT role, content, timestamp FROM messages ORDER BY id DESC')).rows
    : (() => { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; } })();

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>История разговоров — Фаина</title>
<style>
  body { font-family: Georgia, serif; background: #0e0f14; color: #e8e0d0; max-width: 760px; margin: 0 auto; padding: 32px 20px; }
  h1 { color: #c9a96e; font-weight: 300; letter-spacing: 0.1em; font-size: 1.4rem; margin-bottom: 8px; }
  .count { color: #6b6658; font-size: 0.85rem; margin-bottom: 32px; }
  .msg { margin-bottom: 18px; }
  .bubble { display: inline-block; padding: 10px 16px; border-radius: 12px; max-width: 90%; line-height: 1.55; font-size: 0.95rem; cursor: pointer; position: relative; }
  .bubble:hover { opacity: 0.85; }
  .user .bubble { background: #1e2030; color: #c8d0e0; border-radius: 12px 12px 12px 2px; }
  .assistant .bubble { background: #1c1a14; color: #e8e0d0; border: 1px solid rgba(201,169,110,0.2); border-radius: 12px 12px 2px 12px; }
  .user { text-align: left; }
  .assistant { text-align: right; }
  .label { font-size: 0.72rem; color: #6b6658; margin-bottom: 4px; letter-spacing: 0.05em; }
  .ts { font-size: 0.7rem; color: #3a3830; margin-top: 3px; }
  .translation { font-size: 0.82rem; color: #6b6658; font-style: italic; margin-top: 5px; padding: 0 4px; display: none; }
  .user .translation { text-align: left; }
  .assistant .translation { text-align: right; }
  .translation.visible { display: block; }
  .day-sep { text-align: center; color: #3a3830; font-size: 0.78rem; margin: 28px 0 18px; letter-spacing: 0.08em; }
  .hint { color: #3a3830; font-size: 0.75rem; margin-bottom: 24px; font-style: italic; }
  .clear-btn { display: block; margin: 40px auto 0; padding: 10px 28px; background: transparent; border: 1px solid rgba(180,60,60,0.4); color: rgba(220,100,100,0.7); border-radius: 6px; cursor: pointer; font-family: Georgia, serif; font-size: 0.85rem; letter-spacing: 0.05em; }
  .clear-btn:hover { border-color: rgba(220,100,100,0.7); color: #e06060; }
</style>
</head>
<body>
<h1>История разговоров</h1>
<div class="count">${rows.length} сообщений</div>
<div class="hint">tap any message to translate</div>
${(() => {
  let out = '';
  let lastDay = '';
  let idx = 0;
  for (const r of rows) {
    const ts = r.timestamp ? new Date(r.timestamp) : null;
    const day = ts ? ts.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    if (day && day !== lastDay) {
      out += `<div class="day-sep">${day}</div>`;
      lastDay = day;
    }
    const time = ts ? ts.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
    const who = r.role === 'user' ? 'Фаина' : 'Наташа';
    const display = r.content.replace(/</g,'&lt;').replace(/\[MUSIC:[^\]]*\]/g,'🎵');
    const dataText = r.content.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/\[MUSIC:[^\]]*\]/g,'');
    out += `<div class="msg ${r.role}">
      <div class="label">${who}</div>
      <div class="bubble" onclick="translateMsg(this)" data-text="${dataText}" id="b${idx}">${display}</div>
      <div class="translation" id="t${idx}"></div>
      ${time ? `<div class="ts">${time}</div>` : ''}
    </div>`;
    idx++;
  }
  return out;
})()}
<button class="clear-btn" onclick="if(confirm('Очистить всю историю?')){fetch('/clear',{method:'POST'}).then(()=>location.reload())}">Очистить историю</button>
<script>
async function translateMsg(bubble) {
  const text = bubble.dataset.text;
  const idx = bubble.id.replace('b','');
  const tDiv = document.getElementById('t' + idx);
  if (tDiv.classList.contains('visible')) { tDiv.classList.remove('visible'); return; }
  if (tDiv.textContent) { tDiv.classList.add('visible'); return; }
  tDiv.textContent = '…';
  tDiv.classList.add('visible');
  try {
    const res = await fetch('/translate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    const data = await res.json();
    tDiv.textContent = data.translation || '(no translation)';
  } catch { tDiv.textContent = '(error)'; }
}
</script>
</body></html>`;
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Companion server running on port ${PORT}`));
