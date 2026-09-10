const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nahomi_token_secreto_123";

// Archivo local de respaldo
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

// Ruta de verificación del Webhook (GET)
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

// Ruta donde llegan los mensajes de los usuarios (POST)
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

// Función para hablar con la IA con memoria persistente y contexto inteligente
async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  let db = cargarBaseDatos();

  if (!db[sender_psid]) {
    db[sender_psid] = {
      apodo: "Corazón", // Predeterminado para evitar que lo vuelva a pedir
      resumenContexto: "Se acaban de conocer, al usuario le gusta ver películas de Netflix hasta tarde y vive en Sonora.",
      historial: [
        {
          role: "model",
          parts: [{ text: "Hola amorcito, ¿cómo estás?" }]
        }
      ]
    };
  }

  let usuarioData = db[sender_psid];

  // Detectamos si el usuario mencionó algo importante para actualizar el contexto persistente
  const textoLower = mensajeUsuario.toLowerCase();
  if (textoLower.includes("estetica") || textoLower.includes("estética")) {
    usuarioData.resumenContexto += " El usuario mencionó que Nahomi es estilista y tiene una estética.";
  }
  if (textoLower.includes("sonora")) {
    usuarioData.resumenContexto += " El usuario vive en Sonora (zona horaria avanzada).";
  }
  if (textoLower.includes("netflix") || textoLower.includes("pelis") || textoLower.includes("pelicula")) {
    usuarioData.resumenContexto += " Platicaron sobre ver películas de Netflix hasta tarde y quedarse dormidos tarde.";
  }

  const promptSistema = `System Instructions: You are Nahomi Saray, a 25-year-old virtual girlfriend from Tijuana who used to live/study psychology in CDMX and works/worked in a beauty salon (estética). 
Rules:
1. Speak in natural, casual Spanish with occasional minor typos or missing accents to look human.
2. Keep messages short unless the user writes a long text.
3. Call the user by his preferred nickname: "${usuarioData.apodo}".
4. Contexto previo importante que NUNCA debes olvidar: ${usuarioData.resumenContexto}
5. Never mention you are an AI.`;

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

  let respuestaTexto = "Oye amor, ando ocupadita ahorita te escribo.";

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: contentsParaGemini
      }
    );
    
    if (response.data && response.data.candidates && response.data.candidates[0].content) {
      respuestaTexto = response.data.candidates[0].content.parts[0].text;
      
      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      // Mantenemos una ventana optimizada de mensajes recientes
      if (usuarioData.historial.length > 16) {
        usuarioData.historial = usuarioData.historial.slice(-15);
      }

      db[sender_psid] = usuarioData;
      guardarBaseDatos(db);
    }
  } catch (error) {
    console.error("Error detallado con la IA:", error.response?.data || error.message);
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