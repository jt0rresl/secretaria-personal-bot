const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

// Config desde variables de entorno
const TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MY_CHAT_ID = process.env.MY_CHAT_ID; // tu chat_id de Telegram

const bot = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── SUPABASE HELPERS ────────────────────────────────────────────────────────

async function getMemory(chatId) {
  const { data } = await supabase
    .from('memory')
    .select('content')
    .eq('chat_id', chatId.toString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data?.content || '';
}

async function saveMemory(chatId, content) {
  await supabase.from('memory').upsert({
    chat_id: chatId.toString(),
    content,
    updated_at: new Date().toISOString()
  }, { onConflict: 'chat_id' });
}

async function getHistory(chatId) {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('chat_id', chatId.toString())
    .order('created_at', { ascending: true })
    .limit(30);
  return data || [];
}

async function saveMessage(chatId, role, content) {
  await supabase.from('messages').insert({
    chat_id: chatId.toString(),
    role,
    content,
    created_at: new Date().toISOString()
  });
}

// ─── ANTHROPIC ───────────────────────────────────────────────────────────────

async function chat(chatId, userMessage) {
  const memory = await getMemory(chatId);
  const history = await getHistory(chatId);

  const systemPrompt = `Eres la secretaria personal de Jaime, un estudiante y emprendedor español. 
Tu nombre es Secretaria (o como Jaime prefiera llamarte).
Hablas siempre en español. Eres motivadora, directa y con tono empresarial positivo.
Tratas a Jaime como a un emprendedor de alto potencial.

CONTEXTO PERMANENTE DE JAIME:
${memory || 'Aún no tienes contexto guardado. Ve aprendiendo sobre Jaime en la conversación.'}

ÁREAS DE VIDA DE JAIME:
- TFG: entrega el 7 de mayo
- Exámenes: empiezan el 28 de mayo  
- Prácticas de empresa
- Gestai: su startup, un copiloto para autónomos con IA (co-fundada con un amigo)
- Golf: app relacionada con golf

CÓMO ACTUAR:
- Cuando Jaime diga "buenos días" o similar: dale el resumen del día con sus tareas más importantes y un mensaje motivador empresarial
- Cuando Jaime te cuente tareas nuevas: guárdalas mentalmente y organízalas por prioridad
- Cuando Jaime esté bloqueado: motívale y ayúdale a desbloquear
- Avisa proactivamente de deadlines cercanos (TFG 7 mayo, exámenes 28 mayo)
- Sé concisa, no escribas párrafos interminables
- Usa emojis con moderación para dar energía

Hoy es: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemPrompt,
    messages
  });

  const reply = response.content[0].text;

  // Guardar mensajes
  await saveMessage(chatId, 'user', userMessage);
  await saveMessage(chatId, 'assistant', reply);

  // Actualizar memoria con info nueva si el mensaje es largo o contiene info relevante
  if (userMessage.length > 50 || userMessage.toLowerCase().includes('tengo que') || 
      userMessage.toLowerCase().includes('debo') || userMessage.toLowerCase().includes('tarea') ||
      userMessage.toLowerCase().includes('proyecto') || userMessage.toLowerCase().includes('deadline')) {
    await updateMemory(chatId, userMessage, memory);
  }

  return reply;
}

async function updateMemory(chatId, newInfo, currentMemory) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Eres un sistema de memoria. Actualiza el resumen de contexto con la nueva información.
      
CONTEXTO ACTUAL:
${currentMemory || '(vacío)'}

NUEVA INFORMACIÓN:
${newInfo}

Devuelve SOLO el contexto actualizado en formato conciso (máximo 500 palabras). 
Incluye: tareas pendientes, proyectos activos, deadlines, preferencias, estado emocional reciente.
No añadas explicaciones, solo el contexto actualizado.`
    }]
  });

  await saveMemory(chatId, response.content[0].text);
}

// ─── BOT HANDLERS ────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const welcome = `¡Hola Jaime! 👋 Soy tu secretaria personal.

Estoy aquí para organizarte, priorizarte y mantenerte enfocado en lo que importa.

Cuéntame todo lo que tienes entre manos y empezamos. O simplemente dime *"buenos días"* cada mañana y te organizo el día. 🚀

Tu chat ID es: \`${chatId}\` (guárdalo para configuración)`;

  bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/reset/, async (msg) => {
  const chatId = msg.chat.id;
  await supabase.from('messages').delete().eq('chat_id', chatId.toString());
  await supabase.from('memory').delete().eq('chat_id', chatId.toString());
  bot.sendMessage(chatId, '🔄 Memoria borrada. Empezamos de cero.');
});

bot.onText(/\/memoria/, async (msg) => {
  const chatId = msg.chat.id;
  const memory = await getMemory(chatId);
  bot.sendMessage(chatId, memory ? `📝 Lo que sé de ti:\n\n${memory}` : 'Aún no tengo contexto guardado sobre ti.');
});

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // Indicador de escritura
  bot.sendChatAction(chatId, 'typing');

  try {
    const reply = await chat(chatId, text);
    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error:', err);
    bot.sendMessage(chatId, '❌ Algo falló. Inténtalo de nuevo.');
  }
});

console.log('🤖 Secretaria Personal arrancada y lista.');
