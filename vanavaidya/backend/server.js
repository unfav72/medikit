require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const Groq      = require('groq-sdk');
const fetch     = require('node-fetch');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

// Rate limiter — 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Server rate limit reached. Please wait a few minutes.' },
});
app.use('/api/', limiter);
app.use(express.json({ limit: '15mb' }));

// ── Multer (memory storage for images) ──────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'));
  },
});

// ── Groq Client ───────────────────────────────────────────────────────────────
// Groq is 100% FREE — get your key at https://console.groq.com
// Vision model: meta-llama/llama-4-scout-17b-16e-instruct
// Free tier: ~14,400 requests/day, no credit card needed
function getGroqClient() {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your-groq-api-key-here') {
    throw new Error('GROQ_API_KEY is not configured. Get a free key at https://console.groq.com and add it to backend/.env');
  }
  return new Groq({ apiKey: key });
}

// ── Plant Analysis Prompt ────────────────────────────────────────────────────
const PLANT_PROMPT = `You are VanaVaidya, a world-class expert in Indian medicinal plants, Ayurveda, Siddha, and Unani traditional medicine systems. Carefully analyze the plant in this image.

Return ONLY a valid JSON object — no markdown code fences, no explanation, no extra text before or after. Use exactly this structure:

{
  "common_name": "English common name of the plant",
  "scientific_name": "Genus species Author",
  "family": "Plant family name",
  "hindi_name": "Hindi name (transliterated)",
  "tamil_name": "Tamil name (transliterated)",
  "confidence": 88,
  "traditional_system": "Ayurveda / Siddha / Unani (all applicable)",
  "overview": "2-3 sentences describing the plant and its significance in Indian traditional medicine.",
  "active_compounds": "Key bioactive compounds, comma-separated",
  "parts_used": ["leaf", "root", "bark", "flower", "fruit", "seed"],
  "benefits": [
    { "icon": "🫀", "title": "Benefit title", "description": "1-2 sentence explanation." },
    { "icon": "🧠", "title": "Benefit title", "description": "1-2 sentence explanation." },
    { "icon": "🫁", "title": "Benefit title", "description": "1-2 sentence explanation." },
    { "icon": "⚡", "title": "Benefit title", "description": "1-2 sentence explanation." },
    { "icon": "🌿", "title": "Benefit title", "description": "1-2 sentence explanation." }
  ],
  "preparations": [
    { "icon": "☕", "title": "Preparation name", "description": "Step-by-step instructions." },
    { "icon": "🌾", "title": "Preparation name", "description": "Step-by-step instructions." },
    { "icon": "💧", "title": "Preparation name", "description": "Step-by-step instructions." }
  ],
  "dosage": "Safe dosage range with units and frequency",
  "contraindications": "Who should avoid this plant and why.",
  "drug_interactions": "Known interactions with modern medicines, or 'No significant interactions documented.'",
  "conservation_status": "Stable",
  "habitat": "Natural habitat regions in India",
  "harvest_tips": "Best sustainable harvesting practices",
  "regulatory_note": "AYUSH classification or schedule under Drugs and Cosmetics Act"
}

If no plant is visible or identifiable, set "common_name" to "Unidentified / Not a Plant", "confidence" to 0, and use "N/A" for other fields.

Be medically accurate and India-specific.`;

// ── API Route: Analyze Plant Image ───────────────────────────────────────────
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    // Validate image
    if (!req.file && !req.body.imageBase64) {
      return res.status(400).json({ success: false, error: 'No image provided. Please upload a plant image.' });
    }

    let imageBase64, mediaType;

    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
      mediaType   = req.file.mimetype;
    } else {
      const matches = req.body.imageBase64.match(/^data:(.+);base64,(.+)$/);
      if (!matches) return res.status(400).json({ success: false, error: 'Invalid image data format.' });
      mediaType   = matches[1];
      imageBase64 = matches[2];
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(mediaType)) {
      return res.status(400).json({ success: false, error: 'Unsupported format. Use JPEG, PNG, or WEBP.' });
    }

    // ── Call Groq Vision API (Llama-4 Scout) ──────────────────────────────
    const groq = getGroqClient();

    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 2048,
      temperature: 0.2,           // low temperature = more factual, consistent output
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mediaType};base64,${imageBase64}`,
              },
            },
            {
              type: 'text',
              text: PLANT_PROMPT,
            },
          ],
        },
      ],
    });

    const rawText = response.choices[0]?.message?.content || '';

    // Parse JSON — strip any accidental markdown fences
    let plantData;
    try {
      const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      plantData = JSON.parse(cleaned);
    } catch {
      // Fallback: extract first JSON object found
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        plantData = JSON.parse(match[0]);
      } else {
        console.error('[Groq raw response]', rawText.substring(0, 400));
        throw new Error('AI returned an unexpected format. Please try again.');
      }
    }

    return res.json({
      success: true,
      data: plantData,
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      usage: {
        prompt_tokens:     response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens:      response.usage?.total_tokens,
      },
    });

  } catch (err) {
    console.error('[Analyze Error]', err.message);
    const msg    = err.message || '';
    const status = err.status  || err.error?.status || 0;

    if (msg.includes('not configured') || msg.includes('GROQ_API_KEY')) {
      return res.status(500).json({ success: false, error: msg });
    }
    if (status === 401 || msg.includes('Invalid API Key') || msg.includes('401')) {
      return res.status(500).json({ success: false, error: 'Invalid Groq API key. Get a free key at https://console.groq.com' });
    }
    if (status === 429 || msg.includes('rate_limit') || msg.includes('429')) {
      return res.status(429).json({ success: false, error: 'Groq free tier rate limit hit. Please wait a moment and try again.' });
    }
    if (status === 400 || msg.includes('400')) {
      return res.status(400).json({ success: false, error: 'Image could not be processed. Please try a clearer JPEG or PNG photo.' });
    }
    if (status === 503 || msg.includes('503') || msg.includes('overloaded')) {
      return res.status(503).json({ success: false, error: 'Groq servers are busy. Please try again in a moment.' });
    }

    return res.status(500).json({ success: false, error: msg || 'Unexpected error. Please try again.' });
  }
});

// ── OSM Overpass Query ───────────────────────────────────────────────────────
const OVERPASS_QUERY = (lat, lon, radius) => `
[out:json][timeout:25];
(
  node["plant:medicinal"="yes"](around:${radius},${lat},${lon});
  node["medicinal"="yes"](around:${radius},${lat},${lon});
  node["herb_garden"="yes"](around:${radius},${lat},${lon});
  node["shop"="herbalist"](around:${radius},${lat},${lon});
  node["shop"="herbal"](around:${radius},${lat},${lon});
  node["amenity"="herbal_medicine"](around:${radius},${lat},${lon});
  node["landuse"="herb_garden"](around:${radius},${lat},${lon});
  node["leisure"="garden"]["garden:type"="herb"](around:${radius},${lat},${lon});
  node["leisure"="garden"]["garden:type"="botanical"](around:${radius},${lat},${lon});
  way["leisure"="garden"]["garden:type"="botanical"](around:${radius},${lat},${lon});
  node["tourism"="botanical_garden"](around:${radius},${lat},${lon});
  way["tourism"="botanical_garden"](around:${radius},${lat},${lon});
  node["natural"="tree"]["species:en"~"neem|tulsi|ashwagandha|turmeric|amla|brahmi|moringa",i](around:${radius},${lat},${lon});
);
out body;
>;
out skel qt;
`;

// ── Curated Indian Medicinal Plant Hotspots ──────────────────────────────────
const INDIAN_PLANT_HOTSPOTS = [
  { name: "Siddha Medical College Herb Garden",                  lat: 13.0250, lon: 80.2090, type: "herb_garden",      plants: ["Tulsi","Nilavembu","Neem","Brahmi"],           city: "Chennai" },
  { name: "Madras Crocodile Bank Herbal Trail",                  lat: 12.7667, lon: 80.2500, type: "nature_trail",     plants: ["Acalypha","Castor","Calotropis"],               city: "Chennai" },
  { name: "Anna Zoological Park Botanical Section",              lat: 12.9422, lon: 80.1003, type: "botanical_garden", plants: ["Neem","Peepal","Moringa"],                      city: "Chennai" },
  { name: "Guindy National Park",                                lat: 13.0069, lon: 80.2206, type: "forest",           plants: ["Neem","Pungai","Arjuna"],                       city: "Chennai" },
  { name: "Lal Bagh Botanical Garden",                           lat: 12.9507, lon: 77.5848, type: "botanical_garden", plants: ["Ashoka","Amla","Sandalwood","Neem"],            city: "Bangalore" },
  { name: "FRLHT Medicinal Plant Garden",                        lat: 13.0756, lon: 77.5908, type: "herb_garden",      plants: ["Ashwagandha","Shatavari","Brahmi","Guduchi"],   city: "Bangalore" },
  { name: "Sanjay Gandhi National Park Herbal Trail",            lat: 19.2147, lon: 72.9104, type: "forest",           plants: ["Karanj","Neem","Haritaki"],                     city: "Mumbai" },
  { name: "Mumbai Ayurvedic Garden Mahim",                       lat: 19.0459, lon: 72.8394, type: "herb_garden",      plants: ["Tulsi","Aloe Vera","Giloy"],                    city: "Mumbai" },
  { name: "National Botanical Research Institute Garden",        lat: 28.6456, lon: 77.2280, type: "botanical_garden", plants: ["Ashwagandha","Kalmegh","Giloy"],                city: "Delhi" },
  { name: "Delhi Ridge Forest Reserve",                          lat: 28.6692, lon: 77.1457, type: "forest",           plants: ["Neem","Arjuna","Ber"],                          city: "Delhi" },
  { name: "Agharkar Research Institute Herb Garden",             lat: 18.5195, lon: 73.8272, type: "herb_garden",      plants: ["Shatavari","Brahmi","Ashwagandha"],             city: "Pune" },
  { name: "Acharya Jagadish Chandra Bose Indian Botanic Garden", lat: 22.5581, lon: 88.3070, type: "botanical_garden", plants: ["Moringa","Neem","Amla","Tulsi"],                city: "Kolkata" },
  { name: "Tropical Botanical Garden & Research Institute",      lat: 8.7139,  lon: 77.0675, type: "botanical_garden", plants: ["Sandal","Teak","Cardamom","Turmeric"],          city: "Thiruvananthapuram" },
  { name: "Kairali Ayurvedic Garden",                            lat: 10.8505, lon: 76.2711, type: "herb_garden",      plants: ["Brahmi","Ashwagandha","Shatavari","Amla"],      city: "Thrissur" },
  { name: "Sri Sri Ravishankar Herbal Garden",                   lat: 17.4126, lon: 78.5431, type: "herb_garden",      plants: ["Aloe Vera","Tulsi","Neem"],                     city: "Hyderabad" },
  { name: "Medicinal Plants Garden IICT Hyderabad",              lat: 17.4041, lon: 78.5427, type: "research_garden",  plants: ["Kalmegh","Guduchi","Senna"],                    city: "Hyderabad" },
];

const TYPE_META = {
  herb_garden:      { icon: "🌿", label: "Herb Garden",      color: "#5a7a48" },
  botanical_garden: { icon: "🌳", label: "Botanical Garden", color: "#3a7a50" },
  nature_trail:     { icon: "🥾", label: "Nature Trail",     color: "#7a6a30" },
  forest:           { icon: "🌲", label: "Forest Reserve",   color: "#2d5a3d" },
  research_garden:  { icon: "🔬", label: "Research Garden",  color: "#4a5a78" },
  herbalist:        { icon: "⚗️",  label: "Herbalist",       color: "#7a4a30" },
  default:          { icon: "📍", label: "Medicinal Site",   color: "#5a4878" },
};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── API Route: Nearby Medicinal Plants ──────────────────────────────────────
app.get('/api/nearby-plants', async (req, res) => {
  const { lat, lon, radius = 10000 } = req.query;
  if (!lat || !lon) return res.status(400).json({ success: false, error: 'lat and lon are required.' });

  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);
  const searchRadius = Math.min(parseInt(radius), 50000);
  let osmResults = [];

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(OVERPASS_QUERY(userLat, userLon, searchRadius))}`,
      timeout: 20000,
    });
    if (response.ok) {
      const data = await response.json();
      osmResults = (data.elements || []).filter(el => el.lat && el.lon).map(el => {
        const tags = el.tags || {};
        const name = tags.name || tags['name:en'] || tags.brand || 'Medicinal Plant Site';
        const shopType = tags.shop || tags.amenity || tags.leisure || tags.natural || '';
        let type = 'default';
        if (shopType.includes('herb'))                                            type = 'herbalist';
        if (tags['garden:type'] === 'herb')                                       type = 'herb_garden';
        if (tags['garden:type'] === 'botanical' || tags.tourism === 'botanical_garden') type = 'botanical_garden';
        if (tags.landuse === 'forest' || tags.natural === 'tree')                 type = 'forest';
        const meta = TYPE_META[type] || TYPE_META.default;
        return {
          id: `osm-${el.id}`, name, lat: el.lat, lon: el.lon,
          type, icon: meta.icon, label: meta.label, color: meta.color,
          plants: [], distance: haversine(userLat, userLon, el.lat, el.lon),
          source: 'openstreetmap',
          address: [tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || '',
          openingHours: tags.opening_hours || '',
          website: tags.website || tags.url || '',
          phone: tags.phone || tags['contact:phone'] || '',
        };
      });
    }
  } catch (err) {
    console.warn('[Overpass] Failed, using curated fallback:', err.message);
  }

  const osmNames = new Set(osmResults.map(r => r.name.toLowerCase()));
  const curatedNearby = INDIAN_PLANT_HOTSPOTS
    .map(spot => ({
      ...spot,
      id: `curated-${spot.name.replace(/\s+/g, '-')}`,
      distance: haversine(userLat, userLon, spot.lat, spot.lon),
      icon: (TYPE_META[spot.type] || TYPE_META.default).icon,
      label: (TYPE_META[spot.type] || TYPE_META.default).label,
      color: (TYPE_META[spot.type] || TYPE_META.default).color,
      source: 'curated', address: spot.city + ', India',
      openingHours: '', website: '', phone: '',
    }))
    .filter(s => s.distance <= searchRadius / 1000 && !osmNames.has(s.name.toLowerCase()));

  const combined = [...osmResults, ...curatedNearby]
    .sort((a, b) => a.distance - b.distance).slice(0, 40);

  return res.json({ success: true, count: combined.length, searchRadius, userLocation: { lat: userLat, lon: userLon }, plants: combined });
});

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const keyOk = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your-groq-api-key-here');
  res.json({
    status: 'ok', service: 'VanaVaidya API', version: '5.0.0',
    ai_provider: 'Groq — Llama-4 Scout Vision (FREE)',
    apiKeyConfigured: keyOk,
    timestamp: new Date().toISOString(),
  });
});

// ── Serve Frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// ── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'Image too large. Max 10 MB.' });
  console.error('[Unhandled]', err.message);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌿 VanaVaidya v5 running on http://localhost:${PORT}`);
  console.log(`   AI Provider : Groq — Llama-4 Scout 17B Vision (100% FREE)`);
  console.log(`   Free Limits : ~14,400 requests/day · No credit card needed`);
  console.log(`   Get API Key : https://console.groq.com`);
  console.log(`   Map Data    : OpenStreetMap Overpass API + Curated Indian Hotspots`);
  const keyOk = process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your-groq-api-key-here';
  console.log(`   Groq Key    : ${keyOk ? '✓ Configured' : '✗ NOT SET — edit backend/.env'}\n`);
});
