const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const SUPORTE_WHATSAPP = "https://wa.me/67996931430?text=" +
  encodeURIComponent("Opa, vim pela Kizzy Store, preciso de suporte!");


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



const bot = new TelegramBot(TOKEN, { webhook: true });

// ================= UTIL =================
function registrarUsuario(chatId) {
  let usuarios = ler('usuarios.json', {});
  if (!usuarios[chatId]) {
    usuarios[chatId] = { saldo: 0, carrinho: 1 };
    salvar('usuarios.json', usuarios);
  }
}


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
    console.error('RENDER_EXTERNAL_URL não definido');
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

function getPreco() {
const config = ler('config.json', { preco: 0.70});
  return Number(config.preco) || 0.70;
}

function setPreco(valor) {
  salvar('config.json', { preco: valor });
}

function broadcastEstoque() {
  const usuarios = ler('usuarios.json', {});
  const estoque = estoqueDisponivel();

  Object.keys(usuarios).forEach(chatId => {
    bot.sendMessage(
      chatId,
      `📢 *Estoque Abastecido!*

📦 Contas disponíveis no bot
📊 Estoque: ${estoque}

👉 Use /start`,
      { parse_mode: 'Markdown' }
    ).catch(err => {
      console.log(`falha ao enviar broadcast para ${chatId}`);
  });
  });
}

function limparVendidas() {
  let estoque = ler('estoque.json', { contas: [] });

  const antes = estoque.contas.length;
  estoque.contas = estoque.contas.filter(c => !c.vendida);
  const depois = estoque.contas.length;

  salvar('estoque.json', estoque);

  console.log(`🧹 Limpeza estoque: ${antes - depois} contas removidas`);
}



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
let aguardandoContaAdmin = {};
let aguardandoRemocao = {};
let PRECO_ATUAL = getPreco();

// ================= START =================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  getUsuario(chatId);

  bot.sendMessage(
    chatId,
    '🛒 *Kizzy Store*\n\n💰 Use seu saldo para comprar contas.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['💰 Meu saldo'],
          ['🛒 Comprar contas'],
          ['➕ Recarregar saldo'],
          ['🆘 Suporte']
        ],
        resize_keyboard: true
      }
    }
  );
});




// ================= MENSAGENS =================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  registrarUsuario(chatId);
  const user = getUsuario(chatId);
  if (msg.text === '🆘 Suporte') {
  bot.sendMessage(
    chatId,
    '🆘 *Suporte Kizzy Store*\n\nClique no botão abaixo:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Falar no WhatsApp', url: SUPORTE_WHATSAPP }]
        ]
      }
    }
  );
  return;
}

  //ADMIN - ADICIONAR CONTA
  if (aguardandoRemocao[chatId] && chatId === ADMIN_ID) {
  const indices = msg.text
    .split(',')
    .map(n => parseInt(n.trim()) - 1)
    .filter(n => !isNaN(n));

  let estoque = ler('estoque.json', { contas: [] });

  indices.sort((a, b) => b - a).forEach(i => {
    if (estoque.contas[i]) estoque.contas.splice(i, 1);
  });

  salvar('estoque.json', estoque);
  aguardandoRemocao[chatId] = false;

  bot.sendMessage(chatId, '✅ Contas removidas com sucesso.');
  return;
}
  if (aguardandoContaAdmin[chatId] && chatId === ADMIN_ID){
    if (!msg.text.includes(':')) {
      bot.sendMessage(chatId, '❌ Formato inválido. Use login:senha');
      return;
    }



    const linhas = msg.text.split('\n');

const estoque = ler('estoque.json', { contas: [] });
let adicionadas = 0;

linhas.forEach(linha => {
  if (linha.includes(':')) {
    const [login, senha] = linha.split(':');
    estoque.contas.push({
      login: login.trim(),
      senha: senha.trim(),
      vendida: false
    });
    adicionadas++;
  }
});

salvar('estoque.json', estoque);
aguardandoContaAdmin[chatId] = false;

bot.sendMessage(chatId,
  `✅ ${adicionadas} contas adicionadas ao estoque.`
);

broadcastEstoque();
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
    if (estoque === 0) {
  bot.sendMessage(chatId, '⚠️ Estoque esgotado no momento.');
  return;
}

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

    if (user.carrinho > estoqueDisponivel()) {
  bot.answerCallbackQuery(query.id, {
    text: 'Estoque insuficiente no momento',
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
    '➕ /addconta → Adicionar conta' +
    '🗑 /Remover contas',
    { parse_mode: 'Markdown' }
  );
});

//LIMPAR VENDIDAS
bot.onText(/\/limparvendidas/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;

  limparVendidas();
  bot.sendMessage(msg.chat.id, '🧹 Contas vendidas removidas do estoque.');
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
  setPreco(novoPreco);

  bot.sendMessage(msg.chat.id,
    `✅ Preço atualizado com sucesso!\n\n💵 Novo valor: R$${PRECO_ATUAL.toFixed(2)}`
  );
});

// REMOVER MULTIPLAS CONTAS

bot.onText(/\/removercontas/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;

  const estoque = ler('estoque.json', { contas: [] });
  if (estoque.contas.length === 0) {
    bot.sendMessage(msg.chat.id, '⚠️ Estoque vazio.');
    return;
  }

  let texto = '*📦 Contas no estoque:*\n\n';
  estoque.contas.forEach((c, i) => {
    if (!c.vendida) {
      texto += `${i + 1} = ${c.login}:${c.senha}\n`;
    }
  });

  texto += '\n✍️ Envie os números separados por vírgula.\nEx: 1,2,3';

  aguardandoRemocao[msg.chat.id] = true;

  bot.sendMessage(msg.chat.id, texto, { parse_mode: 'Markdown' });
});





const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});



