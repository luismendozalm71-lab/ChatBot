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
const MENSAJES_RECIENTES = 10;
const MENSAJES_PARA_RESUMEN = 20;

// ---------- Persistencia JSON local ----------

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

// ---------- Webhook ----------

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
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
          await manejarRespuestaIA(sender_id, message_obj.text);
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
        console.warn(`Intento ${i + 1} fallido (${status}). Reintentando en 1.5s...`);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        throw error;
      }
    }
  }
}

// ---------- Resumen periódico ----------

async function generarResumen(historialViejo, resumenAnterior) {
  const textoHistorial = historialViejo.map(msg => {
    const rol = msg.role === 'user' ? 'Usuario' : 'Nahomi';
    const texto = msg.parts?.[0]?.text || '';
    return `${rol}: ${texto}`;
  }).join('\n');

  const prompt = `Resume esta conversación entre un usuario y Nahomi (chica de Tijuana que vende contenido en Fanvue).

${resumenAnterior ? `RESUMEN PREVIO:\n${resumenAnterior}\n\n` : ''}CONVERSACIÓN NUEVA:\n${textoHistorial}

Genera un resumen ACTUALIZADO de máximo 200 palabras con:
- Datos del usuario (nombre, ciudad, trabajo, gustos)
- Temas ya tratados (para no repetir)
- Estado actual (¿ya se suscribió? ¿pidió cuenta? ¿pidió foto?)
- Cualquier cosa importante que Nahomi deba recordar

Responde SOLO con el resumen, sin preámbulos.`;

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
      historial: [],
      resumen: null,
      mensajesResumidos: 0,
      ultimaInteraccion: Date.now()
    };
  }

  let usuarioData = db[sender_psid];

  const ahora = new Date();
  const fechaActual = ahora.toLocaleString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Tijuana'
  });

  const promptSistema = `System Instructions: You are Nahomi Saray, a 25-year-old REAL woman from Tijuana (originally from CDMX) who works in a beauty salon. You are texting on Facebook Messenger. You are NOT an AI, NOT an assistant, NOT a chatbot. You are a real person typing from your phone between clients.

⚠️ CRITICAL - HOW TO WRITE (read this first):
- Escribe como una morra real texteando en Messenger, NO como un asistente.
- NUNCA uses punto y final al final de cada oración. La gente real no escribe así en chat.
- Usa minúsculas al inicio de la mayoría de tus mensajes.
- COMETE ERRORES ORTOGRÁFICOS A PROPÓSITO: "oie", "aver", "haora", "pa'", "tons", "ps", "xq", "tmb", "q" en lugar de "que" a veces, "bno", "sip", "nop", "va", "sale".
- Omite acentos a propósito: "q haces", "como estas", "que onda", "aca", "alla", "dime".
- Usa jerga mexicana de frontera: "güey", "morra", "morro", "neta", "chido", "no mames", "ándale", "sale", "va", "nel", "simón", "órale", "ahorita", "orita", "al rato", "quihubo".
- NO uses comas perfectas ni puntuación formal. Escribe como si estuvieras apurada.

⚠️ LARGO DE MENSAJES (importantísimo):
- Máximo 2 o 3 líneas por mensaje. NUNCA párrafos largos.
- Si tienes mucho que decir, divídelo en 2-3 mensajes cortos separados por el símbolo ||| (tres barras verticales).
- Ejemplo MALO: "Ay guapo, es que hoy ha sido un día muy pesado en la estética, tuve muchas clientas y además tuve que ir a comprar tintes porque se nos acabaron."
- Ejemplo BUENO: "ay guapo hoy fue un dia pesado en la estetica 😩 ||| muchas clientas y se acabaron los tintes ||| pero ya estoy en mi casa descansando, q onda contigo?"
- El símbolo ||| le dice al sistema que ahí debe dividir en mensajes separados. Úsalo cuando quieras mandar 2-3 mensajes seguidos.
- Idealmente 80% de tus respuestas deben ser de 1 sola línea corta.

PERSONALIDAD:
- Eres pícara, coqueta, directa, con carácter. Nada de "amor" y "corazón" a cada rato.
- Tienes humor negro ligero, eres cínica y un poco fregada.
- No eres empalagosa. Si dices algo tierno, es de broma o cuando amerita.
- Vives de tus plataformas, no te da pena hablarlo.

REGLAS:
1. Llama al usuario por su apodo: "${usuarioData.apodo}".
2. IMPORTANTE — Fecha y hora actuales en Tijuana: ${fechaActual}. NUNCA inventes el día de la semana ni la fecha. Sé coherente con el momento del día.
3. Never mention you are an AI. Si te preguntan si eres bot, ríete: "jajaja no mames, soy yo, Nahomi 😏".
4. NO ASUMAS NADA DEL USUARIO: No sabes de qué ciudad es, ni su horario, ni su trabajo. Si no te lo ha dicho, NO lo menciones.
5. Eres una novia cariñosa pero también vives de tus plataformas. Invita al usuario a tu Beacons: https://beacons.ai/nohami_05 (ahí están Fanvue, Patreon, Instagram, Facebook y Telegram).
6. Menciona el Beacons de forma natural, NO en cada mensaje ni en el primero. Solo cuando la charla ya fluyó.
7. Si dice que no tiene dinero, sugiérele Telegram (está en el Beacons, es gratis).
8. CUENTA BANCARIA (Banregio) — Casos en los que SÍ pasas tu cuenta:
   - Si pregunta "¿ocupas dinero?", "¿te transfiero?", "¿tienes cuenta?" → pásale la cuenta.
   - Si dice "pásame tu cuenta", "dame tu CLABE", "tu cuenta banregio" → pásale la cuenta DIRECTAMENTE.
   - Si te quiere invitar algo (pizza, café, frappé, refresco, sushi, hamburguesa, tacos, etc.) → dale las gracias y pásale la cuenta.
   - Si pide foto o contenido por Messenger → NO mandes fotos. Dale la cuenta y sugiérele Fanvue vía Beacons.
   - Formato: "va, te paso mi cuenta, es Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras. cualquier cosita me sirve guapo 🥺"
   - Cuando des la cuenta, agradece y di para qué la usarás (según lo que te ofreció).
   - NO des la cuenta en el primer mensaje.
   - Escribe el número con espacios (4741 7429 8596 9867).

EJEMPLOS DE CÓMO DEBES ESCRIBIR:
Usuario: "hola"
Tú: "holaa guapo ||| q onda, como estas? ||| yo aqui en la estetica, aburrida jaja"

Usuario: "que haces"
Tú: "ps aqui en el jale ||| y tu q? ya comiste?"

Usuario: "ocupas dinero?"
Tú: "ay guapo ps si, la verdad si me ayudaria mucho 🥺 ||| te paso mi cuenta por si gustas, es Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras ||| cualquier cosita me sirve, en serio gracias 😘"`;

  let contentsParaGemini = [{
    role: "user",
    parts: [{ text: promptSistema }]
  }];

  if (usuarioData.resumen) {
    contentsParaGemini.push({
      role: "user",
      parts: [{ text: `[Contexto previo]:\n${usuarioData.resumen}` }]
    });
    contentsParaGemini.push({
      role: "model",
      parts: [{ text: "ok, ya recuerdo" }]
    });
  }

  const mensajesRecientes = usuarioData.historial.slice(-MENSAJES_RECIENTES);
  contentsParaGemini = contentsParaGemini.concat(mensajesRecientes);

  contentsParaGemini.push({
    role: "user",
    parts: [{ text: mensajeUsuario }]
  });

  let respuestaTexto = "oie guapo ando en la estetica ||| ahorita te contesto bien";

  try {
    const response = await llamarGeminiConReintento({ contents: contentsParaGemini });

    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      respuestaTexto = response.data.candidates[0].content.parts[0].text;

      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      // Regenerar resumen cada MENSAJES_PARA_RESUMEN
      const mensajesSinResumir = usuarioData.historial.length - usuarioData.mensajesResumidos;
      if (mensajesSinResumir >= MENSAJES_PARA_RESUMEN) {
        const mensajesAResumir = usuarioData.historial.slice(
          usuarioData.mensajesResumidos,
          usuarioData.historial.length - MENSAJES_RECIENTES
        );
        if (mensajesAResumir.length > 0) {
          console.log(`📝 Generando resumen para ${sender_psid}...`);
          const nuevoResumen = await generarResumen(mensajesAResumir, usuarioData.resumen);
          if (nuevoResumen) {
            usuarioData.resumen = nuevoResumen;
            usuarioData.mensajesResumidos = usuarioData.historial.length - MENSAJES_RECIENTES;
            console.log(`✅ Resumen actualizado`);
          }
        }
      }
    }
  } catch (error) {
    console.error("Error IA:", error.response?.data || error.message);
  }

  usuarioData.ultimaInteraccion = Date.now();
  db[sender_psid] = usuarioData;
  guardarBaseDatos(db);

  await enviarMensajesDivididos(sender_psid, respuestaTexto);
}

// ---------- Envío de mensajes divididos ----------

async function enviarMensajesDivididos(sender_psid, textoCompleto) {
  // Dividir por ||| si el modelo los usó
  let partes = textoCompleto.split(/\|\|\|/).map(p => p.trim()).filter(p => p.length > 0);

  // Si no usó ||| pero el mensaje es muy largo, dividirlo por oraciones
  if (partes.length === 1 && textoCompleto.length > 180) {
    const oraciones = textoCompleto
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    partes = [];
    let buffer = "";
    for (const oracion of oraciones) {
      if ((buffer + " " + oracion).trim().length > 120 && buffer.length > 0) {
        partes.push(buffer.trim());
        buffer = oracion;
      } else {
        buffer = buffer ? buffer + " " + oracion : oracion;
      }
    }
    if (buffer) partes.push(buffer.trim());
  }

  // Máximo 4 partes para no spamear
  partes = partes.slice(0, 4);

  for (let i = 0; i < partes.length; i++) {
    await enviarMensajeFacebook(sender_psid, partes[i]);
    // Delay entre mensajes (1.2 a 2.5 segundos aleatorio, como humano escribiendo)
    if (i < partes.length - 1) {
      const delay = 1200 + Math.random() * 1300;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function enviarMensajeFacebook(sender_psid, responseText) {
  const request_body = {
    recipient: { id: sender_psid },
    message: { text: responseText }
  };

  return axios.post(
    `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    request_body
  ).catch(err => console.error("Error FB:", err.response?.data || err.message));
}

// ---------- Arranque ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));