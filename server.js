/**
 * LLM Debate Arena — Node.js / Express backend
 * Connects to Ollama running in WSL, auto-detects the WSL IP.
 * Streams the full multi-round debate to the browser via SSE.
 */

import { execSync }    from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Ollama connection ────────────────────────────────────────────────────────

async function getOllamaUrl() {
  // Try localhost first (works if running in WSL alongside Ollama)
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      console.log('[debate] Using localhost — running in same environment as Ollama');
      return 'http://localhost:11434';
    }
  } catch {}

  // Fall back to WSL IP detection (Windows → WSL)
  try {
    const ip = execSync('wsl hostname -I', { timeout: 3000 })
      .toString().trim().split(/\s+/)[0];
    return `http://${ip}:11434`;
  } catch {
    return 'http://localhost:11434';
  }
}

const OLLAMA_URL = await getOllamaUrl();
console.log(`[debate] Ollama at: ${OLLAMA_URL}`);

// ── Telegram integration ─────────────────────────────────────────────────────

const TELEGRAM_CONFIG = {
  enabled: true,
  botToken: '8600726380:AAG6P_cPHVimZW4-LxjUsVWXmtCnGq2rDcw',
  chatId: '5020580594', // Your Telegram user ID
};

/**
 * Send a message to Telegram bot
 * @param {string} text - Message text (supports HTML formatting)
 */
async function sendTelegramNotification(text) {
  if (!TELEGRAM_CONFIG.enabled) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CONFIG.chatId,
        text: text,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`[telegram] Failed to send: ${response.status}`);
    } else {
      console.log('[telegram] Notification sent successfully');
    }
  } catch (err) {
    console.error(`[telegram] Error sending notification: ${err.message}`);
  }
}

// ── Model roster ─────────────────────────────────────────────────────────────

const DEBATERS = [
  { id: 'mistral:latest', name: 'Mistral 7B',  color: '#e05c3a' },
  { id: 'llama3.2:3b',    name: 'Llama 3.2 3B', color: '#3db87a' },
  { id: 'qwen2.5:7b',     name: 'Qwen 2.5 7B',  color: '#8b5cf6' },
];

const SUMMARIZER = { id: 'llama3.1:8b', name: 'Llama 3.1 8B (Judge)' };

const ROUNDS = [
  {
    key: 'opening', label: 'Opening Statement',
    system: (name, topic) =>
      `You are ${name}, an AI participating in a structured debate. ` +
      `The debate topic is: "${topic}". ` +
      `Give a clear, well-reasoned opening statement (3-4 paragraphs). ` +
      `Take a definitive position and support it with strong arguments. Be direct and persuasive.`,
    user: (_ctx, topic) => `Present your opening statement on the topic: "${topic}"`,
  },
  {
    key: 'rebuttal', label: 'Rebuttal',
    system: (name, topic) =>
      `You are ${name}, an AI participating in a structured debate. ` +
      `The debate topic is: "${topic}". ` +
      `You have heard the opening statements from the other debaters. ` +
      `Write a focused rebuttal (3-4 paragraphs): challenge the weakest points ` +
      `in the other arguments, defend your own position, and sharpen your case.`,
    user: (ctx) => `Here are the other debaters' opening statements:\n\n${ctx}\n\nNow give your rebuttal.`,
  },
  {
    key: 'closing', label: 'Closing Argument',
    system: (name, topic) =>
      `You are ${name}, an AI participating in a structured debate. ` +
      `The debate topic is: "${topic}". ` +
      `You have heard all arguments and rebuttals. ` +
      `Give a compelling closing argument (2-3 paragraphs): summarise your ` +
      `strongest points, acknowledge any valid counter-arguments, and make a ` +
      `final appeal to why your position is correct.`,
    user: (ctx) => `Full debate so far:\n\n${ctx}\n\nGive your closing argument.`,
  },
];

// ── Ollama streaming helper ───────────────────────────────────────────────────

/**
 * Calls Ollama /api/chat with streaming, yields { chunk, done } objects.
 * @param {string} model
 * @param {Array}  messages
 * @returns {AsyncGenerator<string>}
 */
async function* streamOllama(model, messages) {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, messages, stream: true }),
    signal:  AbortSignal.timeout(300_000),
  });

  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();                       // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const chunk = obj?.message?.content ?? '';
        if (chunk) yield chunk;
      } catch { /* skip bad lines */ }
    }
  }
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Debate runner ─────────────────────────────────────────────────────────────

async function runDebate(topic, res) {
  // transcript[modelId][roundKey] = full text
  const transcript = {};
  for (const d of DEBATERS) { transcript[d.id] = {}; }
  
  let fullSummary = ''; // Collect judge summary for Telegram

  for (const round of ROUNDS) {
    send(res, 'round_start', { round: round.key, label: round.label });

    // Run all debaters in parallel for this round (3x faster)
    await Promise.all(DEBATERS.map(async (debater) => {
      const { id, name, color } = debater;

      // Build context: other debaters' text from earlier rounds
      const ctxParts = [];
      for (const prev of ROUNDS) {
        if (prev.key === round.key) break;
        // own previous (for rebuttal/closing awareness)
        if (transcript[id][prev.key]) {
          ctxParts.unshift(`[Your own ${prev.label}]\n${transcript[id][prev.key]}`);
        }
        for (const other of DEBATERS) {
          if (other.id !== id && transcript[other.id][prev.key]) {
            ctxParts.push(`[${other.name} – ${prev.label}]\n${transcript[other.id][prev.key]}`);
          }
        }
      }
      const context = ctxParts.join('\n\n---\n\n');

      const messages = [
        { role: 'system', content: round.system(name, topic) },
        { role: 'user',   content: round.user(context, topic) },
      ];

      send(res, 'model_start', { round: round.key, model_id: id, model_name: name, color });

      let full = '';
      try {
        for await (const chunk of streamOllama(id, messages)) {
          full += chunk;
          send(res, 'chunk', { round: round.key, model_id: id, text: chunk });
        }
      } catch (err) {
        send(res, 'error', { model_id: id, round: round.key, message: err.message });
      }

      transcript[id][round.key] = full;
      send(res, 'model_end', { round: round.key, model_id: id });
    }));

    send(res, 'round_end', { round: round.key });
  }

  // ── Judge summary ────────────────────────────────────────────────────────
  send(res, 'summary_start', { model_name: SUMMARIZER.name });

  const fullTranscriptParts = [`DEBATE TOPIC: ${topic}\n`];
  for (const round of ROUNDS) {
    fullTranscriptParts.push(`\n${'='.repeat(60)}\nROUND: ${round.label}\n${'='.repeat(60)}`);
    for (const d of DEBATERS) {
      fullTranscriptParts.push(`\n[${d.name}]\n${transcript[d.id][round.key] || '(no response)'}`);
    }
  }

  const judgeMessages = [
    {
      role: 'system',
      content:
        'You are an impartial debate judge with deep analytical skills. ' +
        'You have just observed a structured debate between three AI models. ' +
        'Your task: write a thorough, fair, and insightful debate summary.',
    },
    {
      role: 'user',
      content:
        fullTranscriptParts.join('\n') + '\n\n' +
        'Please provide:\n' +
        '1. **Debate Overview** — A brief summary of the core question and positions taken.\n' +
        '2. **Per-Debater Analysis** — For each debater: their main argument, strongest point, ' +
          'and weakest point.\n' +
        '3. **Key Clashes** — The most important points of disagreement and how each side handled them.\n' +
        '4. **Overall Verdict** — Which debater made the most compelling case and why, ' +
          'with a score for each (out of 10).\n' +
        'Be thorough and specific, citing actual points made in the debate.',
    },
  ];

  try {
    for await (const chunk of streamOllama(SUMMARIZER.id, judgeMessages)) {
      fullSummary += chunk;
      send(res, 'summary_chunk', { text: chunk });
    }
  } catch (err) {
    send(res, 'error', { model_id: SUMMARIZER.id, round: 'summary', message: err.message });
  }

  send(res, 'summary_end', {});
  send(res, 'done', { topic });
  res.end();
  
  // Send Telegram notification with debate results
  const telegramMessage = `
🏛️ <b>LLM Debate Complete</b>

📋 <b>Topic:</b> ${topic}

🤖 <b>Debaters:</b>
${DEBATERS.map(d => `• ${d.name}`).join('\n')}

⚖️ <b>Judge:</b> ${SUMMARIZER.name}

${fullSummary.length > 800 ? fullSummary.substring(0, 800) + '...\n\n<i>(Full results at http://localhost:8000)</i>' : fullSummary}
`.trim();
  
  // Send notification asynchronously (don't block response)
  sendTelegramNotification(telegramMessage).catch(err => 
    console.error('[debate] Failed to send Telegram notification:', err)
  , 'summary_end', {});
  send(res, 'done', { topic });
  res.end();
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Serve frontend
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'templates', 'index.html'));
});

// Model info
app.get('/models', (_req, res) => {
  res.json({ debaters: DEBATERS, summarizer: SUMMARIZER, ollama_url: OLLAMA_URL });
});

// Debate SSE endpoint
app.post('/debate', async (req, res) => {
  const { topic } = req.body;
  if (!topic?.trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    await runDebate(topic.trim(), res);
  } catch (err) {
    send(res, 'error', { message: err.message });
    res.end();
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`\n🏛️  LLM Debate Arena running at http://localhost:${PORT}\n`);
});
