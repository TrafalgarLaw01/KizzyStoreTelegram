const { MongoClient, ServerApiVersion } = require('mongodb');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const express = require('express');
const app = express();

app.use(express.json());

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const payment = new Payment(mpClient);


// --- NOVO SISTEMA ANTI-CRASH SEGURO ---

process.on('unhandledRejection', (reason, promise) => {
    // Se o erro for de conexão ou "message not modified", ignoramos o log exagerado
    if (reason?.message?.includes('message is not modified')) return;
    if (reason?.code === 'ECONNRESET') {
        console.log('⚠️ [Anti-Crash] Instabilidade de Rede (ECONNRESET) detectada e tratada.');
        return;
    }

    // Para outros erros, mostramos apenas a mensagem e o stack (sem o objeto completo que contém tokens)
    console.error('⚠️ [Anti-Crash] Erro não tratado:', reason.message || reason);
    // Opcional: descomente a linha abaixo se precisar ver onde foi o erro, mas cuidado com logs públicos
    // console.error(reason.stack);
});

process.on('uncaughtException', (error, origin) => {
    console.error(`⚠️ [Anti-Crash] Erro Crítico: ${error.message}`);
    // console.error(error.stack);
});

process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error(`⚠️ [Anti-Crash] Monitor: ${error.message}`);
});
// ---------------------------

/* ================ EXPRESS =============== */
app.get('/', (req, res) => {
  res.send('Kizzy store Online');
});

const PORT = process.env.PORT || 80;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`webhook rodando na porta ${PORT}`);
});


/* ================= MONGO ================= */

const uri = process.env.MONGODB_URI;

// VERIFICAÇÃO DE SEGURANÇA DO MONGODB
if (!uri) {
  console.error("ERRO: VARIAVEL MONGOBD_URI não foi encontrada");
  console.error("verifique se ela esta salva no painel");
}

const mongoClient = new MongoClient(uri || "mongodb://erro_configuracao_painel", {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
let db;
let bot;

async function criarIndices() {
    await users().createIndex({ chatId: 1 }, { unique: true });
    await pagamentos().createIndex({ paymentId: 1 }, { unique: true }); // Evita duplicidade no banco
    await estoque().createIndex({ vendida: 1 }); // Acelera a busca de estoque
}

async function startMongo() {
  try {
  await mongoClient.connect();
  db = mongoClient.db();
  console.log('Mongo conectado');
} catch (err) {
  console.error('Erro MongoDB:', err);
  process.exit(1);
}
}

module.exports = { db };

const users = () => db.collection('users');
const estoque = () => db.collection('estoque');
const pagamentos = () => db.collection('pagamentos');
const config = () => db.collection('config');

const delay = ms => new Promise(res => setTimeout(res, ms));

async function enviarMensagemComRetry(chatId, texto, opcoes = {}, tentativas = 5) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await bot.sendMessage(chatId, texto, opcoes);
    } catch (erro) {
      const msg = erro?.message || '';
      const code = erro?.code;

      // ✅ Telegram 429: Too Many Requests (rate limit)
      // node-telegram-bot-api costuma trazer retry_after aqui:
      const retryAfter =
        erro?.response?.body?.parameters?.retry_after ??
        erro?.response?.body?.retry_after;

      if (Number.isFinite(retryAfter)) {
        const esperaMs = (retryAfter * 1000) + 250; // + folga de 250ms
        console.log(`⏳ [Retry 429] Rate limit. Esperando ${esperaMs}ms e tentando novamente (${i + 1}/${tentativas})...`);
        await delay(esperaMs);
        continue;
      }

      // ✅ Erros de rede comuns (instabilidade)
      const isNetworkError =
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT');

      // ✅ Erros de usuário (bloqueou o bot / chat inválido)
      // Telegram costuma responder 403/400 nesses casos
      const httpStatus = erro?.response?.statusCode || erro?.response?.status;
      const isUserError = httpStatus === 403 || httpStatus === 400;

      if (isUserError) {
        // não adianta tentar novamente
        throw erro;
      }

      // Última tentativa: joga erro
      if (i === tentativas - 1) {
        console.error(`❌ Falha definitiva ao enviar para ${chatId}:`, msg);
        throw erro;
      }

      // Backoff progressivo (mais leve no começo)
      const backoffMs = 800 + (i * 700);

      if (isNetworkError) {
        console.log(`⚠️ Oscilação de rede. Backoff ${backoffMs}ms (${i + 1}/${tentativas})...`);
        await delay(backoffMs);
        continue;
      }

      // Outros erros transitórios (ex.: Telegram instável)
      console.log(`⚠️ Erro ao enviar msg (${i + 1}/${tentativas}): ${msg}. Tentando novamente em ${backoffMs}ms...`);
      await delay(backoffMs);
    }
  }
}

// Função que roda a cada 60 segundos para limpar PIX velho
function iniciarVerificacaoPix() {
  setInterval(async () => {
    try {
      // Define o tempo limite (ex: 10 minutos atrás)
      const tempoLimite = new Date(Date.now() - 10 * 60 * 1000); 

      // Busca pagamentos que:
      // 1. Estão com status 'created' (não pagos)
      // 2. Foram criados ANTES do tempo limite
      // 3. Ainda não foram cancelados no nosso banco
      const expirados = await pagamentos().find({
        status: 'created',
        confirmado: false,
        criadoEm: { $lt: tempoLimite },
        cancelado: { $ne: true } // evita processar o mesmo várias vezes
      }).toArray();

      if (expirados.length === 0) return;

      console.log(`🧹 Limpando ${expirados.length} PIX expirados...`);

      for (const pag of expirados) {
        // 1. Marca como cancelado no banco para não pegar de novo
        await pagamentos().updateOne(
          { _id: pag._id },
          { $set: { cancelado: true, status: 'expired' } }
        );

        // 2. Apaga as mensagens do Telegram (QR Code e Texto)
        // Usamos try/catch caso o usuário já tenha apagado a msg
        if (pag.msgPixId) {
          try { await bot.deleteMessage(pag.chatId, pag.msgPixId); } catch(e){}
        }
        if (pag.msgFotoId) {
          try { await bot.deleteMessage(pag.chatId, pag.msgFotoId); } catch(e){}
        }

        // 3. Avisa o usuário que expirou
        try {
          await bot.sendMessage(pag.chatId, '⚠️ *O tempo para pagamento do PIX expirou.* \nGeramos um novo se você quiser adicionar saldo.', { parse_mode: 'Markdown' });
          
          // 4. (Opcional) Reseta a etapa do usuário para 'menu'
          await setEtapa(pag.chatId, 'menu');
        } catch (e) {
          // Usuário pode ter bloqueado o bot
        }
      }

    } catch (error) {
      console.error('Erro no limpador de PIX:', error);
    }
  }, 60 * 1000); // Roda a cada 60 segundos
}


async function startApp() {
  // 1. Mongo primeiro
  await startMongo();
  await criarIndices();

  // 2. Bot depois
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  // --- COPIE AQUI (IGNORAR ERRO DE CONEXÃO) ---
    bot.on('polling_error', (error) => {
    // Se for erro de conexão resetada, apenas ignora
    if (error.code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
        return;
    }
    console.log(`⚠️ [Polling Error] ${error.code}: ${error.message}`);

  
});


// --------------------------------------------

  try { await bot.deleteWebhook({ drop_pending_updates: true }); } catch(e){}

  iniciarVerificacaoPix();

  console.log('BOT TELEGRAM ONLINE (polling ativo)');

  registrarHandlers();
}

function registrarHandlers(){
  bot.onText(/\/start/, async msg => {
  const user = await getUser(msg.chat.id);
  await setEtapa(msg.chat.id, 'menu');
  const menu = menuPrincipal(user);
  bot.sendMessage(msg.chat.id, menu.text, menu.opts);
});

/* ================= CALLBACK ================= */

bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const user = await getUser(chatId);

  /* ADD SALDO */
  if (q.data === 'add_saldo') {
    await setEtapa(chatId, 'add_saldo');
    return bot.sendMessage(
      chatId,
      '💳 Digite o valor que deseja adicionar\n\n⚠️ Mínimo: R$ 3,00',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }],
            [{ text: '🆘 Suporte', url: process.env.SUPORTE_URL }]
          ]
        }
      }
    );
  }

  /* VOLTAR */
  if (q.data === 'voltar_menu') {
    await users().updateOne(
      { chatId },
      {
        $set: { etapa: 'menu' },
        $unset: { msgCompraId: '' }
      }
    );
    const menu = menuPrincipal(user);
    return bot.sendMessage(chatId, menu.text, menu.opts);
  }

  /* COMPRAR */
  if (q.data === 'comprar') {
    await users().updateOne(
      { chatId }, 
      { 
        $set: { etapa: 'comprar', quantidade: 1 },
        $unset: { msgCompraId: '' }
      }
    );
    const msg = await atualizarTelaCompra(chatId, true);
await users().updateOne(
  { chatId },
  { $set: { msgCompraId: msg.message_id } }
);

return;

  }

  /* QUANTIDADE */
  if (q.data === 'mais' || q.data === 'menos') {
    let qtd = user.quantidade;
    if (q.data === 'mais') qtd++;
    if (q.data === 'menos' && qtd > 1) qtd--;
    await users().updateOne(
      { chatId }, 
      { $set: { quantidade: qtd } }
    );

    await atualizarTelaCompra(chatId);

    return;

  }

  /* CONFIRMAR COMPRA */
  if (q.data === 'confirmar_compra') {
    return confirmarCompra(chatId);
  }
});

bot.onText(/\/addsaldo (.+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    
    const args = match[1].split(' '); 
    const targetId = Number(args[0]); 
    const valor = parseFloat(args[1]); 

    if (!targetId || isNaN(valor)) {
        return bot.sendMessage(msg.chat.id, "❌ Uso correto: `/addsaldo ID VALOR`");
    }

    // DEBUG: Ver saldo antes
    const antes = await users().findOne({ chatId: targetId });
    console.log(`[DEBUG ADDSALDO] Saldo Atual ID ${targetId}: ${antes?.saldo}`);

    const res = await users().updateOne(
        { chatId: targetId },
        { $inc: { saldo: valor } }
    );

    if (res.matchedCount > 0) {
        // DEBUG: Ver saldo depois
        const depois = await users().findOne({ chatId: targetId });
        console.log(`[DEBUG ADDSALDO] Novo Saldo ID ${targetId}: ${depois?.saldo}`);

        bot.sendMessage(msg.chat.id, `✅ R$ ${valor.toFixed(2)} adicionados.\nNovo saldo no banco: R$ ${depois.saldo.toFixed(2)}`);
        
        enviarMensagemComRetry(targetId, `🎁 Você recebeu R$ ${valor.toFixed(2)} de bônus!`).catch(()=>{});
    } else {
        bot.sendMessage(msg.chat.id, "❌ Usuário não encontrado no banco de dados.");
    }
});

// COMANDO: Avisar Todos (Manutenção/Novidades)
// Uso: /avisar MENSAGEM
bot.onText(/\/avisar (.+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;

    const mensagem = match[1];
    bot.sendMessage(msg.chat.id, "📣 Enviando mensagem para todos...");

    const allUsers = await users().find().toArray();
    let count = 0;

    for (const u of allUsers) {
        try {
            // Pequeno delay para não travar o bot
            await new Promise(r => setTimeout(r, 300));
            await bot.sendMessage(u.chatId, `📢 *AVISO IMPORTANTE*\n\n${mensagem}`, { parse_mode: 'Markdown' });
            count++;
        } catch (e) {
            // Ignora quem bloqueou o bot
        }
    }
    bot.sendMessage(msg.chat.id, `✅ Enviado para ${count} usuários.`);
});

bot.onText(/\/estoque/, async (msg) => {
  // 1. Segurança: Só admin pode ver
  if (!isAdmin(msg.chat.id)) return;

  try {
    // 2. Conta rapidinho no banco
    const disponiveis = await estoque().countDocuments({ vendida: false });
    const vendidas = await estoque().countDocuments({ vendida: true });
    const total = disponiveis + vendidas;

    // 3. Mostra o relatório
    const resposta = 
`📊 *Relatório de Estoque*

✅ *Disponíveis:* ${disponiveis}
❌ *Vendidas:* ${vendidas}
📦 *Total cadastrado:* ${total}

${disponiveis === 0 ? '⚠️ *ATENÇÃO: ESTOQUE ZERADO!*' : ''}`;

    bot.sendMessage(msg.chat.id, resposta, { parse_mode: 'Markdown' });

  } catch (err) {
    bot.sendMessage(msg.chat.id, 'Erro ao consultar estoque.');
    console.error(err);
  }
});

bot.onText(/\/addconta/, async msg => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Sem permissão.');

  bot.sendMessage(
    msg.chat.id,
`📥 *Exemplo de uso:*

email1:senha1
email2:senha2

Envie as contas no próximo envio.`,
    { parse_mode: 'Markdown' }
  );

  bot.once('message', async m => {
    if (!isAdmin(m.chat.id)) return;
    const linhas = m.text.split('\n');
    const docs = linhas
      .filter(l => l.includes(':'))
      .map(l => {
        const [login, senha] = l.split(':');
        return { login, senha, vendida: false };
      });

    if (docs.length) {
      await estoque().insertMany(docs);
      await broadcast();
    }

    bot.sendMessage(msg.chat.id, `✅ ${docs.length} contas adicionadas.`);
  });
});

bot.onText(/\/limparcontas/, async msg => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Sem permissão.');
  const r = await estoque().deleteMany({ vendida: true });
  bot.sendMessage(msg.chat.id, `♻️ ${r.deletedCount} contas removidas.`);
});

bot.onText(/\/preco (.+)/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Sem permissão.');
  const valor = parseFloat(match[1].replace(',', '.'));
  if (isNaN(valor)) return bot.sendMessage(msg.chat.id, '❌ Valor inválido.');

  await config().updateOne(
    { key: 'preco' },
    { $set: { valor } },
    { upsert: true }
  );

  bot.sendMessage(msg.chat.id, `💲 Preço atualizado: R$ ${valor.toFixed(2)}`);
});

bot.on('message', async msg => {
  // ignora comandos
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const user = await getUser(chatId);

  // ===== ADD SALDO =====
  if (user.etapa === 'add_saldo') {
    
    const texto = msg.text.trim().replace(',', '.');
    const valor = Number(texto);

if (!Number.isFinite(valor)) {
  return bot.sendMessage(chatId, '❌ Digite apenas números. Ex: 10 ou 5.50');
}

if (valor < 3) {
  return bot.sendMessage(chatId, '⚠️ O valor mínimo é R$ 3,00.');
}


    let pagamento;
    let msgPixEnviada;

    // cria pagamento PIX
    try {
      pagamento = await criarPix(chatId, valor);
    } catch (e) {
      return bot.sendMessage(
        chatId,
        '❌ Erro ao gerar o PIX. Tente novamente em alguns instantes.'
      );
    }

    msgPixEnviada = await bot.sendMessage(
      chatId,
      `💳 *PIX GERADO COM SUCESSO*

💰 Valor: R$ ${valor.toFixed(2)}
📋 *Copia e cola (clique abaixo para copiar):*
\`${pagamento.qrCode}\`

_⏳ Aguardando pagamento... Assim que confirmado, esta mensagem sumirá e o saldo cairá._`,
      { parse_mode: 'Markdown' }
    );

    await pagamentos().updateOne(
      { paymentId: pagamento.id },
      { $set: { msgPixId: msgPixEnviada.message_id } }
    );

    if (pagamento.qrCodeBase64) {
      const msgFoto = await bot.sendPhoto(
        chatId,
        Buffer.from(pagamento.qrCodeBase64, 'base64'),
        { caption: '📲 Escaneie o QR Code acima' }
      );

      await pagamentos().updateOne(
        { paymentId: pagamento.id },
        { $set: { msgFotoId: msgFoto.message_id } }
      );
    }

    await setEtapa(chatId, 'menu');
  }
  });

}
/*============FIM HANDLERS =================*/

/*============ RESPOSTA PAGAMENTO (FINAL) =========== */
/*============ RESPOSTA PAGAMENTO (FINAL/DEBUG) =========== */
/*============ RESPOSTA PAGAMENTO (FINAL BLINDADO) =========== */
app.post('/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    
    // 1. Extração Inteligente do ID
    let paymentIdRaw = body.data?.id || body.id || body.resource;
    
    // Tratamento para URLs no resource
    if (paymentIdRaw && String(paymentIdRaw).includes('/')) {
        const partes = String(paymentIdRaw).split('/');
        paymentIdRaw = partes[partes.length - 1];
    }

    if (!paymentIdRaw) return; 

    const paymentId = String(paymentIdRaw);
    
    // 2. Verifica se o pagamento existe no NOSSO banco
    const pDb = await pagamentos().findOne({ paymentId });
    
    if (!pDb) return; // Não existe ou não é nosso
    if (pDb.confirmado) return; // Já pago, ignora duplicações

    // 3. Consulta status no Mercado Pago
    let mpStatus = 'unknown';
    let valorPago = 0;
    
    try {
        const mpRes = await payment.get({ id: paymentIdRaw });
        const mpData = mpRes?.body ?? mpRes;
        mpStatus = mpData.status;
        valorPago = Number(mpData.transaction_amount);
    } catch (e) {
        console.error(`❌ Erro MP: ${e.message}`);
        return;
    }

    // 4. Se não aprovou, tchau
    if (mpStatus !== 'approved') return;

    // 5. Trava de Segurança (Atomicidade)
    const locked = await pagamentos().findOneAndUpdate(
      { paymentId, confirmado: false },
      { $set: { confirmado: true, confirmadoEm: new Date(), mpStatus: mpStatus } },
      { returnDocument: 'after' }
    );

    // --- CORREÇÃO DO ERRO NULL ---
    if (!locked) return; // Se for null, outro processo já pegou. Para aqui.
    
    const pag = locked.value || locked; // Garante compatibilidade
    if (!pag) return; // Segurança extra

    console.log(`🚀 PAGAMENTO APROVADO! ID: ${paymentId} (+R$ ${valorPago})`);

    // 6. Credita saldo
    await users().updateOne({ chatId: pDb.chatId }, { $inc: { saldo: valorPago } });

    // 7. Limpa mensagens
    const apagar = async (id) => { try { await bot.deleteMessage(pDb.chatId, id); } catch(e){} };
    await apagar(pDb.msgPixId);
    await apagar(pDb.msgFotoId);

    // 8. Avisa usuário
    try {
      const userAtual = await getUser(pDb.chatId);
      await enviarMensagemComRetry(
        pDb.chatId,
        `✅ *Pagamento Confirmado!*\n\n💰 + R$ ${valorPago.toFixed(2)} adicionados.`,
        { parse_mode: 'Markdown' }
      );
      const menu = menuPrincipal(userAtual);
      await enviarMensagemComRetry(pDb.chatId, menu.text, menu.opts);
    } catch (e) {}

  } catch (err) {
    console.error('Erro Webhook:', err.message);
  }
});



/* ================= CONFIG PADRÃO ================= */

async function getPreco() {
  const cfg = await config().findOne({ key: 'preco' });
  return cfg ? cfg.valor : 0.70;
}

/* ================ CRIAR PIX (CORRIGIDO) ============== */

async function criarPix(chatId, valor) {
  try {
    if (!Number.isFinite(valor) || valor <= 0) {
      throw new Error(`VALOR_INVALIDO_PIX: ${valor}`);
    }

    const valorFix = Number(valor.toFixed(2));

    const res = await payment.create({
      body: {
        transaction_amount: valorFix,
        description: 'Adicionar saldo - Kizzy Store',
        payment_method_id: 'pix',
        payer: { email: `user${chatId}@kizzystore.com` },

        // ajuda na validação e rastreio
        external_reference: String(chatId),
        metadata: { chatId, purpose: 'saldo', expectedValue: valorFix },

        notification_url: `${process.env.BASE_URL}/webhook/mercadopago`
      }
    });

    const data = res?.body ?? res;
    const paymentId = data?.id;
    const td = data?.point_of_interaction?.transaction_data;

    if (!paymentId) throw new Error('MP não retornou ID de pagamento');
    if (!td?.qr_code) throw new Error('MP não retornou qr_code');

    // salva no banco
    await pagamentos().insertOne({
      chatId,
      paymentId: String(paymentId),
      valor: valorFix,
      status: data?.status ?? 'created',
      confirmado: false,
      criadoEm: new Date()
    });

    console.log(`✅ PIX criado. paymentId=${paymentId} valor=R$${valorFix}`);

    return {
      id: String(paymentId),
      qrCode: td.qr_code,
      qrCodeBase64: td.qr_code_base64 || null
    };

  } catch (err) {
    console.error('❌ Erro ao criar PIX Mercado Pago:', err?.message || err);
    throw new Error('ERRO_MP');
  }
}



/* ================= USUÁRIO ================= */

async function getUser(chatId) {
  let user = await users().findOne({ chatId });
  if (!user) {
    user = {
      chatId,
      saldo: 0,
      etapa: 'menu',
      quantidade: 1
    };
    await users().insertOne(user);
  }
  return user;
}

async function setEtapa(chatId, etapa) {
  await users().updateOne({ chatId }, { $set: { etapa } });
}

/* ================= MENUS ================= */

function menuPrincipal(user) {
  return {
    text:
`🛒 *Bem-vindo à Kizzy Store*

• 👤 ID: ${user.chatId}
• 💰 Saldo: R$ ${user.saldo.toFixed(2)}`,
    opts: {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Adicionar saldo', callback_data: 'add_saldo' }],
          [{ text: '🛍 Comprar contas', callback_data: 'comprar' }],
          [{ text: '🆘 Suporte', url: process.env.SUPORTE_URL }]
        ]
      }
    }
  };
}


/* ================= TELA COMPRA ================= */

async function atualizarTelaCompra(chatId, nova = false) {
  const user = await getUser(chatId);
  const preco = await getPreco();
  const estoqueQtd = await estoque().countDocuments({ vendida: false });
  const total = user.quantidade * preco;

  const texto = 
`📦 *Contas Outlook – Alta Qualidade*

• 💵 Preço: R$ ${preco.toFixed(2)}
• 📦 Quantidade: ${user.quantidade}
• 🧮 Total: R$ ${total.toFixed(2)}
• 💰 Seu saldo: R$ ${user.saldo.toFixed(2)}
• 📊 Estoque: ${estoqueQtd}`;


  const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➖', callback_data: 'menos' },
            { text: `${user.quantidade}`, callback_data: 'noop' },
            { text: '➕', callback_data: 'mais' }
          ],
          [{ text: '✅ Comprar', callback_data: 'confirmar_compra' }],
          [{ text: '⬅️ Voltar', callback_data: 'voltar_menu' }],
          [{ text: '🆘 Suporte', url: process.env.SUPORTE_URL }]
        ]
      }
    };

    if (nova || !user.msgCompraId){
      return bot.sendMessage(chatId, texto, opts);
    }
    try {
      return await bot.editMessageText(texto, {
        chat_id: chatId,
        message_id: user.msgCompraId,
        ...opts
      });
    } catch (err) {
      if (err.message && err.message.includes('message is not modified')) return;
      return bot.sendMessage(chatId, texto, opts);
    }
}


/* ================= CONFIRMAR COMPRA (SEGURA) ================= */
/* ================= CONFIRMAR COMPRA (CORRIGIDO) ================= */
async function confirmarCompra(chatId) {
  const user = await getUser(chatId);
  const preco = await getPreco();
  const totalPrevisto = Number((user.quantidade * preco).toFixed(2));

  console.log(`[DEBUG] Tentando comprar. User: ${chatId} | Saldo Atual: ${user.saldo} | Custo: ${totalPrevisto}`);

  // 1) Debita saldo primeiro (Atômico)
  const result = await users().findOneAndUpdate(
    { chatId, saldo: { $gte: totalPrevisto } },
    {
      $inc: { saldo: -totalPrevisto },
      $set: { etapa: 'menu', quantidade: 1 },
      $unset: { msgCompraId: '' }
    },
    { returnDocument: 'after' }
  );

  // --- AQUI ESTAVA O ERRO ---
  // Nas versoes novas do Mongo, o result já é o documento.
  // Nas antigas, é result.value. Essa linha abaixo resolve para ambas.
  const userDebitado = result.value || result; 

  if (!userDebitado) {
    console.log(`[DEBUG] Falha no débito. Saldo insuficiente.`);
    return bot.sendMessage(chatId, `❌ Saldo insuficiente. Você tem R$ ${user.saldo.toFixed(2)} e precisa de R$ ${totalPrevisto.toFixed(2)}`);
  }

  console.log(`[DEBUG] Débito OK. Novo Saldo: ${userDebitado.saldo}`);

  // 2) Agora tenta pegar as contas
  const contasParaEntregar = [];
  try {
    for (let i = 0; i < user.quantidade; i++) {
      const item = await estoque().findOneAndUpdate(
        { vendida: false },
        { $set: { vendida: true, vendidaEm: new Date(), compradorId: chatId } },
        { returnDocument: 'after' }
      );

      const doc = item?.value ?? item; 
      if (doc && doc.login) {
        contasParaEntregar.push(doc);
      } else {
        break;
      }
    }

    // 3) Se faltou estoque no meio, desfaz tudo + estorna saldo
    if (contasParaEntregar.length < user.quantidade) {
      // Devolve o estoque parcial
      if (contasParaEntregar.length > 0) {
        const ids = contasParaEntregar.map(c => c._id);
        await estoque().updateMany(
          { _id: { $in: ids } },
          { $set: { vendida: false }, $unset: { vendidaEm: "", compradorId: "" } }
        );
      }

      // Estorna saldo
      await users().updateOne(
        { chatId },
        { $inc: { saldo: totalPrevisto } }
      );

      return bot.sendMessage(chatId, '❌ Estoque insuficiente no momento da transação. Seu saldo foi estornado.');
    }

    // 4) Entrega
    let entrega = '✅ *Compra realizada com sucesso!*\n\n⬇️ *Suas contas:*\n\n';
    contasParaEntregar.forEach(c => {
      entrega += `📧 \`${c.login}:${c.senha}\`\n`;
    });

    try {
      await enviarMensagemComRetry(chatId, entrega, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`🚨 Usuário ${chatId} comprou mas falhou envio.`);
    }

    const userAtualizado = await getUser(chatId);
    const menu = menuPrincipal(userAtualizado);
    return bot.sendMessage(chatId, menu.text, menu.opts);

  } catch (err) {
    console.error('Erro confirmarCompra:', err?.message || err);
    // Reembolso de emergência
    if (contasParaEntregar.length > 0) {
       // ... lógica de devolução de estoque ...
    }
    await users().updateOne({ chatId }, { $inc: { saldo: totalPrevisto } });
    return bot.sendMessage(chatId, '❌ Ocorreu um erro na compra. Seu saldo foi estornado.');
  }
}


// COMANDO: Adicionar Saldo Manualmente


// ----------------------------------

/* ================= ADMIN ================= */

function isAdmin(id) {
  return id.toString() === process.env.ADMIN_ID;
}





    


/* ================= BROADCAST ================= */

async function broadcast() {
  const all = await users().find().toArray();
  for (const u of all) {
    try {
      await delay(300);
      await enviarMensagemComRetry(
      u.chatId,
      '📦 *Novo Estoque Disponível!*',
      {
        parse_mode: 'markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛍 Comprar Agora', callback_data: 'comprar' }],
            [{ text: '🆘 Suporte', url: process.env.SUPORTE_URL }]
          ]
        }
      }
    );
  } catch (err) {
    // usuario bloqueou o bot, ignora
  }
}
}

startApp();
