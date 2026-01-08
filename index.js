const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');

process.on('unhandledRejection', (reason) => {
  console.error('PROMISE NÃO TRATADA:', reason);
});


// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const app = express();
app.use(express.json());


if (!TOKEN) {
  console.error('BOT_TOKEN não definido');
  process.exit(1);
}


const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

if (!process.env.MP_ACCESS_TOKEN) {
  console.error('MP_ACCESS_TOKEN não definido');
  process.exit(1);
}

const payment = new Payment(client);

app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type !== 'payment') {
      return res.sendStatus(200);
    }

    const paymentId = data.id;

    const mpPayment = await payment.get({ id: paymentId });

    if (mpPayment.status !== 'approved') {
      return res.sendStatus(200);
    }

    let recargas = ler('recargas.json', []);
    if (!Array.isArray(recargas)) recargas = [];

    const recarga = recargas.find(r => r.paymentId == paymentId);

    if (!recarga || recarga.status === 'APROVADO') {
      return res.sendStatus(200);
    }

    // MARCA COMO APROVADO
    recarga.status = 'APROVADO';

    // CREDITAR SALDO
    const user = getUsuario(recarga.chatId);
    user.saldo += recarga.valor;
    atualizarUsuario(recarga.chatId, user);

    salvar('recargas.json', recargas);

    // AVISAR USUÁRIO
    bot.sendMessage(recarga.chatId,
      `✅ *Pagamento confirmado!*\n\n` +
      `💰 Valor creditado: R$${recarga.valor.toFixed(2)}\n` +
      `💳 Saldo atual: R$${user.saldo.toFixed(2)}`,
      { parse_mode: 'Markdown' }
    );

    res.sendStatus(200);

  } catch (err) {
    console.error('Erro webhook MP:', err);
    res.sendStatus(500);
  }
});



const bot = new TelegramBot(TOKEN);

// ================= UTIL =================
const ler = (arq, padrao = {}) => {
  if (!fs.existsSync(arq)) {
    fs.writeFileSync(arq, JSON.stringify(padrao, null, 2));
    return padrao;
}
  return JSON.parse(fs.readFileSync(arq));
};

const salvar = (arq, data) =>
  fs.writeFileSync(arq, JSON.stringify(data, null, 2));


if (!process.env.RENDER_EXTERNAL_URL) {
    console.error('RENDER_EXTERNAL_RUL não definido');
    process.exit(1);
  }

const WEBHOOK_URL = 
  `${process.env.RENDER_EXTERNAL_URL}/bot${TOKEN}`;
  

bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log('webhook configurado:', WEBHOOK_URL))
  .catch(err => console.error('erro ao configurar webhook:', err));

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});


// ================= USUÁRIOS =================
function getUsuario(chatId) {
  let usuarios = ler('usuarios.json', {});
  if (!usuarios[chatId]) {
    usuarios[chatId] = { saldo: 0, carrinho: 1 };
    salvar('usuarios.json', usuarios);
  }
  return usuarios[chatId];
}

function atualizarUsuario(chatId, dados) {
  let usuarios = ler('usuarios.json', {});
  usuarios[chatId] = dados;
  salvar('usuarios.json', usuarios);
}

// ================= ESTOQUE =================
function estoqueDisponivel() {
  let estoque = ler('estoque.json', { contas: [] });
  if (!estoque.contas) estoque.contas = [];
  return estoque.contas.filter(c => !c.vendida).length;
}

function retirarContas(qtd) {
  let estoque = ler('estoque.json', { contas: [] });
  if (!estoque.contas) estoque.contas = [];

  const disponiveis = estoque.contas
    .filter(c => !c.vendida)
    .slice(0, qtd);
  
  disponiveis.forEach(c => c.vendida = true);
  salvar('estoque.json', estoque);
  return disponiveis;
}

// ================= TECLADO =================
function tecladoQuantidade(qtd) {
  return {
    inline_keyboard: [
      [
        { text: '➖', callback_data: 'menos' },
        { text: ` ${qtd} `, callback_data: 'qtd' },
        { text: '➕', callback_data: 'mais' }
      ],
      [{ text: '🛒 Comprar', callback_data: 'comprar' }]
    ]
  };
}

// ================= PIX =================
async function criarPix(valor, userId) {
  const response = await payment.create({
    body: {
      transaction_amount: valor,
      description: "Recarga de saldo",
      payment_method_id: "pix",
      payer: {
        email: `${userId}@telegram.com`
      }
    }
  });

  return {
    paymentId: response.id,
    qrCode: response.point_of_interaction.transaction_data.qr_code,
    qrBase64: response.point_of_interaction.transaction_data.qr_code_base64
  };
}


// ================= ESTADOS =================
let aguardandoValorRecarga = {};

// ================= START =================
bot.onText(/\/start/, (msg) => {
  getUsuario(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    '🛒 Bot de Vendas\n\n💰 Use saldo para comprar',
    {
      reply_markup: {
        keyboard: [
          ['💰 Meu saldo'],
          ['🛒 Comprar contas'],
          ['➕ Recarregar saldo']
        ],
        resize_keyboard: true
      }
    }
  );
});

// ================= MENSAGENS =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const user = getUsuario(chatId);
  //ADMIN - ADICIONAR CONTA
  if (aguardandoContaAdmin[chatId] && chatId === ADMIN_ID){
    if (!msg.text.includes(':')) {
      bot.sendMessage(chatId, '❌ Formato inválido. Use login:senha');
      return;
    }

    const [login, senha] = msg.text.split(':');

    const estoque = ler('estoque.json', { contas: [] });
    estoque.contas.push({
      login: login.trim(),
      senha: senha.trim(),
      vendida: false
    });

    salvar('estoque.json', estoque);
    aguardandoContaAdmin[chatId] = false;

    bot.sendMessage(chatId, '✅ Conta adicionada ao estoque!');
    return;
  }

  // RECARREGAR
  if (msg.text === '➕ Recarregar saldo') {
    aguardandoValorRecarga[chatId] = true;
    bot.sendMessage(chatId,
      `💳 Saldo atual: R$${user.saldo.toFixed(2)}\n\n` +
      `Digite o valor da recarga (mínimo R$3,00)`
    );
    return;
  }

  // VALOR DA RECARGA
  if (aguardandoValorRecarga[chatId]) {
    const valor = Number(msg.text.replace(',', '.'));

    if (isNaN(valor) || valor < 3) {
      bot.sendMessage(chatId, '❌ Valor inválido. Mínimo R$3,00');
      return;
    }

    aguardandoValorRecarga[chatId] = false;

    try {
  const pix = await criarPix(valor, chatId);

  let recargas = ler('recargas.json', []);
  if (!Array.isArray(recargas)) recargas = [];

  recargas.push({
    chatId,
    valor,
    paymentId: pix.paymentId,
    status: 'PENDENTE'
  });

  salvar('recargas.json', recargas);

  const qrBuffer = Buffer.from(pix.qrBase64, 'base64');

await bot.sendPhoto(chatId, qrBuffer, {
  caption:
    `💳 *PIX GERADO*\n\n` +
    `💰 Valor: R$${valor.toFixed(2)}\n\n` +
    `📋 PIX Copia e Cola:\n` +
    `\`${pix.qrCode}\`\n\n` +
    `⏳ Após o pagamento, seu saldo será creditado automaticamente.`,
  parse_mode: 'Markdown'
});


} catch (err) {
  console.error('Erro ao gerar PIX:', err);

  bot.sendMessage(chatId,
    '❌ Erro ao gerar o PIX.\n\n' +
    'Tente novamente em alguns minutos.'
  );
}

    return;
  }

  // SALDO
  if (msg.text === '💰 Meu saldo') {
    bot.sendMessage(chatId,
      `💳 Saldo: R$${user.saldo.toFixed(2)}`
    );
  }

  // COMPRAR
  if (msg.text === '🛒 Comprar contas') {
    const estoque = estoqueDisponivel();
    bot.sendMessage(chatId,
      `📦 Conta Premium\n` +
      `💵 Preço: R$${PRECO_ATUAL.toFixed(2)}\n` +
      `📊 Estoque: ${estoque}`,
      { reply_markup: tecladoQuantidade(user.carrinho) }
    );
  }
});

// ================= CALLBACK =================
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const user = getUsuario(chatId);
  const estoque = estoqueDisponivel();

  if (query.data === 'mais' && user.carrinho < estoque) user.carrinho++;
  if (query.data === 'menos' && user.carrinho > 1) user.carrinho--;

  if (query.data === 'comprar') {
    const total = user.carrinho * PRECO_ATUAL;

    if (user.saldo < total) {
      bot.answerCallbackQuery(query.id, {
        text: 'Saldo insuficiente',
        show_alert: true
      });
      return;
    }

    const contas = retirarContas(user.carrinho);
    user.saldo -= total;
    user.carrinho = 1;
    atualizarUsuario(chatId, user);

    let msg = '✅ COMPRA REALIZADA\n\n';
    contas.forEach((c, i) => {
      msg += `Conta ${i + 1}\nLogin: ${c.login}\nSenha: ${c.senha}\n\n`;
    });

    bot.sendMessage(chatId, msg);
    return;
  }

  atualizarUsuario(chatId, user);

  bot.editMessageReplyMarkup(
    tecladoQuantidade(user.carrinho),
    {
      chat_id: chatId,
      message_id: query.message.message_id
    }
  );
});

// ================= ADMIN =================

let aguardandoContaAdmin = {};
let PRECO_ATUAL = 0.70;

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;

  if (chatId !== ADMIN_ID) {
    bot.sendMessage(chatId, '⛔ Acesso negado. Você não é admin.');
    return;
  }

  bot.sendMessage(chatId,
    '🔧 *PAINEL ADMIN*\n\n' +
    'Escolha uma opção:\n\n' +
    '📦 /estoque → Ver estoque\n' +
    '➕ /addconta → Adicionar conta',
    { parse_mode: 'Markdown' }
  );
});

// VER ESTOQUE
bot.onText(/\/estoque/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;

  const estoque = ler('estoque.json', { contas: [] });
  const total = estoque.contas?.length || 0;
  const disponiveis = estoque.contas?.filter(c => !c.vendida).length || 0;

  bot.sendMessage(msg.chat.id,
    `📦 *ESTOQUE*\n\n` +
    `Total: ${total}\n` +
    `Disponíveis: ${disponiveis}`,
    { parse_mode: 'Markdown' }
  );
});

// ADICIONAR CONTA
bot.onText(/\/addconta/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;

  aguardandoContaAdmin[msg.chat.id] = true;

  bot.sendMessage(msg.chat.id,
    '✍️ Envie a conta no formato:\n\n' +
    '`login:senha`',
    { parse_mode: 'Markdown' }
  );
});

// ALTERAR PREÇO
bot.onText(/\/setpreco (.+)/, (msg, match) => {
  if (msg.chat.id !== ADMIN_ID) return;

  const novoPreco = Number(match[1].replace(',', '.'));

  if (isNaN(novoPreco) || novoPreco <= 0) {
    bot.sendMessage(msg.chat.id, '❌ Preço inválido.');
    return;
  }

  PRECO_ATUAL = novoPreco;

  bot.sendMessage(msg.chat.id,
    `✅ Preço atualizado com sucesso!\n\n💵 Novo valor: R$${PRECO_ATUAL.toFixed(2)}`
  );
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});



