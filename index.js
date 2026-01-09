const { MongoClient, ServerApiVersion } = require('mongodb');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const express = require('express');
const app = express();

app.use(express.json());

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const payment = new Payment(mpClient);

/* ================ EXPRESS =============== */
app.get('/', (req, res) => {
  res.send('Kizzy store Online');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`webhook rodando na porta ${PORT}`);
});


/* ================= MONGO ================= */

const uri = process.env.MONGODB_URI;

const mongoClient = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
let db;
let bot;

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

async function startApp() {
  // 1. Mongo primeiro
  await startMongo();

  // 2. Bot depois
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  await bot.deleteWebHook({ drop_pending_updates: true });

  console.log('BOT TELEGRAM ONLINE (polling ativo)');

/*============ resposta pagamento =========== */
app.post('/webhook/mercadopago', async (req, res) => {
  const paymentId = req.body.data?.id;
  if (!paymentId) return res.sendStatus(200);

  const mpData = await payment.get({ id: paymentId });

  if (mpData.status === 'approved') {
    const pag = await pagamentos().findOne({ paymentId });

    if (pag && !pag.confirmado) {
      await users().updateOne(
        { chatId: pag.chatId },
        { $inc: { saldo: pag.valor } }
      );

      await pagamentos().updateOne(
        { paymentId },
        { $set: { confirmado: true } }
      );

      bot.sendMessage(
        pag.chatId,
        `✅ *Pagamento confirmado!*\n\n💰 Saldo adicionado: R$ ${pag.valor.toFixed(2)}`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  res.sendStatus(200);
});

/* ================= CONFIG PADRÃO ================= */

async function getPreco() {
  const cfg = await config().findOne({ key: 'preco' });
  return cfg ? cfg.valor : 0.70;
}

/* ================ CRIAR PIX ============== */

async function criarPix(chatId, valor) {
  try {
    if (!Number.isFinite(valor) || valor <= 0) {
  throw new Error(`VALOR_INVALIDO_PIX: ${valor}`);
}
  console.log('URL de notificação:', `${process.env.BASE_URL}/webhook/mercadopago`);

  const res = await payment.create({
    body: {
    transaction_amount: Number(valor.toFixed(2)),
    description: 'Adicionar saldo - Kizzy Store',
    payment_method_id: 'pix',
    payer: {
      email: `user${chatId}@kizzystore.com`
    },
    notification_url: `${process.env.BASE_URL}/webhook/mercadopago`
  }
  });

  await pagamentos().insertOne({
    chatId,
    valor,
    paymentId: res.id,
    status: res.status,
    criadoEm: new Date()
  });

  return {
    id: res.id,
    qrCode: res.point_of_interaction.transaction_data.qr_code,
    qrCodeBase64: res.point_of_interaction.transaction_data.qr_code_base64
  };
} catch (err){
  console.error('❌ Erro ao criar PIX Mercado Pago:', err);
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


/* ================= START ================= */

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
      return bot.editMessageText(texto, {
        chat_id: chatId,
        message_id: user.msgCompraId,
        ...opts
      });
    } catch (err) {
      return bot.sendMessage(chatId, texto, opts);
    }
}

/* ================= CONFIRMAR COMPRA ================= */

async function confirmarCompra(chatId) {
  const user = await getUser(chatId);
  const preco = await getPreco();
  const total = user.quantidade * preco;

  if (user.saldo < total) {
    return bot.sendMessage(chatId, '❌ Saldo insuficiente.');
  }

  const contas = await estoque()
    .find({ vendida: false })
    .limit(user.quantidade)
    .toArray();

  if (contas.length < user.quantidade) {
    return bot.sendMessage(chatId, '❌ Estoque insuficiente.');
  }

  const ids = contas.map(c => c._id);

  await users().updateOne(
    { chatId },
    { 
      $inc: { saldo: -total }, 
      $set: { etapa: 'menu', quantidade: 1 },
      $unset: { msgCompraId: '' }
    }
  );

  await estoque().updateMany(
    { _id: { $in: ids } },
    { $set: { vendida: true, vendidaEm: new Date() } }
  );

  let entrega = '✅ *Compra realizada!*\n\n';
  contas.forEach(c => {
    entrega += `${c.login}:${c.senha}\n`;
  });

  await bot.sendMessage(chatId, entrega, { parse_mode: 'Markdown' });

  const menu = menuPrincipal(await getUser(chatId));
  bot.sendMessage(chatId, menu.text, menu.opts);
}

/* ================= ADMIN ================= */

function isAdmin(id) {
  return id.toString() === process.env.ADMIN_ID;
}

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

    // cria pagamento PIX
    try {
      pagamento = await criarPix(chatId, valor);
    } catch (e) {
      return bot.sendMessage(
        chatId,
        '❌ Erro ao gerar o PIX. Tente novamente em alguns instantes.'
      );
    }
    
    await bot.sendMessage(
      chatId,
`💳 *PIX GERADO COM SUCESSO*

💰 Valor: R$ ${valor.toFixed(2)}

📋 *Copia e cola:*
\`${pagamento.qrCode}\``,
      { parse_mode: 'Markdown' }
    );

    if (pagamento.qrCodeBase64) {
      await bot.sendPhoto(
        chatId,
        Buffer.from(pagamento.qrCodeBase64, 'base64'),
        { caption: '📲 Escaneie o QR Code para pagar' }
      );
    }

    await setEtapa(chatId, 'menu');
  }
});


/* ================= BROADCAST ================= */

async function broadcast() {
  const all = await users().find().toArray();
  for (const u of all) {
    bot.sendMessage(
      u.chatId,
      '📦 Estoque abastecido!',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🆘 Suporte', url: process.env.SUPORTE_URL }]
          ]
        }
      }
    );
  }
}
}
startApp();
