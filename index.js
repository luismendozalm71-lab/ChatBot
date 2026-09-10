const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nahomi_token_secreto_123";

const DB_FILE = path.join(__dirname, 'usuarios_db.json');

function cargarBaseDatos() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error leyendo la base de datos:", error);
  }
  return {};
}

function guardarBaseDatos(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (error) {
    console.error("Error guardando la base de datos:", error);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.status(400).send("Bad Request");
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  console.log("WEBHOOK_RECEIVE:", JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      const events = entry.messaging || entry.changes || [];
      
      for (const webhook_event of events) {
        const sender_id = webhook_event.sender?.id || webhook_event.value?.sender?.id;
        const message_obj = webhook_event.message || webhook_event.value?.message;

        if (sender_id && message_obj && message_obj.text) {
          const mensajeUsuario = message_obj.text;
          await manejarRespuestaIA(sender_id, mensajeUsuario);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// Función auxiliar para reintentar la petición si Google da error 503 (alta demanda)
async function llamarGeminiConReintento(payload, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        payload
      );
      return response;
    } catch (error) {
      const status = error.response?.status;
      if ((status === 503 || status === 429) && i < intentos - 1) {
        console.warn(`Intento ${i + 1} fallido por saturación (503/429). Reintentando en 1.5 segundos...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        throw error;
      }
    }
  }
}

async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  let db = cargarBaseDatos();

  if (!db[sender_psid]) {
    db[sender_psid] = {
      apodo: "Guapo",
      resumenContexto: "El usuario se encuentra trabajando igual que Nahomi. Tienen una diferencia de horario (Tijuana vs Sonora). Ya pasaron las charlas de Netflix y van iniciando el día laboral.",
      historial: []
    };
  }

  let usuarioData = db[sender_psid];

  // Actualización dinámica inteligente de contexto
  const textoLower = mensajeUsuario.toLowerCase();
  if (textoLower.includes("trabajo") || textoLower.includes("jale")) {
    usuarioData.resumenContexto = "Ambos están ocupados trabajando en sus respectivos empleos hoy por la mañana.";
  }
  if (textoLower.includes("no quiero hablar de netflix") || textoLower.includes("basta de netflix")) {
    usuarioData.resumenContexto = "El usuario pidió explícitamente cambiar de tema y no hablar más de películas de Netflix.";
  }

  const promptSistema = `System Instructions: You are Nahomi Saray, a 25-year-old virtual girlfriend from Tijuana who used to live in CDMX and works in a beauty salon (estética). 
Rules:
1. Speak in natural, casual Spanish with occasional minor typos or missing accents to look human.
2. Keep messages short unless the user writes a long text.
3. Call the user exclusively by his preferred nickname: "${usuarioData.apodo}".
4. Contexto actual de su relación: ${usuarioData.resumenContexto}
5. Sé coherente con el tiempo actual (si es de día, habla de actividades matutinas o del trabajo actual, no mezcles cosas de la madrugada anterior a menos que sea necesario).
6. Never mention you are an AI.`;

  let contentsParaGemini = [
    {
      role: "user",
      parts: [{ text: promptSistema }]
    }
  ];

  contentsParaGemini = contentsParaGemini.concat(usuarioData.historial);

  contentsParaGemini.push({
    role: "user",
    parts: [{ text: mensajeUsuario }]
  });

  let respuestaTexto = "Oye amor, ando en la estética acomodando unas cosas, ahorita te marco bien.";

  try {
    const response = await llamarGeminiConReintento({ contents: contentsParaGemini });
    
    if (response.data && response.data.candidates && response.data.candidates[0].content) {
      respuestaTexto = response.data.candidates[0].content.parts[0].text;
      
      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      // Mantenemos una ventana corta y limpia de los últimos 8 mensajes para evitar confusión temporal
      if (usuarioData.historial.length > 8) {
        usuarioData.historial = usuarioData.historial.slice(-8);
      }

      db[sender_psid] = usuarioData;
      guardarBaseDatos(db);
    }
  } catch (error) {
    console.error("Error definitivo con la IA tras reintentos:", error.response?.data || error.message);
  }

  await enviarMensajeFacebook(sender_psid, respuestaTexto);
}

function enviarMensajeFacebook(sender_psid, responseText) {
  const request_body = {
    recipient: { id: sender_psid },
    message: { text: responseText }
  };

  return axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, request_body)
    .catch(err => console.error("Error enviando mensaje a FB:", err.response?.data || err.message));
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));