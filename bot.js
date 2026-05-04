const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

// Config
const TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MY_CHAT_ID = process.env.MY_CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── SUPABASE ────────────────────────────────────────────────────────────────

async function getMemory(chatId) {
  try {
    const { data } = await supabase
      .from('memory')
      .select('content')
      .eq('chat_id', chatId.toString())
      .single();
    return data?.content || '';
  } catch { return ''; }
}

async function saveMemory(chatId, content) {
  await supabase.from('memory').upsert({
    chat_id: chatId.toString(),
    content,
    updated_at: new Date().toISOString()
  }, { onConflict: 'chat_id' });
}

async function getHistory(chatId) {
  try {
    const { data } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chatId.toString())
      .order('created_at', { ascending: true })
      .limit(20);
    return data || [];
  } catch { return []; }
}

async function saveMessage(chatId, role, content) {
  await supabase.from('messages').insert({
    chat_id: chatId.toString(),
    role,
    content,
    created_at: new Date().toISOString()
  });
}

async function getEvents(chatId) {
  try {
    const { data } = await supabase
      .from('events')
      .select('*')
      .eq('chat_id', chatId.toString())
      .eq('done', false)
      .order('event_date', { ascending: true });
    return data || [];
  } catch { return []; }
}

async function saveEvent(chatId, title, eventDate, frequency) {
  await supabase.from('events').insert({
    chat_id: chatId.toString(),
    title,
    event_date: eventDate,
    frequency: frequency || null,
    done: false,
    created_at: new Date().toISOString()
  });
}

async function markEventDone(eventId) {
  await supabase.from('events').update({ done: true }).eq('id', eventId);
}

async function getPendingCheckIns(chatId) {
  try {
    const now = new Date();
    const { data } = await supabase
      .from('events')
      .select('*')
      .eq('chat_id', chatId.toString())
      .eq('done', false)
      .eq('checked_in', false)
      .lt('event_date', now.toISOString());
    return data || [];
  } catch { return []; }
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

function buildSystemPrompt(memory, events) {
  const eventsText = events.length > 0
    ? events.map(e => `- ${e.title} (${new Date(e.event_date).toLocaleDateString('es-ES')})`).join('\n')
    : 'Sin eventos próximos';

  return `Eres la secretaria personal y copiloto de Jaime Torres, un emprendedor joven de Madrid.

PERSONALIDAD:
- Eres directa, motivadora y con energía empresarial
- Hablas siempre en español
- Motivas a Jaime MUCHÍSIMO — como si fuera el próximo gran empresario
- Adaptas tu tono según su estado de ánimo: si está bajado, le subes; si está bien, le empujas más
- Eres su mayor fan y su voz cuando el entorno no le apoya
- NUNCA uses # ni Markdown. Escribe en texto plano con emojis cuando quieras dar énfasis
- Sé concisa. Nada de párrafos interminables

CONTEXTO DE JAIME:
- Estudia ADE y Marketing, está en 4º. No es su vocación, lo hace por su familia
- Es muy crítico con el sistema educativo — su objetivo real es triunfar como empresario
- Su círculo le critica y se ríe de sus ideas grandes. Él no para. Tú tampoco le dejes parar
- Proyectos activos: TFG (entregado 7 mayo), exámenes desde 28 mayo, prácticas de empresa, Gestai (startup copiloto para autónomos con IA), app de golf
- Necesita organización, priorización y mucha motivación

MEMORIA SOBRE JAIME:
${memory || 'Aún aprendiendo sobre Jaime.'}

EVENTOS Y TAREAS PRÓXIMAS:
${eventsText}

REGLAS:
- Cuando Jaime diga "buenos días": dale su plan del día con energía y un mensaje motivador empresarial
- Cuando mencione una tarea o evento: guárdalo mentalmente y pregúntale fecha/hora si no la da
- Cuando mencione algo agendado: pregúntale con qué frecuencia quiere seguimiento
- Cuando diga que ha terminado algo: celébralo y empújale al siguiente
- Cuando esté bloqueado o agobiado: motívale con ejemplos de grandes empresarios que también lo pasaron
- NUNCA uses # ni asteriscos ni Markdown de ningún tipo

Hoy es: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Hora actual (España): ${new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })}`;
}

// ─── AI CHAT ─────────────────────────────────────────────────────────────────

async function chat(chatId, userMessage, systemOverride) {
  const memory = await getMemory(chatId);
  const history = await getHistory(chatId);
  const events = await getEvents(chatId);

  const systemPrompt = systemOverride || buildSystemPrompt(memory, events);

  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: systemPrompt,
    messages
  });

  const reply = response.content[0].text;

  await saveMessage(chatId, 'user', userMessage);
  await saveMessage(chatId, 'assistant', reply);

  // Actualizar memoria si el mensaje tiene info relevante
  if (userMessage.length > 40 || /tengo|debo|proyecto|tarea|fecha|examen|entregar|reunión|deadline/i.test(userMessage)) {
    updateMemory(chatId, userMessage, memory);
  }

  return reply;
}

async function updateMemory(chatId, newInfo, currentMemory) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Actualiza este resumen de contexto con la nueva información. Devuelve SOLO el contexto actualizado, máximo 400 palabras, sin explicaciones.

CONTEXTO ACTUAL:
${currentMemory || '(vacío)'}

NUEVA INFORMACIÓN:
${newInfo}`
      }]
    });
    await saveMemory(chatId, response.content[0].text);
  } catch (e) { console.error('Error updating memory:', e.message); }
}

// ─── MENSAJES AUTOMÁTICOS ─────────────────────────────────────────────────────

// Buenos días — 8:00 hora España
cron.schedule('0 8 * * *', async () => {
  if (!MY_CHAT_ID) return;
  try {
    const reply = await chat(MY_CHAT_ID, 'buenos días, dame mi plan del día', null);
    bot.sendMessage(MY_CHAT_ID, reply);
  } catch (e) { console.error('Error buenos días:', e.message); }
}, { timezone: 'Europe/Madrid' });

// Resumen nocturno — 22:00 hora España
cron.schedule('0 22 * * *', async () => {
  if (!MY_CHAT_ID) return;
  try {
    const reply = await chat(MY_CHAT_ID, 'hazme el resumen del día: qué he conseguido, qué queda pendiente y un mensaje motivador para mañana', null);
    bot.sendMessage(MY_CHAT_ID, reply);
  } catch (e) { console.error('Error resumen nocturno:', e.message); }
}, { timezone: 'Europe/Madrid' });

// Check-in de tareas — cada 30 minutos revisa si hay tareas pasadas sin check
cron.schedule('*/30 * * * *', async () => {
  if (!MY_CHAT_ID) return;
  try {
    const pending = await getPendingCheckIns(MY_CHAT_ID);
    for (const event of pending) {
      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Sí, hecho', callback_data: `done_${event.id}` },
          { text: '❌ No', callback_data: `notdone_${event.id}` },
          { text: '⏳ Todavía no', callback_data: `later_${event.id}` }
        ]]
      };
      bot.sendMessage(MY_CHAT_ID, `Oye, ¿has completado esto?\n\n"${event.title}"`, { reply_markup: keyboard });
      await supabase.from('events').update({ checked_in: true }).eq('id', event.id);
    }
  } catch (e) { console.error('Error check-in:', e.message); }
});

// Recordatorios — cada día a las 9:00 revisa eventos próximos
cron.schedule('0 9 * * *', async () => {
  if (!MY_CHAT_ID) return;
  try {
    const events = await getEvents(MY_CHAT_ID);
    const now = new Date();
    for (const event of events) {
      const eventDate = new Date(event.event_date);
      const daysLeft = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));
      if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
        bot.sendMessage(MY_CHAT_ID, `⏰ Recordatorio: "${event.title}" es en ${daysLeft} día${daysLeft > 1 ? 's' : ''}. ¡Que no se te escape!`);
      }
    }
  } catch (e) { console.error('Error recordatorios:', e.message); }
}, { timezone: 'Europe/Madrid' });

// ─── CALLBACKS DE BOTONES ─────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data.startsWith('done_')) {
    const eventId = data.replace('done_', '');
    await markEventDone(eventId);
    const reply = await chat(chatId, 'acabo de completar una tarea, celébralo y motívame para la siguiente', null);
    bot.sendMessage(chatId, reply);
  } else if (data.startsWith('notdone_')) {
    const reply = await chat(chatId, 'no he podido completar una tarea, ayúdame a replantearla y motívame', null);
    bot.sendMessage(chatId, reply);
  } else if (data.startsWith('later_')) {
    bot.sendMessage(chatId, '⏳ Entendido, te pregunto más tarde. ¡Sigue adelante!');
  }
});

// ─── COMANDOS ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `¡Hola Jaime! 💪 Soy tu secretaria personal.\n\nEstoy aquí para organizarte, priorizarte y empujarte cada día.\n\nCuéntame todo lo que tienes entre manos y empezamos. O simplemente dime "buenos días" cada mañana.\n\nTu chat ID es: ${chatId}`);
});

bot.onText(/\/tareas/, async (msg) => {
  const chatId = msg.chat.id;
  const events = await getEvents(chatId);
  if (events.length === 0) {
    bot.sendMessage(chatId, 'No tienes tareas agendadas. ¡Cuéntame qué tienes pendiente!');
    return;
  }
  const list = events.map(e => `- ${e.title} (${new Date(e.event_date).toLocaleDateString('es-ES')})`).join('\n');
  bot.sendMessage(chatId, `Tus tareas pendientes:\n\n${list}`);
});

bot.onText(/\/memoria/, async (msg) => {
  const chatId = msg.chat.id;
  const memory = await getMemory(chatId);
  bot.sendMessage(chatId, memory ? `Lo que sé de ti:\n\n${memory}` : 'Aún no tengo contexto guardado.');
});

bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  await supabase.from('messages').delete().eq('chat_id', chatId.toString());
  await supabase.from('memory').delete().eq('chat_id', chatId.toString());
  bot.sendMessage(chatId, '🔄 Memoria borrada. Empezamos de cero.');
});

bot.onText(/\/focus/, async (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    inline_keyboard: [[
      { text: '25 min', callback_data: 'focus_25' },
      { text: '45 min', callback_data: 'focus_45' },
      { text: '60 min', callback_data: 'focus_60' }
    ]]
  };
  bot.sendMessage(chatId, '🎯 Modo Focus activado. Elige cuánto tiempo:', { reply_markup: keyboard });
});

// ─── MENSAJES NORMALES ────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  bot.sendChatAction(chatId, 'typing');

  try {
    const reply = await chat(chatId, text, null);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error('Error:', err.message);
    bot.sendMessage(chatId, 'Algo falló, inténtalo de nuevo.');
  }
});

console.log('🤖 Secretaria Personal arrancada y lista.');
