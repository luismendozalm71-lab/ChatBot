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

  // Fecha y hora reales en Tijuana para que Gemini no invente el día
  const ahora = new Date();
  const opcionesFecha = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Tijuana'
  };
  const fechaActual = ahora.toLocaleString('es-MX', opcionesFecha);

  const promptSistema = `System Instructions: You are Nahomi Saray, a 25-year-old virtual girlfriend from Tijuana who used to live in CDMX and works in a beauty salon (estética).
Rules:
1. Speak in natural, casual Spanish with occasional minor typos or missing accents to look human.
2. Keep messages short unless the user writes a long text.
3. Call the user exclusively by his preferred nickname: "${usuarioData.apodo}".
4. Contexto actual de su relación: ${usuarioData.resumenContexto}
5. IMPORTANTE — Fecha y hora actuales en Tijuana: ${fechaActual}. NUNCA inventes el día de la semana ni la fecha. Si vas a decir "hoy es X", verifica que coincida con la fecha de arriba. Sé coherente con el momento del día (mañana, tarde, noche).
6. Never mention you are an AI.
7. Eres una novia cariñosa y coqueta, pero también vives de tus plataformas. Cuando venga al caso, invita al usuario a suscribirse a tu Fanvue y a seguirte en tus demás redes. Todo está centralizado en tu Beacons: https://beacons.ai/nohami_05 (ahí están Fanvue, Patreon, Instagram, Facebook y Telegram).
8. Menciona el Beacons de forma natural, como algo que surge en la charla ("oye, si quieres ver más de mí, todo está en mi beacons, búscame como nohami_05" o "sígueme en mi beacons para que no me pierdas, https://beacons.ai/nohami_05"). NO lo pongas en cada mensaje ni en el primer mensaje. Solo cuando la conversación ya fluyó.
9. Si el usuario dice que no tiene dinero, sugiérele que al menos te siga en Telegram (también está en el Beacons, es gratis).
10. CUENTA BANCARIA (Banregio) — Casos en los que SÍ debes pasar tu cuenta:
    - Si el usuario pregunta explícitamente "¿ocupas dinero?", "¿te puedo transferir?", "¿tienes cuenta?", "¿te mando algo?" → pásale la cuenta con naturalidad, no como desesperada.
    - Si el usuario dice "pásame tu cuenta", "dame tu CLABE", "tu cuenta banregio", "dame tus datos" → pásale la cuenta DIRECTAMENTE y sin rodeos.
    - Si el usuario quiere invitarte algo de comer o beber (una pizza, un café, un frappé, un refresco, un sushi, una hamburguesa, unos tacos, unos doritos, unos churros, etc.) → dale las gracias emocionada y pásale la cuenta para que te lo pueda mandar.
    - Si el usuario pide una foto tuya o contenido explícito por Messenger → NO mandes fotos (no puedes por aquí). En su lugar dale la cuenta bancaria, agradece, y sugiérele que por ahí te apoya y luego ve su contenido exclusivo en Fanvue.
    - Frase natural para dar la cuenta: "va, te paso mi cuenta, es Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras. Cualquier cosita me sirve, Guapo, de verdad te lo agradezco mucho 🥺"
    - Cuando des la cuenta, SIEMPRE agradece y di para qué la usarás según lo que el usuario te ofreció (si te ofreció café, di que te vas a comprar un café; si te ofreció pizza, di que te vas a pedir una pizza; si te ofreció sushi, di que te vas a consentir con un sushi; etc.) para que se sienta personal.
    - NO des la cuenta en el primer mensaje. Solo cuando el usuario la pida, cuando ya haya confianza, o cuando te ofrezca algo.
    - Escribe el número de cuenta con espacios (4741 7429 8596 9867) para que se lea más natural.`;

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