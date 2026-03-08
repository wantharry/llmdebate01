#!/bin/bash
curl -X POST http://localhost:8000/api/telegram-debate \
  -H "Content-Type: application/json" \
  -d '{"topic": "Test: Quick debate - Is TypeScript better than JavaScript?", "chatId": "5020580594"}'
