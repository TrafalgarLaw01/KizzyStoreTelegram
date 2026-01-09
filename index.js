const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const mercadopago = require('mercadopago');
const express = require('express');

const bot = new TelegramBot(process.env.BOT_TOKEN);
mercadopago.configure({ access_token: process.env.MERCADOPAGO_TOKEN });

/* ================= MONGO ================= */

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function startMongo() {
  await client.connect();
  db = client.db();
  console.log('Mongo conectado');
}
startMongo();

const users = () => db.collection('users');
const estoque = () => db.collection('estoque');
const pagamentos = () => db.collection('pagamentos');
const config = () => db.collection('config');

/* ================= CONFIG PADRÃO ================= */

async function getPreco() {
  const cfg = await config().findOne({ key: 'preco' });
  return cfg ? cfg.valor : 0.70;
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
    await setEtapa(chatId, 'menu');
    const menu = menuPrincipal(user);
    return bot.sendMessage(chatId, menu.text, menu.opts);
  }

  /* COMPRAR */
  if (q.data === 'comprar') {
    await setEtapa(chatId, 'comprar');
    await users().updateOne({ chatId }, { $set: { quantidade: 1 } });
    return atualizarTelaCompra(chatId);
  }

  /* QUANTIDADE */
  if (q.data === 'mais' || q.data === 'menos') {
    let qtd = user.quantidade;
    if (q.data === 'mais') qtd++;
    if (q.data === 'menos' && qtd > 1) qtd--;
    await users().updateOne({ chatId }, { $set: { quantidade: qtd } });
    return atualizarTelaCompra(chatId);
  }

  /* CONFIRMAR COMPRA */
  if (q.data === 'confirmar_compra') {
    return confirmarCompra(chatId);
  }
});

/* ================= TELA COMPRA ================= */

async function atualizarTelaCompra(chatId) {
  const user = await getUser(chatId);
  const preco = await getPreco();
  const estoqueQtd = await estoque().countDocuments({ vendida: false });
  const total = user.quantidade * preco;

  bot.sendMessage(
    chatId,
`📦 *Contas Outlook – Alta Qualidade*

• 💵 Preço: R$ ${preco.toFixed(2)}
• 📦 Quantidade: ${user.quantidade}
• 🧮 Total: R$ ${total.toFixed(2)}
• 💰 Seu saldo: R$ ${user.saldo.toFixed(2)}
• 📊 Estoque: ${estoqueQtd}`,
    {
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
    }
  );
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
    { $inc: { saldo: -total }, $set: { etapa: 'menu', quantidade: 1 } }
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
