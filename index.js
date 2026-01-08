const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { MercadoPagoConfig, Payment } = require('mercadopago');

process.on('unhandledRejection', (reason) => {
  console.error('PROMISE NÃO TRATADA:', reason);
});


// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 1510068690;
const app = express();

if (!TOKEN) {
  console.error('BOT_TOKEN não definido');
  process.exit(1);
}


const client = new MercadoPagoConfig({
  accessToken: 'APP_USR-4806665999726140-010813-53d60c1686c0b8598c0b6b1d5e1a0a61-357031441'
});

const payment = new Payment(client);


const bot = new TelegramBot(TOKEN);
app.use(express.json());

// ================= UTIL =================
const ler = (arq) => {
  if (!fs.existsSync(arq)) fs.writeFileSync(arq, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(arq));
};

const salvar = (arq, data) =>
  fs.writeFileSync(arq, JSON.stringify(data, null, 2));

const express = require('express');

app.use(express.json());

const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + `/bot${TOKEN}`;

bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log('erbhook configurado:', WEBHOOK_URL))
  .catch(erro => console.error('erro ao configurar webhook:', err));

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});


// ================= USUÁRIOS =================
function getUsuario(chatId) {
  const usuarios = ler('usuarios.json');
  if (!usuarios[chatId]) {
    usuarios[chatId] = { saldo: 0, carrinho: 1 };
    salvar('usuarios.json', usuarios);
  }
  return usuarios[chatId];
}

function atualizarUsuario(chatId, dados) {
  const usuarios = ler('usuarios.json');
  usuarios[chatId] = dados;
  salvar('usuarios.json', usuarios);
}

// ================= ESTOQUE =================
function estoqueDisponivel() {
  const estoque = ler('estoque.json');
  if (!estoque.contas) estoque.contas = [];
  return estoque.contas.filter(c => !c.vendida).length;
}

function retirarContas(qtd) {
  const estoque = ler('estoque.json');
  const disponiveis = estoque.contas.filter(c => !c.vendida).slice(0, qtd);
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

  let recargas = ler('recargas.json');
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
      `💵 Preço: R$1,00\n` +
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
    const total = user.carrinho * 1;

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

  const estoque = ler('estoque.json');
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

// RECEBER CONTA
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  if (!aguardandoContaAdmin[chatId]) return;
  if (chatId !== ADMIN_ID) return;

  if (!msg.text.includes(':')) {
    bot.sendMessage(chatId, '❌ Formato inválido. Use login:senha');
    return;
  }

  const [login, senha] = msg.text.split(':');

  const estoque = ler('estoque.json');
  if (!estoque.contas) estoque.contas = [];

  estoque.contas.push({
    login: login.trim(),
    senha: senha.trim(),
    vendida: false
  });

  salvar('estoque.json', estoque);

  aguardandoContaAdmin[chatId] = false;

  bot.sendMessage(chatId, '✅ Conta adicionada ao estoque!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});



