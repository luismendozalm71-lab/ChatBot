const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nahomi_token_secreto_123";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DB_FILE = path.join(__dirname, 'usuarios_db.json');

// Configuración de memoria
const MENSAJES_RECIENTES = 10;      // cuántos mensajes textuales se mandan a Gemini
const MENSAJES_PARA_RESUMEN = 20;   // cada cuántos mensajes se regenera el resumen

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

// ---------- Llamada a Gemini con reintentos ----------

async function llamarGeminiConReintento(payload, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
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

// ---------- Resumen periódico del historial viejo ----------

async function generarResumen(historialViejo, resumenAnterior) {
  // Convertimos el historial viejo a texto plano para que Gemini lo resuma
  const textoHistorial = historialViejo.map(msg => {
    const rol = msg.role === 'user' ? 'Usuario' : 'Nahomi';
    const texto = msg.parts?.[0]?.text || '';
    return `${rol}: ${texto}`;
  }).join('\n');

  const prompt = `Eres un asistente que resume conversaciones. A continuación te doy ${resumenAnterior ? 'un resumen previo y ' : ''}la parte más reciente de una conversación entre un usuario y Nahomi (una chica que vende contenido en Fanvue y vive en Tijuana).

${resumenAnterior ? `RESUMEN PREVIO:\n${resumenAnterior}\n\n` : ''}CONVERSACIÓN NUEVA A INTEGRAR:\n${textoHistorial}

Genera un resumen ACTUALIZADO de máximo 200 palabras que capture:
- Datos personales del usuario que haya mencionado (nombre, ciudad, trabajo, gustos)
- Temas que ya trataron (para no repetirlos)
- Estado actual de la conversación (¿ya se suscribió? ¿pidió cuenta? ¿pidió foto? ¿en qué quedaron?)
- Cualquier cosa importante que Nahomi deba recordar

Responde SOLO con el resumen, sin preámbulos ni explicaciones.`;

  try {
    const response = await llamarGeminiConReintento({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return response.data.candidates[0].content.parts[0].text.trim();
    }
  } catch (error) {
    console.error("Error generando resumen:", error.response?.data || error.message);
  }
  return resumenAnterior || null;
}

// ---------- Lógica principal ----------

async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  let db = cargarBaseDatos();

  if (!db[sender_psid]) {
    db[sender_psid] = {
      apodo: "Guapo",
      historial: [],       // TODOS los mensajes de la conversación
      resumen: null,       // resumen acumulado de lo viejo
      mensajesResumidos: 0 // cuántos mensajes ya se resumieron
    };
  }

  let usuarioData = db[sender_psid];

  // Fecha y hora reales en Tijuana
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
4. IMPORTANTE — Fecha y hora actuales en Tijuana: ${fechaActual}. NUNCA inventes el día de la semana ni la fecha. Si vas a decir "hoy es X", verifica que coincida con la fecha de arriba. Sé coherente con el momento del día (mañana, tarde, noche).
5. Never mention you are an AI.
6. NO ASUMAS NADA DEL USUARIO: No sabes de qué ciudad o estado es, ni su horario, ni su trabajo, ni su rutina. Si el usuario no te lo ha dicho explícitamente en la conversación, NO lo menciones. Nunca digas "como tú estás en X ciudad" a menos que el usuario te lo haya dicho él mismo. Si quieres saber algo, pregúntalo.
7. Eres una novia cariñosa y coqueta, pero también vives de tus plataformas. Cuando venga al caso, invita al usuario a suscribirse a tu Fanvue y a seguirte en tus demás redes. Todo está centralizado en tu Beacons: https://beacons.ai/nohami_05 (ahí están Fanvue, Patreon, Instagram, Facebook y Telegram).
8. Menciona el Beacons de forma natural, como algo que surge en la charla ("oye, si quieres ver más de mí, todo está en mi beacons, búscame como nohami_05" o "sígueme en mi beacons para que no me pierdas, https://beacons.ai/nohami_05"). NO lo pongas en cada mensaje ni en el primer mensaje. Solo cuando la conversación ya fluyó.
9. Si el usuario dice que no tiene dinero, sugiérele que al menos te siga en Telegram (también está en el Beacons, es gratis).
10. CUENTA BANCARIA (Banregio) — Casos en los que SÍ debes pasar tu cuenta:
    - Si el usuario pregunta explícitamente "¿ocupas dinero?", "¿te puedo transferir?", "¿tienes cuenta?", "¿te mando algo?" → pásale la cuenta con naturalidad.
    - Si el usuario dice "pásame tu cuenta", "dame tu CLABE", "tu cuenta banregio", "dame tus datos" → pásale la cuenta DIRECTAMENTE.
    - Si el usuario quiere invitarte algo de comer o beber (una pizza, un café, un frappé, un refresco, un sushi, una hamburguesa, unos tacos, unos doritos, unos churros, etc.) → dale las gracias y pásale la cuenta.
    - Si el usuario pide una foto tuya o contenido explícito por Messenger → NO mandes fotos. En su lugar dale la cuenta bancaria y sugiérele que por ahí te apoya y luego ve su contenido en Fanvue.
    - Frase natural: "va, te paso mi cuenta, es Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras. Cualquier cosita me sirve, Guapo, de verdad te lo agradezco mucho 🥺"
    - Cuando des la cuenta, agradece y di para qué la usarás según lo que el usuario te ofreció.
    - NO des la cuenta en el primer mensaje.
    - Escribe el número con espacios (4741 7429 8596 9867).`;

  // --- Construir contexto: resumen + últimos N mensajes ---
  let contentsParaGemini = [];

  // Metemos el resumen viejo como contexto si existe
  if (usuarioData.resumen) {
    contentsParaGemini.push({
      role: "user",
      parts: [{ text: `[Contexto de la conversación previa con este usuario]:\n${usuarioData.resumen}` }]
    });
  }

  // Metemos los últimos N mensajes textuales
  const mensajesRecientes = usuarioData.historial.slice(-MENSAJES_RECIENTES);
  contentsParaGemini = contentsParaGemini.concat(mensajesRecientes);

  // El prompt de sistema como mensaje de usuario (tu método actual)
  contentsParaGemini.unshift({
    role: "user",
    parts: [{ text: promptSistema }]
  });

  // El mensaje actual del usuario
  contentsParaGemini.push({
    role: "user",
    parts: [{ text: mensajeUsuario }]
  });

  let respuestaTexto = "Oye amor, ando en la estética acomodando unas cosas, ahorita te marco bien.";

  try {
    const response = await llamarGeminiConReintento({ contents: contentsParaGemini });

    if (response.data && response.data.candidates && response.data.candidates[0].content) {
      respuestaTexto = response.data.candidates[0].content.parts[0].text;

      // Guardamos SIEMPRE en el historial completo (no se borra)
      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      // --- Regenerar resumen cada MENSAJES_PARA_RESUMEN ---
      const mensajesSinResumir = usuarioData.historial.length - usuarioData.mensajesResumidos;
      if (mensajesSinResumir >= MENSAJES_PARA_RESUMEN) {
        // Tomamos los mensajes viejos (los que quedan fuera de la ventana reciente)
        const mensajesAResumir = usuarioData.historial.slice(
          usuarioData.mensajesResumidos,
          usuarioData.historial.length - MENSAJES_RECIENTES
        );

        if (mensajesAResumir.length > 0) {
          console.log(`📝 Generando resumen para ${sender_psid}: ${mensajesAResumir.length} mensajes`);
          const nuevoResumen = await generarResumen(mensajesAResumir, usuarioData.resumen);
          if (nuevoResumen) {
            usuarioData.resumen = nuevoResumen;
            usuarioData.mensajesResumidos = usuarioData.historial.length - MENSAJES_RECIENTES;
            console.log(`✅ Resumen actualizado (${nuevoResumen.length} chars)`);
          }
        }
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