# OpenClaw Skill: LLM Debate

This skill allows you to trigger LLM debates from Telegram via OpenClaw.

## How to Use from Telegram

### Option 1: Tell Claude (via OpenClaw)

Send a message like this to your Telegram bot:
```
Start a debate on: Should AI be regulated?
```

Then add this to your OpenClaw prompts or skills so Claude knows to call the debate API.

### Option 2: Simple HTTP Call Script

Create a bash script that OpenClaw can execute:

```bash
#!/bin/bash
# Save as: ~/.openclaw/skills/debate.sh

DEBATE_TOPIC="$1"
CHAT_ID="${2:-5020580594}"

curl -s -X POST http://localhost:8000/api/telegram-debate \
  -H "Content-Type: application/json" \
  -d "{\"topic\": \"$DEBATE_TOPIC\", \"chatId\": \"$CHAT_ID\"}"
```

Make it executable:
```bash
chmod +x ~/.openclaw/skills/debate.sh
```

Usage:
```bash
~/.openclaw/skills/debate.sh "Should AI be regulated?"
```

### Option 3: Direct cURL from Telegram

When chatting with OpenClaw, ask it to run:
```bash
curl -X POST http://localhost:8000/api/telegram-debate \
  -H "Content-Type: application/json" \
  -d '{"topic": "Your debate topic here", "chatId": "5020580594"}'
```

## API Endpoint

**POST** `http://localhost:8000/api/telegram-debate`

**Body:**
```json
{
  "topic": "Your debate topic",
  "chatId": "5020580594"  // Optional, defaults to configured chat
}
```

**Response:**
```json
{
  "status": "started",
  "topic": "Your debate topic",
  "chatId": "5020580594"
}
```

The debate will run in the background and send updates to your Telegram.

## Example OpenClaw Integration

Add this to your OpenClaw skills or system prompt:

```
When the user asks for a debate or says "debate <topic>", execute:
curl -X POST http://localhost:8000/api/telegram-debate -H "Content-Type: application/json" -d '{"topic": "<topic>", "chatId": "5020580594"}'

Tell them: "Starting debate on: <topic>. You'll receive updates in this chat."
```

## Testing

Test the endpoint:
```bash
curl -X POST http://localhost:8000/api/telegram-debate \
  -H "Content-Type: application/json" \
  -d '{"topic": "Is pineapple on pizza acceptable?", "chatId": "5020580594"}'
```

You should receive Telegram messages with:
- Debate start notification
- Round 1, 2, 3 status updates
- Final judge verdict

## Troubleshooting

- Make sure the debate server is running: `ps aux | grep "node server.js"`
- Check server logs: `wsl bash -c "cd /mnt/c/Users/openclaw/harry/projects/ai/multimodelsprojects/debate && tail -f /tmp/debate.log"`
- Verify Telegram config in server.js: `TELEGRAM_CONFIG.enabled = true`
