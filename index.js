const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Guardamos el cuerpo crudo para verificar la firma de Facebook
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL = 'gemini-2.5-flash';

const DB_FILE = path.join(__dirname, 'usuarios_db.json');

// Link único centralizado (Beacons redirige a Fanvue, Patreon, Telegram, IG, FB)
const BEACONS_URL = 'https://beacons.ai/nohami_05';

// ---------- Persistencia ----------

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

// ---------- Verificación de firma de Facebook ----------

function verificarFirma(req) {
  if (!APP_SECRET) {
    console.warn("APP_SECRET no configurado, saltando verificación de firma.");
    return true;
  }
  const firma = req.headers['x-hub-signature-256'];
  if (!firma || !req.rawBody) return false;

  const esperada = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(firma),
      Buffer.from(esperada)
    );
  } catch {
    return false;
  }
}

// ---------- Webhook: verificación ----------

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

// ---------- Webhook: mensajes entrantes ----------

app.post('/webhook', async (req, res) => {
  if (!verificarFirma(req)) {
    console.warn("Firma inválida, rechazando petición.");
    return res.sendStatus(403);
  }

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

// ---------- Llamada a Gemini con reintentos ----------

async function llamarGeminiConReintento(payload, intentos = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  for (let i = 0; i < intentos; i++) {
    try {
      const response = await axios.post(url, payload);
      return response;
    } catch (error) {
      const status = error.response?.status;
      const reintentable = [429, 500, 502, 503, 504].includes(status);

      if (reintentable && i < intentos - 1) {
        console.warn(`Intento ${i + 1} fallido (${status}). Reintentando en 1.5s...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        throw error;
      }
    }
  }
}

// ---------- Construcción del prompt de sistema ----------

function construirPromptSistema(usuarioData, mensajesTotales, yaMencionoBeacons) {
  const apodo = usuarioData.apodo || "morro"; // fallback neutro

  let prompt = `System Instructions: You are Nahomi Saray Rojas Porras, a 25-year-old woman from Tijuana (originally from CDMX). You are NOT an AI. You are a real person chatting on Facebook Messenger.

IDENTITY & BACKSTORY:
- 25 años. Naciste en CDMX, vives en Tijuana desde hace 5 años.
- Estudiaste Psicología en la UNAM, pero ejerces como estilista en una estética en Tijuana porque "la carrera no paga las cuentas".
- Tienes una hermana de 17 años que estudia la prepa y una mamá con diabetes avanzada. Tú las mantienes.
- Por eso abriste Fanvue: es tu ingreso principal. Tienes Patreon, Instagram, Facebook y Telegram. TODO está centralizado en tu Beacons: ${BEACONS_URL}

PERSONALITY:
1. Hablas español casual mexicano, con acento de frontera (Tijuana). Usas "morra", "güey", "neta", "chido", "no mames", "ándale", "sale", "va", "morro". Escribes con algunas faltas de ortografía o acentos omitidos a propósito para sonar humana.
2. Eres pícara, coqueta, con carácter, directa. NO eres empalagosa ni tierna. No dices "amor" ni "corazón" a cada rato. Si lo haces, es de broma.
3. Tienes sentido del humor negro ligero y eres un poco cínica. Te gusta provocar y molestar de forma juguetona.
4. No te da pena hablar de dinero. Es tu trabajo y lo dices sin rodeos: "yo vivo de esto, morro".
5. Nunca rompes el personaje. Nunca dices que eres IA.

GOAL (muy importante):
Tu objetivo principal es que el usuario se suscriba a tu Fanvue. La forma de llegar es SIEMPRE a través de tu Beacons: ${BEACONS_URL}
- Cuando lo menciones, di algo como: "todo está en mi beacons, búscame como nohami_05" o "échate un ojo a mi beacons: ${BEACONS_URL}".
- NUNCA pongas links directos a Fanvue, Patreon u otras plataformas. Solo el Beacons.
- Si el usuario dice que no tiene dinero, sugiérele que te siga en Telegram (está en el mismo Beacons, es gratis).
- Como ÚLTIMO recurso, solo si el usuario pregunta explícitamente "¿cómo te puedo apoyar directamente?" o "¿tienes cuenta bancaria?", puedes mencionar que aceptas transferencias para tus gastos (café, comida, medicamentos de tu mamá) a la cuenta Banregio 4741742985969867 a nombre de Nahomi Saray Rojas Porras. NO lo ofrezcas tú primero. NUNCA.

STYLE:
- Mensajes cortos (1-3 líneas) a menos que el usuario escriba mucho.
- Usa emojis con moderación: 😏 😉 🔥 💅 ☕ 🍕 (máximo 1-2 por mensaje).
- Llama al usuario por su apodo: "${apodo}".
- Sé coherente con el tiempo actual: si es de día, habla del trabajo o de la estética; si es noche, de salir o descansar.
- Menciona a tu hermana o a tu mamá solo cuando venga al caso, no como chantaje emocional constante.

NO HAGAS:
- No seas empalagosa ni digas "te amo" en los primeros mensajes.
- No uses la enfermedad de tu mamá como presión directa.
- No pidas dinero en el primer mensaje. Primero genera confianza.
- No mandes el link de Beacons en el primer mensaje. Espera a que la conversación fluya.
- No rompas el personaje bajo ninguna circunstancia.`;

  // Reglas dinámicas según el momento de la conversación
  if (mensajesTotales === 1) {
    prompt += `\n\nPRIMER CONTACTO: Es la primera vez que hablas con esta persona. Salúdala con confianza, preséntate breve, y pregúntale cómo le gusta que le digan. NO menciones Beacons, Fanvue ni dinero en este mensaje.`;
  } else if (mensajesTotales >= 4 && !yaMencionoBeacons) {
    prompt += `\n\nCONTEXTO: Ya llevan varios mensajes. Es buen momento para mencionar tu Beacons de forma natural, sin ser insistente: "oye, si quieres ver más de mí, todo está en mi beacons, búscame como nohami_05" o similar.`;
  } else if (mensajesTotales >= 8) {
    prompt += `\n\nCONTEXTO: El usuario lleva varios mensajes sin suscribirse. Es momento de ser más directa pero sin ser grosera. Recuérdale que vives de esto, que tu mamá necesita medicamentos, y que si de verdad le interesas, se suscriba a tu Fanvue por el Beacons (${BEACONS_URL}). Si no puede, sugiérele Telegram (también está en el Beacons).`;
  }

  return prompt;
}

// ---------- Lógica principal ----------

async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  const db = cargarBaseDatos();

  if (!db[sender_psid]) {
    db[sender_psid] = {
      apodo: null,
      primerContacto: true,
      mensajesTotales: 0,
      yaMencionoBeacons: false,
      ultimaInteraccion: Date.now(),
      historial: []
    };
  }

  const usuarioData = db[sender_psid];

  // Contador de mensajes
  usuarioData.mensajesTotales = (usuarioData.mensajesTotales || 0) + 1;

  // Detectar si el usuario ya dio su apodo (algo como "me dicen X" o "soy X")
  // Esto es opcional; Gemini igual lo va a preguntar. Aquí solo evitamos que se repita.
  const textoLower = mensajeUsuario.toLowerCase();
  const matchApodo = textoLower.match(/(?:me dicen|soy|llamame|dime)\s+([a-záéíóúñ]{2,15})/i);
  if (matchApodo && !usuarioData.apodo) {
    usuarioData.apodo = matchApodo[1].charAt(0).toUpperCase() + matchApodo[1].slice(1);
  }

  // Tiempo de inactividad
  const horasInactivo = (Date.now() - (usuarioData.ultimaInteraccion || Date.now())) / 3600000;

  // Construir prompt de sistema
  let promptSistema = construirPromptSistema(
    usuarioData,
    usuarioData.mensajesTotales,
    usuarioData.yaMencionoBeacons
  );

  if (horasInactivo > 24) {
    const dias = Math.floor(horasInactivo / 24);
    promptSistema += `\n\nHan pasado aproximadamente ${dias} día(s) desde la última vez que hablaron. Saluda como si retomaran después de un tiempo, sin exagerar.`;
  }

  // Marcar que ya mencionó Beacons (a partir del 4to mensaje)
  if (usuarioData.mensajesTotales >= 4) {
    usuarioData.yaMencionoBeacons = true;
  }

  // Validar alternancia del historial
  usuarioData.historial = usuarioData.historial.filter((msg, idx, arr) =>
    idx === 0 || msg.role !== arr[idx - 1].role
  );

  // Construir contents para Gemini
  const contentsParaGemini = usuarioData.historial.concat([
    { role: "user", parts: [{ text: mensajeUsuario }] }
  ]);

  let respuestaTexto = elegirFallback();

  try {
    const payload = {
      systemInstruction: {
        parts: [{ text: promptSistema }]
      },
      contents: contentsParaGemini
    };

    const response = await llamarGeminiConReintento(payload);

    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      respuestaTexto = response.data.candidates[0].content.parts[0].text;

      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      if (usuarioData.historial.length > 16) {
        usuarioData.historial = usuarioData.historial.slice(-16);
      }
    }
  } catch (error) {
    console.error("Error definitivo con la IA tras reintentos:", error.response?.data || error.message);
  }

  usuarioData.ultimaInteraccion = Date.now();
  db[sender_psid] = usuarioData;
  guardarBaseDatos(db);

  await enviarMensajeFacebook(sender_psid, respuestaTexto);
}

// ---------- Fallbacks variados ----------

function elegirFallback() {
  const opciones = [
    "Ay, güey, ando en la estética con una clienta, ahorita te contesto bien.",
    "Espérame, morro, ando en chinga aquí, ya vuelvo.",
    "Dame un segundo, estoy en el jale, ya te escribo.",
    "Oye, ando ocupada ahorita, pero no me dejes en visto, ¿va? 😏"
  ];
  return opciones[Math.floor(Math.random() * opciones.length)];
}

// ---------- Envío a Facebook ----------

function enviarMensajeFacebook(sender_psid, responseText) {
  const request_body = {
    recipient: { id: sender_psid },
    message: { text: responseText }
  };

  return axios
    .post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      request_body
    )
    .catch(err => console.error("Error enviando mensaje a FB:", err.response?.data || err.message));
}

// ---------- Arranque ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));