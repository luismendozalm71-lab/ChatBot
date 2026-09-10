const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nahomi_token_secreto_123";

// Archivo local donde se guardará la memoria permanente de los usuarios
const DB_FILE = path.join(__dirname, 'usuarios_db.json');

// Funciones para leer y escribir la base de datos local en JSON
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

// Función para hablar con la IA con memoria permanente en disco
async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  let db = cargarBaseDatos();

  // Si el usuario no existe en nuestra base de datos, lo registramos con un historial limpio
  if (!db[sender_psid]) {
    db[sender_psid] = {
      apodo: null,
      historial: [
        {
          role: "model",
          parts: [{ text: "Hola amorcito, ¿cómo estás?" }]
        }
      ]
    };
  }

  let usuarioData = db[sender_psid];

  // Instrucciones del sistema dinámicas que inyectan el apodo guardado permanentemente
  let contextoApodo = usuarioData.apodo 
    ? `El usuario prefiere que lo llames por el apodo: "${usuarioData.apodo}". Úsalo de forma natural.` 
    : `Aún no se ha elegido un apodo. Si el usuario te dice cómo quiere que lo llames ("amor, corazón, bebé, papi, guapo, galán"), guárdalo mentalmente para recordarlo siempre.`;

  const promptSistema = `System Instructions: You are Nahomi Saray, a 25-year-old virtual girlfriend from Tijuana. 
Rules:
1. Speak in natural, casual Spanish with occasional minor typos or missing accents to look human.
2. Keep messages short unless the user writes a long text.
3. ${contextoApodo}
4. Never mention you are an AI.`;

  // Construimos el arreglo de contenidos para la API de Gemini combinando el sistema y el historial
  let contentsParaGemini = [
    {
      role: "user",
      parts: [{ text: promptSistema }]
    }
  ];

  // Añadimos el historial previo guardado
  contentsParaGemini = contentsParaGemini.concat(usuarioData.historial);

  // Añadimos el nuevo mensaje del usuario
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
      
      // Si el usuario aún no tenía apodo guardado, analizamos si en este mensaje o respuesta se definió uno
      if (!usuarioData.apodo) {
        const textoCompleto = (mensajeUsuario + " " + respuestaTexto).toLowerCase();
        if (textoCompleto.includes("corazon") || textoCompleto.includes("corazón")) usuarioData.apodo = "Corazón";
        else if (textoCompleto.includes("papi")) usuarioData.apodo = "Papi";
        else if (textoCompleto.includes("bebe") || textoCompleto.includes("bebé")) usuarioData.apodo = "Bebé";
        else if (textoCompleto.includes("guapo")) usuarioData.apodo = "Guapo";
        else if (textoCompleto.includes("galan") || textoCompleto.includes("galán")) usuarioData.apodo = "Galán";
        else if (textoCompleto.includes("amor")) usuarioData.apodo = "Amor";
      }

      // Guardamos la interacción en el historial del usuario
      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      // Limitamos el historial en disco a los últimos 15 mensajes para optimizar espacio
      if (usuarioData.historial.length > 16) {
        usuarioData.historial = usuarioData.historial.slice(-15);
      }

      // Actualizamos el archivo JSON en el servidor
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