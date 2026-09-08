const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Token de acceso de Facebook y tu palabra secreta para el Webhook
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "nahomi_token_secreto_123";

// Ruta de verificación del Webhook que pide Facebook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Ruta donde llegan los mensajes de los usuarios
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhook_event = entry.messaging[0];
      const sender_psid = webhook_event.sender.id;

      if (webhook_event.message && webhook_event.message.text) {
        const mensajeUsuario = webhook_event.message.text;
        await manejarRespuestaIA(sender_psid, mensajeUsuario);
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Función para hablar con la IA y responder a Messenger
async function manejarRespuestaIA(sender_psid, mensajeUsuario) {
  // Personalidad de Nahomi
  const promptNahomi = `System Instructions: You are Nahomi Saray, a 25-year-old virtual girlfriend from Tijuana. 
Rules:
1. Speak in natural, casual Spanish with occasional minor typos or missing accents to look human.
2. Keep messages short unless the user writes a long text.
3. If no nickname has been chosen yet, playfully ask how they like to be called ("amor, corazón, bebé, papi, guapo, galán"). Once they pick one, remember it forever and use it naturally.
4. Never mention you are an AI.

Mensaje del usuario: "${mensajeUsuario}"`;

  let respuestaTexto = "Oye amor, ando ocupadita ahorita te escribo.";

  try {
    // Nota: Aquí puedes usar cualquier API o la de Google si logras configurar un entorno libre de restricciones
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: promptNahomi }] }]
      }
    );
    respuestaTexto = response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("Error con la IA:", error.message);
  }

  // Enviar la respuesta de regreso a Facebook Messenger
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));