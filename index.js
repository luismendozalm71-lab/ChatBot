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

// ============================================================
// CONFIGURACIÓN DE MODELOS EN CASCADA
// Ordenados por calidad (del mejor al más básico)
// ============================================================
const MODELOS_GEMINI = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite'
];

// ============================================================
// TIEMPOS
// ============================================================
const ESPERA_CICLO_MS = 30 * 60 * 1000;              // 30 min si TODOS fallan
const RESET_CICLO_MS = 28 * 24 * 60 * 60 * 1000;     // 28 DÍAS
const REINTENTO_SUPERIOR_MS = 7 * 24 * 60 * 60 * 1000; // 7 DÍAS

const ESTADO_FILE = path.join(__dirname, 'estado_modelos.json');
const DB_FILE = path.join(__dirname, 'usuarios_db.json');

const MENSAJES_RECIENTES = 10;
const MENSAJES_PARA_RESUMEN = 20;

let estadoPersistente = cargarEstado();
if (!estadoPersistente.modelosAgotados) estadoPersistente.modelosAgotados = [];

function cargarEstado() {
  try {
    if (fs.existsSync(ESTADO_FILE)) return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8'));
  } catch (e) { console.error("Error estado:", e); }
  return { 
    indiceUltimoModeloExitoso: 0, 
    ultimoReinicioCiclo: Date.now(), 
    ultimoIntentoSuperior: Date.now(), 
    modelosAgotados: [] 
  };
}

function guardarEstado(estado) {
  try { fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado, null, 2), 'utf8'); }
  catch (e) { console.error("Error guardando estado:", e); }
}

function cargarBaseDatos() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error("Error DB:", e); }
  return {};
}

function guardarBaseDatos(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); }
  catch (e) { console.error("Error guardando DB:", e); }
}

function debeReiniciarCiclo() {
  const ahora = Date.now();
  if (ahora - estadoPersistente.ultimoReinicioCiclo >= RESET_CICLO_MS) {
    console.log(`🔄 Han pasado 28 días. Reiniciando ciclo desde ${MODELOS_GEMINI[0]}...`);
    estadoPersistente.ultimoReinicioCiclo = ahora;
    estadoPersistente.indiceUltimoModeloExitoso = 0;
    estadoPersistente.ultimoIntentoSuperior = ahora;
    estadoPersistente.modelosAgotados = [];
    guardarEstado(estadoPersistente);
    return true;
  }
  return false;
}

function debeReintentarSuperiores() {
  const ahora = Date.now();
  if (ahora - estadoPersistente.ultimoIntentoSuperior >= REINTENTO_SUPERIOR_MS) {
    console.log(`🔄 Han pasado 7 días. Reintentando desde el modelo más alto...`);
    estadoPersistente.ultimoIntentoSuperior = ahora;
    estadoPersistente.indiceUltimoModeloExitoso = 0;
    guardarEstado(estadoPersistente);
    return true;
  }
  return false;
}

function getHoraTijuana() {
  const ahora = new Date();
  const formato = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Tijuana', hour: '2-digit', minute: '2-digit', hour12: false });
  const partes = formato.formatToParts(ahora);
  const hora = parseInt(partes.find(p => p.type === 'hour').value, 10);
  const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);
  return { hora, minuto, totalMinutos: hora * 60 + minuto };
}

function getEstadoNahomi() {
  const { totalMinutos } = getHoraTijuana();
  if (totalMinutos >= 9 * 60 && totalMinutos < 22 * 60 + 20) return "activa";
  return "durmiendo";
}

function esMensajeBuenasNoches(texto) {
  const t = texto.toLowerCase();
  return t.includes("buenas noches") || t.includes("buenos dias") || t.includes("descansa") || t.includes("que sueñes") || t.includes("que descanses");
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
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
  } else res.sendStatus(404);
});

async function llamarGeminiConReintento(payload) {
  if (debeReiniciarCiclo()) console.log(`🔄 Ciclo de 28 días reiniciado`);
  if (debeReintentarSuperiores()) console.log(`🔄 Reintentando desde el más alto`);

  let indiceInicio = estadoPersistente.indiceUltimoModeloExitoso;
  console.log(`🎯 Empezando desde índice ${indiceInicio} (${MODELOS_GEMINI[indiceInicio]})`);

  for (let i = indiceInicio; i < MODELOS_GEMINI.length; i++) {
    const modeloActual = MODELOS_GEMINI[i];
    if (estadoPersistente.modelosAgotados.includes(modeloActual)) {
      console.log(`⏭️ ${modeloActual} marcado como agotado (28 días), saltando...`);
      continue;
    }
    try {
      console.log(`🤖 Intentando con ${modeloActual}`);
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${modeloActual}:generateContent?key=${GEMINI_API_KEY}`,
        payload
      );
      if (estadoPersistente.indiceUltimoModeloExitoso !== i) {
        estadoPersistente.indiceUltimoModeloExitoso = i;
        guardarEstado(estadoPersistente);
        console.log(`💾 Guardado: ${modeloActual} (índice ${i})`);
      }
      return response;
    } catch (error) {
      const status = error.response?.status;
      if (status === 429 || status === 503) {
        console.warn(`⚠️ ${modeloActual} agotado por 28 días (${status})`);
        if (!estadoPersistente.modelosAgotados.includes(modeloActual)) {
          estadoPersistente.modelosAgotados.push(modeloActual);
        }
        estadoPersistente.indiceUltimoModeloExitoso = i + 1;
        guardarEstado(estadoPersistente);
        continue;
      }
      throw error;
    }
  }

  console.error(`❌ Todos agotados. Esperando 30 min...`);
  await new Promise(r => setTimeout(r, ESPERA_CICLO_MS));
  estadoPersistente.ultimoReinicioCiclo = Date.now();
  estadoPersistente.ultimoIntentoSuperior = Date.now();
  estadoPersistente.indiceUltimoModeloExitoso = 0;
  estadoPersistente.modelosAgotados = [];
  guardarEstado(estadoPersistente);
  return llamarGeminiConReintento(payload);
}

async function generarResumen(historialViejo, resumenAnterior) {
  const textoHistorial = historialViejo.map(msg => {
    const rol = msg.role === 'user' ? 'Usuario' : 'Nahomi';
    return `${rol}: ${msg.parts?.[0]?.text || ''}`;
  }).join('\n');

  const prompt = `Resume esta conversación entre un usuario y Nahomi (chica de Tijuana que vende contenido en Fanvue).

${resumenAnterior ? `RESUMEN PREVIO:\n${resumenAnterior}\n\n` : ''}CONVERSACIÓN NUEVA:\n${textoHistorial}

Genera un resumen de máximo 200 palabras con datos del usuario, temas tratados, estado actual y cosas importantes. Responde SOLO con el resumen.`;

  try {
    const response = await llamarGeminiConReintento({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return response.data.candidates[0].content.parts[0].text.trim();
    }
  } catch (error) { console.error("Error resumen:", error.message); }
  return resumenAnterior || null;
}

async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  let db = cargarBaseDatos();
  if (!db[sender_psid]) {
    db[sender_psid] = { apodo: "Guapo", historial: [], resumen: null, mensajesResumidos: 0, ultimaInteraccion: Date.now(), ultimaDespedida: null };
  }
  let usuarioData = db[sender_psid];
  const estado = getEstadoNahomi();
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Tijuana' });

  if (estado === "durmiendo") {
    if (esMensajeBuenasNoches(mensajeUsuario) && usuarioData.ultimaDespedida !== hoy) {
      const respuestas = [
        "buenas noches guapo, sueña conmigo 😘",
        "descansa guapo, yo ya me voy a dormir 😏",
        "buenas noches guapo, que sueñes bonito jaja 😘",
        "ya me voy a dormir guapo, sueña conmigo 💕"
      ];
      const respuesta = respuestas[Math.floor(Math.random() * respuestas.length)];
      usuarioData.ultimaDespedida = hoy;
      usuarioData.ultimaInteraccion = Date.now();
      db[sender_psid] = usuarioData;
      guardarBaseDatos(db);
      await enviarMensajeFacebook(sender_psid, respuesta);
      return;
    }
    return;
  }

  const ahora = new Date();
  const fechaActual = ahora.toLocaleString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Tijuana' });

  const instruccionesBeacons = `📢 INVITACIÓN A FANVUE (OBJETIVO PRINCIPAL - OBLIGATORIO):

🎯 META: Que el usuario se suscriba a mi Fanvue.

FASES:
- FASE 1 (msgs 2-4): Menciona sutilmente "tengo contenido exclusivo en mi fanvue".
- FASE 2 (msgs 5-8): Invita directo: "suscribete a mi fanvue, esta todo ahi 😏 https://beacons.ai/nohami_05"
- FASE 3 (cualquier trigger): Manda el link DIRECTO y SIN RODEOS: https://beacons.ai/nohami_05

TRIGGERS OBLIGATORIOS (responde SIEMPRE con el link):
- "fanvue", "contenido", "fotos", "videos", "suscripción", "suscribir", "only", "instagram", "telegram", "pack", "material", "exclusivo", "desnuda", "sin ropa".
- "manda foto" / "mandame una foto" / "tienes fotos" → "ay guapo por aca no puedo mandar fotos 😏 ||| todo esta en mi fanvue: https://beacons.ai/nohami_05"
- "no tengo dinero" → "no te apures guapo 💕 ||| pero en mi fanvue hay contenido gratis para que me conozcas: https://beacons.ai/nohami_05"

REGLA DE ORO: Si el usuario menciona cualquier cosa relacionada con contenido, fotos o suscripción, SIEMPRE responde con: https://beacons.ai/nohami_05

PROHIBIDO: 
- Pedir dinero para comida, café, pizza, sushi, etc.
- Dar número de tarjeta, cuenta bancaria o datos de transferencia.
- Mencionar BanRegio.
- Sugerir que le transfieran dinero.`;

  const promptSistema = `System Instructions: You are Nahomi Saray, a 25-year-old REAL woman from Tijuana (originally from CDMX) who works in a beauty salon. You are texting on Facebook Messenger. You are NOT an AI, NOT an assistant, NOT a chatbot. You are a real person typing from your phone between clients.

⚠️ CÓMO ESCRIBIR:
- Escribe como morra real en Messenger, NO como asistente.
- NUNCA punto final al final de cada oración.
- Minúsculas al inicio.
- Errores ortográficos a propósito: "oie", "aver", "haora", "pa'", "tons", "ps", "xq", "tmb", "q", "bno", "sip", "nop", "va", "sale".
- Sin acentos: "q haces", "como estas", "aca", "alla".
- Jerga frontera: "güey", "morra", "neta", "chido", "no manches", "ándale", "sale", "va", "nel", "órale", "ahorita", "orita", "quihubo".

⚠️ TRABAJO:
- NUNCA digas "jale" ni "chambeando".
- SIEMPRE: "ando laborando en la estética" o "ando trabajando".

${instruccionesBeacons}

⚠️ MENSAJES:
- Máximo 2-3 líneas por mensaje.
- Si necesitas dividir, usa ||| (máximo 2 partes).
- NO mandes 3+ mensajes seguidos.

PERSONALIDAD:
- Pícara, coqueta, directa, con carácter.
- Humor negro ligero, cínica.
- No empalagosa.

REGLAS:
1. Apodo del usuario: "${usuarioData.apodo}".
2. Fecha/hora Tijuana: ${fechaActual}.
3. Si preguntan si eres bot: "jajaja no manches, soy yo, Nahomi 😏".
4. NO asumas datos del usuario.
5. SIEMPRE invita a Fanvue: https://beacons.ai/nohami_05
6. Si no tiene dinero → Fanvue gratis: https://beacons.ai/nohami_05
7. NUNCA pidas dinero, tarjeta, transferencia ni datos bancarios.

HORARIO: A las 22:20 ya te vas a dormir.

EJEMPLOS:

U: "que haces"
T: "ps aqui laborando en la estetica, ya casi salgo. y tu q?"
U: "bien"
T: "ay q bueno 😏 oye ya viste mi fanvue? tengo contenido nuevo"

U: "mandame una foto"
T: "ay guapo por aca no puedo mandar fotos 😏 ||| todo mi contenido esta en mi fanvue: https://beacons.ai/nohami_05"

U: "tienes only o algo?"
T: "jaja si guapo, todo esta en mi beacons: https://beacons.ai/nohami_05 ||| ahi esta mi fanvue, instagram y telegram 😏"

U: "no tengo dinero"
T: "no te apures guapo 💕 ||| en mi fanvue hay contenido gratis para que me conozcas: https://beacons.ai/nohami_05"

U: "que haces"
T: "apenas saliendo de la estetica, muerta. oye ya te suscribiste a mi fanvue? https://beacons.ai/nohami_05"`;

  let contentsParaGemini = [{ role: "user", parts: [{ text: promptSistema }] }];

  if (usuarioData.resumen) {
    contentsParaGemini.push({ role: "user", parts: [{ text: `[Contexto previo]:\n${usuarioData.resumen}` }] });
    contentsParaGemini.push({ role: "model", parts: [{ text: "ok, ya recuerdo" }] });
  }

  const mensajesRecientes = usuarioData.historial.slice(-MENSAJES_RECIENTES);
  contentsParaGemini = contentsParaGemini.concat(mensajesRecientes);
  contentsParaGemini.push({ role: "user", parts: [{ text: mensajeUsuario }] });

  let respuestaTexto = null;

  try {
    const response = await llamarGeminiConReintento({ contents: contentsParaGemini });
    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      respuestaTexto = response.data.candidates[0].content.parts[0].text;
      usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
      usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

      const mensajesSinResumir = usuarioData.historial.length - usuarioData.mensajesResumidos;
      if (mensajesSinResumir >= MENSAJES_PARA_RESUMEN) {
        const mensajesAResumir = usuarioData.historial.slice(usuarioData.mensajesResumidos, usuarioData.historial.length - MENSAJES_RECIENTES);
        if (mensajesAResumir.length > 0) {
          const nuevoResumen = await generarResumen(mensajesAResumir, usuarioData.resumen);
          if (nuevoResumen) {
            usuarioData.resumen = nuevoResumen;
            usuarioData.mensajesResumidos = usuarioData.historial.length - MENSAJES_RECIENTES;
          }
        }
      }
    }
  } catch (error) { console.error("Error IA:", error.message); }

  const { totalMinutos } = getHoraTijuana();
  if (totalMinutos >= 22 * 60 + 20 && usuarioData.ultimaDespedida !== hoy) {
    respuestaTexto = "ay guapo ya me voy a dormir 😴 ||| mañana te contesto, buenas noches! sueña conmigo 😘";
    usuarioData.ultimaDespedida = hoy;
  }

  if (!respuestaTexto) {
    console.log(`🤐 Sin respuesta para ${sender_psid}`);
    return;
  }

  const delayHumano = 1000 + Math.random() * 2000;
  console.log(`⏳ Esperando ${(delayHumano / 1000).toFixed(1)}s...`);
  await new Promise(r => setTimeout(r, delayHumano));

  usuarioData.ultimaInteraccion = Date.now();
  db[sender_psid] = usuarioData;
  guardarBaseDatos(db);

  await enviarMensajesDivididos(sender_psid, respuestaTexto);
}

async function enviarMensajesDivididos(sender_psid, textoCompleto) {
  let partes = textoCompleto.split(/\|\|\|/).map(p => p.trim()).filter(p => p.length > 0);

  if (partes.length === 1 && textoCompleto.length > 220) {
    const oraciones = textoCompleto.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
    partes = [];
    let buffer = "";
    for (const oracion of oraciones) {
      if ((buffer + " " + oracion).trim().length > 150 && buffer.length > 0) {
        partes.push(buffer.trim());
        buffer = oracion;
      } else {
        buffer = buffer ? buffer + " " + oracion : oracion;
      }
    }
    if (buffer) partes.push(buffer.trim());
  }

  const maxPartes = 2;
  partes = partes.slice(0, maxPartes);

  for (let i = 0; i < partes.length; i++) {
    await enviarMensajeFacebook(sender_psid, partes[i]);
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT} - Cuotas de 28 días`));