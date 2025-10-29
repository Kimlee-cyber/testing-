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

// Common constant: USDC mint on Solana mainnet
// (Circle's USDC mainnet mint)
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ----- helper funcs -----
function looksLikeMint(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  return t.length >= 32 && t.length <= 44; // base58 mint length
}

async function getMintInfo(mint) {
  try {
    const pub = new PublicKey(mint);
    const parsed = await connection.getParsedAccountInfo(pub);
    if (!parsed || !parsed.value) return null;

    // Parsed mint account path
    const decimals = parsed?.value?.data?.parsed?.info?.decimals ?? null;
    const supplyRaw = parsed?.value?.data?.parsed?.info?.supply ?? null; // string
    let supply = null;
    if (supplyRaw !== null && decimals !== null) {
      // supply is integer string (base units). convert to human
      const asNum = Number(supplyRaw);
      if (!Number.isNaN(asNum)) {
        supply = asNum / (10 ** decimals);
      } else {
        supply = null;
      }
    }

    return { decimals, supply };
  } catch (err) {
    return null;
  }
}

/**
 * Get price by asking Jupiter for a quote converting 1 * token => USDC.
 * Uses Jupiter lite API quote endpoint. If no route, returns null.
 * Example doc: https://dev.jup.ag/docs/swap/get-quote
 */
async function getPriceFromJupiter(mint, decimals) {
  try {
    // amount = 1 token in base units
    const amount = BigInt(10) ** BigInt(decimals ?? 0);

    // Jupiter lite API/quote endpoint (public)
    const url = 'https://lite-api.jup.ag/swap/v1/quote';
    const params = {
      inputMint: mint,
      outputMint: SOL_USDC_MINT,
      amount: amount.toString(),
      slippageBps: 50,
      restrictIntermediateTokens: true
    };

    const res = await axios.get(url, { params, timeout: 10000 });
    const body = res.data;

    // Quote format: contains outAmount / inAmount (strings) on success
    // Example: { routes: [ { outAmount, inAmount, ... } ], ... }
    const route = (body?.data?.routes && body.data.routes[0]) || (body?.routes && body.routes[0]) || null;
    if (!route) {
      // older/alternate response shape may have 'outAmount' at top level
      const outAmount = body?.outAmount ?? body?.data?.outAmount ?? null;
      if (!outAmount) return null;
      // fallback: assume outAmount is USDC for amount provided
      const out = Number(outAmount);
      const price = out / Number(amount);
      return price;
    }

    // outAmount is USDC in base units (usually 6 decimals)
    const outAmountStr = route.outAmount ?? route?.outAmount;
    if (!outAmountStr) return null;

    // parse to number
    const outAmount = Number(outAmountStr);
    // USDC on Sol has 6 decimals (usually)
    const usdcDecimals = 6;
    const outHuman = outAmount / (10 ** usdcDecimals);

    // price per 1 token = outHuman / 1
    const price = outHuman;
    return price;
  } catch (err) {
    // quiet fail - return null
    return null;
  }
}

/**
 * Try to get liquidity & 24h volume from Dexscreener.
 * Attempt token-specific endpoints (best-effort).
 * Docs: https://docs.dexscreener.com/api/reference
 */
async function getDexscreenerData(mint) {
  try {
    // 1) token-profiles endpoint (general)
    const tryUrls = [
      `https://api.dexscreener.com/token-profiles/latest/v1`, // generic list (not ideal)
      // Common per-token endpoints:
      `https://api.dexscreener.com/latest/dex/pairs/solana/${mint}`, // pair listing
      `https://api.dexscreener.com/latest/dex/tokens/solana/${mint}`, // token => pairs (works in many cases)
      `https://api.dexscreener.com/token-pairs/v1/solana/${mint}` // alternative path some users show
    ];

    for (const url of tryUrls) {
      try {
        const res = await axios.get(url, { timeout: 8000 });
        const body = res.data;
        // Inspect typical fields and try to extract meaningful values.
        // Dexscreener pair responses often include: price, liquidity, volume, priceChange
        if (!body) continue;

        // If body contains array of pairs, pick first
        if (Array.isArray(body) && body.length > 0) {
          const p = body[0];
          return {
            name: p.name ?? p.tokenName ?? null,
            symbol: p.symbol ?? p.tokenSymbol ?? null,
            price: p.price ? Number(String(p.price).replace(/[^0-9.\-]/g,'')) : null,
            liquidity: p.liquidity ? Number(String(p.liquidity).replace(/[^0-9.\-]/g,'')) : null,
            volume24h: p.volume24h ? Number(String(p.volume24h).replace(/[^0-9.\-]/g,'')) : null,
            url: p.dexScreenerUrl ?? p.url ?? null
          };
        }

        // If body has 'pairs' or 'pairsList'
        const maybePairs = body?.pairs || body?.pairsList || body?.data?.pairs || body?.data;
        if (Array.isArray(maybePairs) && maybePairs.length > 0) {
          const p = maybePairs[0];
          return {
            name: p?.name ?? null,
            symbol: p?.symbol ?? null,
            price: p?.price ? Number(String(p.price).replace(/[^0-9.\-]/g,'')) : null,
            liquidity: p?.liquidity ? Number(String(p.liquidity).replace(/[^0-9.\-]/g,'')) : null,
            volume24h: p?.volume24h ? Number(String(p.volume24h).replace(/[^0-9.\-]/g,'')) : null,
            url: p?.dexScreenerUrl ?? p?.url ?? null
          };
        }

        // If body itself includes token info fields
        if (body?.price || body?.liquidity || body?.volume24h) {
          return {
            name: body.name ?? null,
            symbol: body.symbol ?? null,
            price: body.price ? Number(String(body.price).replace(/[^0-9.\-]/g,'')) : null,
            liquidity: body.liquidity ? Number(String(body.liquidity).replace(/[^0-9.\-]/g,'')) : null,
            volume24h: body.volume24h ? Number(String(body.volume24h).replace(/[^0-9.\-]/g,'')) : null,
            url: body.dexScreenerUrl ?? body.url ?? null
          };
        }
      } catch (innerErr) {
        // continue to next URL
        continue;
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

function formatNumber(n) {
  if (n === null || n === undefined) return 'N/A';
  if (typeof n === 'number') {
    if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return n.toPrecision(6);
  }
  return String(n);
}

// ----- bot behaviour -----
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!text) return;

  if (text === '/start' || text === '/help') {
    return bot.sendMessage(chatId,
      'Send a Solana token *mint address* and I will fetch decimals, supply (on-chain), price (via Jupiter → USDC) and liquidity/24h volume (via Dexscreener if available).',
      { parse_mode: 'Markdown' }
    );
  }

  if (!looksLikeMint(text)) {
    return bot.sendMessage(chatId, 'Please send a valid-looking Solana mint address (base58).');
  }

  // Validate PublicKey
  let mintPub;
  try {
    mintPub = new PublicKey(text);
  } catch (err) {
    return bot.sendMessage(chatId, 'Invalid Solana public key format.');
  }
  const mint = mintPub.toBase58();

  const loading = await bot.sendMessage(chatId, `Fetching data for \`${mint}\` …`, { parse_mode: 'Markdown' });

  // fetch on-chain mint info
  const mintInfo = await getMintInfo(mint);
  const decimals = mintInfo?.decimals ?? null;
  const supply = mintInfo?.supply ?? null;

  // get price from Jupiter
  const priceUsd = (decimals !== null) ? await getPriceFromJupiter(mint, decimals) : null;

  // get dexscreener data
  const dexData = await getDexscreenerData(mint);

  // Build reply
  let reply = `💎 *Token info* \n\n`;
  reply += `🔹 *Mint:* \`${mint}\`\n`;
  reply += `🔢 *Decimals:* \`${decimals !== null ? decimals : 'Unknown'}\`\n`;
  reply += `📦 *Supply:* \`${supply !== null ? formatNumber(supply) : 'Unknown'}\`\n\n`;

  reply += `💰 *Price (USD):* ${priceUsd !== null ? `$${formatNumber(priceUsd)}` : (dexData?.price ? `$${formatNumber(dexData.price)}` : 'Not available')}\n`;
  reply += `💧 *Liquidity:* ${dexData?.liquidity ? `$${formatNumber(dexData.liquidity)}` : 'Not available'}\n`;
  reply += `📊 *24h Volume:* ${dexData?.volume24h ? `$${formatNumber(dexData.volume24h)}` : 'Not available'}\n\n`;

  // Dexscreener chart link (works even if not indexed)
  reply += `🔗 *Chart:* https://dexscreener.com/solana/${mint}\n\n`;
  reply += `_Sources: Solana RPC (mint data) + Jupiter quote API (price) + Dexscreener (liquidity/volume)._`;

  await bot.editMessageText(reply, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown' });
});
