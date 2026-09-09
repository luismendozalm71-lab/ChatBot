app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  // Imprimimos todo el JSON que mande Facebook para auditarlo en los logs de Render
  console.log("WEBHOOK_RECEIVE:", JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      // Soportamos tanto 'messaging' tradicional como 'changes' o 'standby'
      const events = entry.messaging || entry.changes || [];
      
      for (const webhook_event of events) {
        // Si viene por changes (cambios de webhook de graph) o messaging normal
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