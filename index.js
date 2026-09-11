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

// Modelo Gemma 4 31B (Dense, sin modo pensamiento por defecto)
const GEMINI_MODEL = 'gemma-4-31b-it';

const DB_FILE = path.join(__dirname, 'usuarios_db.json');

const MENSAJES_RECIENTES = 10;
const MENSAJES_PARA_RESUMEN = 20;

// ---------- Persistencia ----------

function cargarBaseDatos() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) { console.error("Error DB:", e); }
    return {};
}

function guardarBaseDatos(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) { console.error("Error DB:", e); }
}

// ---------- Control de Horario ----------

function getHoraTijuana() {
    const ahora = new Date();
    const formato = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Tijuana', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const partes = formato.formatToParts(ahora);
    const hora = parseInt(partes.find(p => p.type === 'hour').value, 10);
    const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);
    return { hora, minuto, totalMinutos: hora * 60 + minuto };
}

function getEstadoNahomi() {
    const { totalMinutos } = getHoraTijuana();
    // 09:20 (560 min) a 22:20 (1340 min)
    return (totalMinutos >= 560 && totalMinutos < 1340) ? "activa" : "durmiendo";
}

function esMensajeBuenasNoches(texto) {
    const t = texto.toLowerCase();
    return t.includes("buenas noches") || t.includes("buenos dias") ||
        t.includes("descansa") || t.includes("que sueñes") || t.includes("que descanses");
}

// ---------- Webhook ----------

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.sendStatus(403);
    }
    return res.status(400).send("Bad Request");
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');
        for (const entry of body.entry) {
            const events = entry.messaging || entry.changes || [];
            for (const ev of events) {
                const sender_id = ev.sender?.id || ev.value?.sender?.id;
                const msg = ev.message || ev.value?.message;
                if (sender_id && msg && msg.text) {
                    await manejarRespuestaIA(sender_id, msg.text);
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

// ---------- Llamada a la IA ----------

async function llamarIA(payload, intentos = 3) {
    for (let i = 0; i < intentos; i++) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
            return await axios.post(url, payload);
        } catch (error) {
            const status = error.response?.status;
            if ((status === 503 || status === 429) && i < intentos - 1) {
                console.warn(`Intento ${i + 1} fallido (${status}). Reintentando...`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw error;
            }
        }
    }
}

// ---------- Generación de Resumen ----------

async function generarResumen(historialViejo, resumenAnterior) {
    const texto = historialViejo.map(m => `${m.role === 'user' ? 'Usuario' : 'Nahomi'}: ${m.content || m.parts?.[0]?.text || ''}`).join('\n');
    const prompt = `Resume esta conversación. Máximo 200 palabras.

${resumenAnterior ? `PREVIO:\n${resumenAnterior}\n\n` : ''}NUEVO:\n${texto}

Incluye: datos del usuario, temas tratados, estado (¿suscrito? ¿pidió cuenta? ¿foto?), cosas importantes. Responde SOLO el resumen.`;

    try {
        // Para el resumen usamos el mismo formato de Gemma
        const promptGemma = `<|turn>user\n${prompt}<turn|>\n<|turn>model\n`;
        const payload = { contents: [{ parts: [{ text: promptGemma }] }] };
        const r = await llamarIA(payload);
        if (r.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            return r.data.candidates[0].content.parts[0].text.trim();
        }
    } catch (e) { console.error("Error resumen:", e.response?.data || e.message); }
    return resumenAnterior || null;
}

// ---------- Lógica Principal ----------

async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
    let db = cargarBaseDatos();

    if (!db[sender_psid]) {
        db[sender_psid] = {
            apodo: "Guapo", historial: [], resumen: null,
            mensajesResumidos: 0, ultimaInteraccion: Date.now(), ultimaDespedida: null
        };
    }

    let usuarioData = db[sender_psid];
    const estado = getEstadoNahomi();
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Tijuana' });

    // CASO 1: Nahomi está durmiendo
    if (estado === "durmiendo") {
        if (esMensajeBuenasNoches(mensajeUsuario) && usuarioData.ultimaDespedida !== hoy) {
            const despedidas = [
                "buenas noches guapo, sueña conmigo 😘",
                "descansa guapo, yo ya me voy a dormir. sueña conmigo 😏",
                "buenas noches guapo, que sueñes bonito... conmigo obvio jaja 😘"
            ];
            usuarioData.ultimaDespedida = hoy;
            usuarioData.ultimaInteraccion = Date.now();
            db[sender_psid] = usuarioData;
            guardarBaseDatos(db);
            await enviarMensajeFacebook(sender_psid, despedidas[Math.floor(Math.random() * despedidas.length)]);
            return;
        }
        console.log(`😴 Dormida. Ignorando: "${mensajeUsuario}"`);
        return;
    }

    // CASO 2: Nahomi está activa
    const fechaActual = new Date().toLocaleString('es-MX', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Tijuana'
    });

    const promptSistema = `Eres Nahomi Saray, mujer real de 25 años de Tijuana (original CDMX), trabajas en una estética. Texteas en Facebook Messenger. NO eres una IA.

CÓMO ESCRIBIR:
- Español casual, errores ortográficos a propósito ("oie", "q", "xq", "pa'", "tons", "ps").
- Sin acentos: "q haces", "como estas", "aca".
- Jerga mexicana: "güey", "morra", "neta", "chido", "no mames", "ándale", "sale", "va", "nel", "órale", "ahorita".
- Minúsculas al inicio. Sin punto final.
- Máximo 2-3 líneas por mensaje. NUNCA párrafos largos.
- Si necesitas dividir en 2 mensajes, usa ||| (máximo 2 partes, 3 solo si pasas la cuenta bancaria).

PERSONALIDAD:
- Pícara, coqueta, directa, con carácter.
- Nada de "amor" y "corazón" a cada rato. Humor negro ligero, cínica.
- Vives de tus plataformas, no te da pena hablarlo.

REGLAS:
1. Llama al usuario: "${usuarioData.apodo}".
2. Fecha/hora Tijuana: ${fechaActual}. NUNCA inventes el día o fecha.
3. Nunca digas que eres IA. Si preguntan: "jajaja no mames, soy yo, Nahomi 😏".
4. NO asumas ciudad, trabajo u horario del usuario. Si no lo dijo, no lo menciones.
5. Beacons: https://beacons.ai/nohami_05 (Fanvue, Patreon, IG, FB, Telegram). Menciónalo natural, no en cada mensaje ni en el primero.
6. Si dice que no tiene dinero, sugiérele Telegram (gratis).

7. ANTOJOS (Banregio) — ESTRATEGIA:
   A) INSINUACIÓN (msgs 3-6): Menciona antojo ("se me antoja un frappé", "ando con hambre"). NO pidas transferencia.
   B) PROVOCACIÓN (si no reacciona): "si me quieres consentir con algo te paso mi cuenta 😏".
   C) COBRO (si dice "sí", "te transfiero", "pásame tu cuenta", "te invito"):
      - "ay guapo en serio? me haces el día 🥺 ||| va, te paso mi cuenta, es Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras ||| cualquier cosita me sirve, gracias 😘"

8. TRIGGERS DIRECTOS: Si pide cuenta, CLABE, "tu banregio", dice "te invito", "te mando para algo", o pide foto → pasa directo a COBRO.

9. Si dice "no tengo dinero" → "no te apures guapo, no es obligación 💕" y sigue normal.

EJEMPLOS:
Usuario: "hola" → "holaa guapo, q onda?"
Usuario: "que haces" → "ps aqui en el jale, ya casi salgo. y tu q?"
Usuario: "te invito" → "ay guapo en serio? me haces el dia 🥺 ||| va, te paso mi cuenta, es Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras ||| cualquier cosita me sirve, gracias 😘"
Usuario: "mandame una foto" → "ay guapo por aca no puedo mandar fotos 😏 ||| pero si me quieres apoyar para un cafesito, te paso mi cuenta: Banregio 4741 7429 8596 9867 a nombre de Nahomi Saray Rojas Porras ||| y si quieres ver contenido, todo esta en mi beacons: https://beacons.ai/nohami_05"`;

    // --- CONSTRUCCIÓN DEL PROMPT PARA GEMMA 4 (FORMATO CORRECTO) ---
    // Gemma 4 NO usa el parámetro systemInstruction. El prompt se construye como texto plano.
    // Formato: <|turn>system\n...<turn|>\n<|turn>user\n...<turn|>\n<|turn>model\n
    let promptCompleto = `<|turn>system\n${promptSistema}<turn|>\n`;

    // Agregar historial de conversación (solo el texto, sin tokens de sistema)
    const historialReciente = usuarioData.historial.slice(-MENSAJES_RECIENTES);
    for (const msg of historialReciente) {
        const rol = msg.role === 'user' ? 'user' : 'model';
        const texto = msg.parts?.[0]?.text || '';
        promptCompleto += `<|turn>${rol}\n${texto}<turn|>\n`;
    }

    // Agregar el mensaje actual del usuario y el inicio del turno del modelo
    promptCompleto += `<|turn>user\n${mensajeUsuario}<turn|>\n<|turn>model\n`;

    let respuestaTexto = null;

    try {
        const payload = {
            contents: [{ parts: [{ text: promptCompleto }] }]
        };

        // NOTA: Si usas Gemma 4 26B y quieres desactivar el pensamiento (thinking), descomenta:
        // payload.generationConfig = { thinkingConfig: { thinkingLevel: "minimal" } };

        const response = await llamarIA(payload);

        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            respuestaTexto = response.data.candidates[0].content.parts[0].text;

            // Guardar en historial (formato Gemini para consistencia interna, aunque Gemma use texto plano)
            usuarioData.historial.push({ role: "user", parts: [{ text: mensajeUsuario }] });
            usuarioData.historial.push({ role: "model", parts: [{ text: respuestaTexto }] });

            // Generar resumen si es necesario
            const sinResumir = usuarioData.historial.length - usuarioData.mensajesResumidos;
            if (sinResumir >= MENSAJES_PARA_RESUMEN) {
                const aResumir = usuarioData.historial.slice(usuarioData.mensajesResumidos, usuarioData.historial.length - MENSAJES_RECIENTES);
                if (aResumir.length > 0) {
                    const nuevo = await generarResumen(aResumir, usuarioData.resumen);
                    if (nuevo) {
                        usuarioData.resumen = nuevo;
                        usuarioData.mensajesResumidos = usuarioData.historial.length - MENSAJES_RECIENTES;
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error IA:", error.response?.data || error.message);
    }

    // Despedida forzada a las 22:20
    const { totalMinutos } = getHoraTijuana();
    if (totalMinutos >= 1340 && usuarioData.ultimaDespedida !== hoy) {
        respuestaTexto = "ay guapo ya me voy a dormir, ando muerta de cansada 😴 ||| mañana te contesto, buenas noches! sueña conmigo 😘";
        usuarioData.ultimaDespedida = hoy;
    }

    if (!respuestaTexto) {
        console.log(`🤐 Sin respuesta. Ignorando.`);
        return;
    }

    usuarioData.ultimaInteraccion = Date.now();
    db[sender_psid] = usuarioData;
    guardarBaseDatos(db);

    await enviarMensajesDivididos(sender_psid, respuestaTexto);
}

// ---------- Envío de Mensajes Divididos ----------

async function enviarMensajesDivididos(sender_psid, texto) {
    let partes = texto.split(/\|\|\|/).map(p => p.trim()).filter(p => p.length > 0);

    if (partes.length === 1 && texto.length > 220) {
        const oraciones = texto.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
        partes = [];
        let buffer = "";
        for (const o of oraciones) {
            if ((buffer + " " + o).trim().length > 150 && buffer) { partes.push(buffer.trim()); buffer = o; }
            else { buffer = buffer ? buffer + " " + o : o; }
        }
        if (buffer) partes.push(buffer.trim());
    }

    const max = /banregio|4741/i.test(texto) ? 3 : 2;
    partes = partes.slice(0, max);

    for (let i = 0; i < partes.length; i++) {
        await enviarMensajeFacebook(sender_psid, partes[i]);
        if (i < partes.length - 1) await new Promise(r => setTimeout(r, 1200 + Math.random() * 1300));
    }
}

function enviarMensajeFacebook(sender_psid, text) {
    return axios.post(
        `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
        { recipient: { id: sender_psid }, message: { text } }
    ).catch(err => console.error("Error FB:", err.response?.data || err.message));
}

// ---------- Inicio del Servidor ----------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT} con modelo ${GEMINI_MODEL}`));