# LLM Debate Arena ⚔️

A real-time debate platform where multiple local LLMs debate a topic through structured rounds, judged by a capable model. All debates are saved locally and can be reviewed anytime.

## Features

- **Multi-Round Debates**: Opening statements → Rebuttals → Closing arguments
- **Parallel Execution**: All debaters run simultaneously for 3x speedup
- **Live Streaming**: Watch the debate unfold in real-time with streaming text
- **Debate History**: All debates auto-saved to localStorage, last 50 kept
- **Organized View**: Switch between rounds with tabs, side-by-side comparison
- **Telegram Notifications**: Get debate results sent to your Telegram via OpenClaw bot
- **Mobile Responsive**: Works seamlessly on phones, tablets, and desktops

## Models

**Debaters:**
- Mistral 7B (4.4GB) — Strong reasoning
- Llama 3.2 3B (2GB) — Fast and efficient
- Qwen 2.5 7B (4.7GB) — Excellent analytical skills

**Judge:**
- Llama 3.1 8B (4.9GB) — Impartial analysis and scoring

**Total Memory:** ~16GB

## Setup

### Prerequisites
- [Ollama](https://ollama.ai) running in WSL
- Node.js v18+ (available in WSL)

### Installation

1. **Pull the required models:**
```bash
wsl ollama pull mistral:latest
wsl ollama pull llama3.2:3b
wsl ollama pull qwen2.5:7b
wsl ollama pull llama3.1:8b
```

2. **Install dependencies:**
```bash
npm install
```

3. **Start the server:**
```bash
# From WSL (recommended - direct access to Ollama)
wsl bash -c "cd /mnt/c/path/to/debate && node server.js"

# Or from Windows if Ollama is exposed
node server.js
```

4. **Open browser:**
```
http://localhost:8000
```

## Telegram Integration

The app integrates with OpenClaw to send debate summaries to your Telegram bot:

1. Configure your Telegram bot token and chat ID in [server.js](server.js#L40-L44)
2. When a debate completes, you'll receive a notification with:
   - Debate topic
   - Participating models
   - Judge's verdict and scoring
   - Link to view full results in browser

To disable Telegram notifications, set `TELEGRAM_CONFIG.enabled = false` in server.js.

## Usage

1. Enter a debate topic (e.g., "Is artificial general intelligence possible within 10 years?")
2. Click "Start Debate" or press Enter
3. Watch as three models debate through structured rounds
4. Read the judge's final verdict and scoring
5. Access past debates from the left sidebar

## Architecture

- **Backend**: Node.js + Express (ESM)
- **Frontend**: Vanilla JS + SSE for streaming
- **LLMs**: Ollama API (`/api/chat` streaming endpoint)
- **Storage**: Browser localStorage (client-side only)

## File Structure

```
debate/
├── server.js           # Express server with SSE streaming
├── templates/
│   └── index.html      # Single-page app with history sidebar
├── package.json        # Dependencies
└── README.md
```

## Performance Optimizations

- **Parallel debaters**: All 3 models generate responses simultaneously per round
- **Streaming**: Text appears as it's generated (no waiting for full response)
- **Lightweight models**: Total memory footprint optimized for consumer hardware
- **WSL integration**: Auto-detects and connects to Ollama in WSL

## License

MIT
