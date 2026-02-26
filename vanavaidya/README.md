# 🌿 VanaVaidya — AI Medicinal Plant Finder

> Identify Indian medicinal plants using **Groq Llama-4 Scout Vision** — 100% FREE, no credit card needed.
> Also shows nearby medicinal plant sites on a live map.

---

## ✅ Why Groq?

| Feature | Groq Free Tier |
|---|---|
| Cost | **$0 — completely free** |
| Credit card | ❌ Not required |
| Daily limit | ~14,400 requests/day |
| Speed | Ultra-fast (LPU inference) |
| Model | Llama-4 Scout 17B (vision) |

Get your free API key at: **https://console.groq.com**

---

## 📁 Project Structure

```
vanavaidya/
├── backend/
│   ├── server.js     ← Express API server (Groq key lives here)
│   ├── package.json
│   ├── .env          ← Your Groq API key (never commit this!)
│   └── .gitignore
└── frontend/
    └── index.html    ← Full UI: Plant Scanner + Nearby Plants Map
```

---

## 🚀 Quick Start

```bash
# 1. Install
cd backend
npm install

# 2. Add your FREE Groq key to .env
#    GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
#    Get it at: https://console.groq.com

# 3. Start
npm start

# 4. Open http://localhost:3000
```

---

## 🔌 API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/analyze` | Analyze plant image with Groq Vision AI |
| `GET`  | `/api/nearby-plants` | Find medicinal plant sites near you |
| `GET`  | `/api/health` | Server + key status |

---

## 📜 Disclaimer

For educational purposes only. Consult a qualified Ayurvedic practitioner before using any medicinal plant.
