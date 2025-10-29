require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Please set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

// USDC mint on Solana mainnet
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------- helper functions ----------
function looksLikeMint(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  return t.length >= 32 && t.length <= 44;
}

async function getMintInfo(mint) {
  try {
    const pub = new PublicKey(mint);
    const parsed = await connection.getParsedAccountInfo(pub);
    const decimals = parsed?.value?.data?.parsed?.info?.decimals ?? null;
    const supplyRaw = parsed?.value?.data?.parsed?.info?.supply ?? null;
    const supply =
      decimals !== null && supplyRaw !== null
        ? Number(supplyRaw) / 10 ** decimals
        : null;
    return { decimals, supply };
  } catch {
    return null;
  }
}

async function getPriceFromJupiter(mint, decimals) {
  try {
    const amount = BigInt(10) ** BigInt(decimals ?? 0);
    const params = {
      inputMint: mint,
      outputMint: SOL_USDC_MINT,
      amount: amount.toString(),
      slippageBps: 50,
      restrictIntermediateTokens: true,
    };
    const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params,
      timeout: 10000,
    });
    const route = res.data?.routePlan?.[0];
    const outAmount = route?.outAmount || res.data?.outAmount;
    if (!outAmount) return null;
    const price = Number(outAmount) / 10 ** 6; // USDC has 6 decimals
    return price;
  } catch {
    return null;
  }
}

async function getDexscreenerData(mint) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/solana/${mint}`,
      { timeout: 8000 }
    );
    const pair = res.data?.pairs?.[0];
    if (!pair) return null;
    return {
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      price: Number(pair.priceUsd),
      liquidity: pair.liquidity?.usd,
      volume24h: pair.volume?.h24,
      url: pair.url,
    };
  } catch {
    return null;
  }
}

function formatNumber(n) {
  if (n === null || n === undefined) return 'N/A';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toPrecision(6);
}

// ---------- bot logic ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!text) return;

  if (text === '/start' || text === '/help') {
    return bot.sendMessage(
      chatId,
      '👋 Send a Solana *token mint address*, and I’ll show:\n- Price (via Jupiter)\n- Liquidity & Volume (via Dexscreener)\n- Supply & Decimals (on-chain)\n\n💡 Example:\n`So11111111111111111111111111111111111111112`',
      { parse_mode: 'Markdown' }
    );
  }

  if (!looksLikeMint(text)) {
    return bot.sendMessage(chatId, '⚠️ Please send a valid Solana mint address.');
  }

  const mint = text;
  const loading = await bot.sendMessage(chatId, `🔍 Fetching token info for \`${mint}\`...`, {
    parse_mode: 'Markdown',
  });

  const mintInfo = await getMintInfo(mint);
  const decimals = mintInfo?.decimals ?? null;
  const supply = mintInfo?.supply ?? null;

  const priceUsd = decimals !== null ? await getPriceFromJupiter(mint, decimals) : null;
  const dexData = await getDexscreenerData(mint);

  // build message
  let reply = `💎 *Token Info*\n\n`;
  reply += `🔹 *Mint:* \`${mint}\`\n`;
  reply += `🔢 *Decimals:* \`${decimals ?? 'Unknown'}\`\n`;
  reply += `📦 *Supply:* \`${supply ? formatNumber(supply) : 'Unknown'}\`\n\n`;
  reply += `💰 *Price:* ${priceUsd ? `$${formatNumber(priceUsd)}` : dexData?.price ? `$${formatNumber(dexData.price)}` : 'N/A'}\n`;
  reply += `💧 *Liquidity:* ${dexData?.liquidity ? `$${formatNumber(dexData.liquidity)}` : 'N/A'}\n`;
  reply += `📊 *24h Volume:* ${dexData?.volume24h ? `$${formatNumber(dexData.volume24h)}` : 'N/A'}\n\n`;

  reply += `_Sources: Solana RPC + Jupiter + Dexscreener_`;

  // Inline buttons
  const inlineKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 View Chart', url: `https://dexscreener.com/solana/${mint}` },
          { text: '💧 Trade on Jupiter', url: `https://jup.ag/swap/SOL-${mint}` },
        ],
        [{ text: '📋 Copy Contract', callback_data: `copy_${mint}` }],
      ],
    },
    parse_mode: 'Markdown',
  };

  await bot.editMessageText(reply, {
    chat_id: chatId,
    message_id: loading.message_id,
    ...inlineKeyboard,
  });
});

// handle "copy contract" button (optional UX)
bot.on('callback_query', (query) => {
  if (query.data.startsWith('copy_')) {
    const mint = query.data.split('_')[1];
    bot.answerCallbackQuery(query.id, { text: `Copied: ${mint}` });
  }
});
