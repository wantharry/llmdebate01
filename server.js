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
  allowedUsers: ['5020580594'], // User IDs allowed to start debates
  enablePolling: false, // Set to true only if OpenClaw gateway is stopped
};

let telegramOffset = 0; // Track last processed update
const activeDebates = new Map(); // Track active debates per chat

/**
 * Send a message to Telegram
 * @param {string} chatId - Chat ID to send to
 * @param {string} text - Message text (supports HTML formatting)
 */
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_CONFIG.enabled) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`[telegram] Failed to send to ${chatId}: ${response.status}`);
    }
  } catch (err) {
    console.error(`[telegram] Error sending message: ${err.message}`);
  }
}

/**
 * Convenience wrapper for sending to default chat
 */
async function sendTelegramNotification(text) {
  return sendTelegramMessage(TELEGRAM_CONFIG.chatId, text);
}

/**
 * Poll for Telegram updates
 */
async function pollTelegramUpdates() {
  if (!TELEGRAM_CONFIG.enabled || !TELEGRAM_CONFIG.enablePolling) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/getUpdates`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: telegramOffset,
        timeout: 30, // Long polling timeout
        allowed_updates: ['message'],
      }),
      signal: AbortSignal.timeout(35000),
    });

    if (!response.ok) {
      console.error(`[telegram] Polling error: ${response.status}`);
      return;
    }

    const data = await response.json();
    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      telegramOffset = update.update_id + 1;
      await handleTelegramUpdate(update);
    }
  } catch (err) {
    console.error(`[telegram] Polling exception: ${err.message}`);
  } finally {
    // Continue polling
    setTimeout(pollTelegramUpdates, 1000);
  }
}

/**
 * Handle incoming Telegram message
 */
async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id.toString();
  const userId = message.from.id.toString();
  const text = message.text.trim();

  console.log(`[telegram] Message from ${userId}: ${text}`);

  // Check authorization
  if (!TELEGRAM_CONFIG.allowedUsers.includes(userId)) {
    await sendTelegramMessage(chatId, '❌ Unauthorized. Contact the bot owner.');
    return;
  }

  // Handle commands
  if (text.startsWith('/start')) {
    await sendTelegramMessage(chatId, 
      '🏛️ <b>LLM Debate Arena Bot</b>\n\n' +
      'Start a debate with:\n' +
      '<code>/debate Your debate topic here</code>\n\n' +
      'Example:\n' +
      '<code>/debate Should AI be regulated?</code>\n\n' +
      '💡 The debate will run through 3 rounds with live updates!'
    );
    return;
  }

  if (text.startsWith('/debate ')) {
    const topic = text.substring(8).trim();
    if (!topic) {
      await sendTelegramMessage(chatId, '❌ Please provide a debate topic.\nExample: <code>/debate Should AI be regulated?</code>');
      return;
    }

    // Check if debate already running for this chat
    if (activeDebates.has(chatId)) {
      await sendTelegramMessage(chatId, '⏳ A debate is already running in this chat. Please wait for it to finish.');
      return;
    }

    // Start the debate
    activeDebates.set(chatId, { topic, startTime: Date.now() });
    await sendTelegramMessage(chatId, 
      `🏛️ <b>Starting Debate</b>\n\n` +
      `📋 <b>Topic:</b> ${topic}\n\n` +
      `🤖 <b>Debaters:</b>\n${DEBATERS.map(d => `• ${d.name}`).join('\n')}\n\n` +
      `⚖️ <b>Judge:</b> ${SUMMARIZER.name}\n\n` +
      `⏳ Starting round 1...`
    );

    try {
      await runDebateForTelegram(topic, chatId);
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ <b>Error:</b> ${err.message}`);
      console.error(`[telegram] Debate error:`, err);
    } finally {
      activeDebates.delete(chatId);
    }
    return;
  }

  if (text.startsWith('/')) {
    await sendTelegramMessage(chatId, '❓ Unknown command. Use /start to see available commands.');
  }
}

/**
 * Run a debate and send results to Telegram
 * @param {string} topic - Debate topic
 * @param {string} chatId - Telegram chat ID
 */
async function runDebateForTelegram(topic, chatId) {
  const transcript = {};
  for (const d of DEBATERS) { transcript[d.id] = {}; }
  
  let fullSummary = '';

  // Run through each round
  for (let i = 0; i < ROUNDS.length; i++) {
    const round = ROUNDS[i];
    
    await sendTelegramMessage(chatId, `🔄 <b>Round ${i + 1}: ${round.label}</b>`);

    // Run all debaters in parallel
    await Promise.all(DEBATERS.map(async (debater) => {
      const { id, name } = debater;

      // Build context from previous rounds
      const ctxParts = [];
      for (const prev of ROUNDS) {
        if (prev.key === round.key) break;
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

      let full = '';
      try {
        for await (const chunk of streamOllama(id, messages)) {
          full += chunk;
        }
        transcript[id][round.key] = full;
      } catch (err) {
        console.error(`[telegram-debate] ${name} error in ${round.key}:`, err);
        transcript[id][round.key] = `(Error: ${err.message})`;
      }
    }));

    await sendTelegramMessage(chatId, `✅ Round ${i + 1} complete`);
  }

  // Judge summary
  await sendTelegramMessage(chatId, `⚖️ <b>Judge is deliberating...</b>`);

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
        '2. **Per-Debater Analysis** — For each debater: their main argument, strongest point, and weakest point.\n' +
        '3. **Key Clashes** — The most important points of disagreement and how each side handled them.\n' +
        '4. **Overall Verdict** — Which debater made the most compelling case and why, with a score for each (out of 10).\n' +
        'Be thorough and specific, citing actual points made in the debate.',
    },
  ];

  try {
    for await (const chunk of streamOllama(SUMMARIZER.id, judgeMessages)) {
      fullSummary += chunk;
    }
  } catch (err) {
    fullSummary = `Error generating summary: ${err.message}`;
  }

  // Send final verdict
  const finalMessage = `
🏛️ <b>Debate Complete!</b>

📋 <b>Topic:</b> ${topic}

⚖️ <b>Judge's Verdict:</b>

${fullSummary.length > 3500 ? fullSummary.substring(0, 3500) + '...\n\n<i>(Summary truncated. View full details at http://localhost:8000)</i>' : fullSummary}
`.trim();

  await sendTelegramMessage(chatId, finalMessage);
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
  );
  
  send(res, 'summary_end', {});
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

// Telegram webhook endpoint (for OpenClaw or external triggers)
app.post('/api/telegram-debate', async (req, res) => {
  const { topic, chatId } = req.body;
  
  if (!topic?.trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }
  
  const targetChatId = chatId || TELEGRAM_CONFIG.chatId;
  
  // Start debate asynchronously
  res.json({ status: 'started', topic, chatId: targetChatId });
  
  try {
    await runDebateForTelegram(topic.trim(), targetChatId);
  } catch (err) {
    await sendTelegramMessage(targetChatId, `❌ <b>Error:</b> ${err.message}`);
    console.error('[telegram-debate] Error:', err);
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`\n🏛️  LLM Debate Arena running at http://localhost:${PORT}\n`);
  
  // Start Telegram bot polling (only if OpenClaw is not running)
  if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.enablePolling) {
    console.log('📱 Starting Telegram bot polling...');
    console.log(`   Bot: @Coolio007_bot`);
    console.log(`   Allowed users: ${TELEGRAM_CONFIG.allowedUsers.join(', ')}`);
    console.log(`   Commands: /start, /debate <topic>\n`);
    pollTelegramUpdates();
  } else if (TELEGRAM_CONFIG.enabled) {
    console.log('📱 Telegram notifications enabled (polling disabled - use webhook or OpenClaw integration)');
    console.log(`   To enable direct polling, stop OpenClaw gateway and set enablePolling: true\n`);
  }
});
