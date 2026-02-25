export default {
  async scheduled(event, env, ctx) {
    const PAIRS = [
      {
        pairIRR: "BTCIRT",
        pairUSDT: "BTCUSDT",
        base: "Bitcoin",
        chat: "***************",
        thread: "*****",
        up: 0.1,
        down: -0.1,
        updateCooldown: 300,
        alertCooldown: 600
      },
      {
        pairIRR: "ETHIRT",
        pairUSDT: "ETHUSDT",
        base: "Ethereum",
        chat: "*************",
        thread: "*****",
        up: 0.1,
        down: -0.1,
        updateCooldown: 300,
        alertCooldown: 600
      },
      {
        pairIRR: "XRPIRT",
        pairUSDT: "XRPUSDT",
        base: "Ripple",
        chat: "*************",
        thread: "*****",
        up: 0.1,
        down: -0.1,
        updateCooldown: 300,
        alertCooldown: 600
      },
      {
        pairIRR: "SOLIRT",
        pairUSDT: "SOLUSDT",
        base: "Solana",
        chat: "************",
        thread: "*****",
        up: 0.1,
        down: -0.1,
        updateCooldown: 300,
        alertCooldown: 600
      },
      {
        pairIRR: "TONIRT",
        pairUSDT: "TONUSDT",
        base: "Toncoin",
        chat: "************",
        thread: "*****",
        up: 0.1,
        down: -0.1,
        updateCooldown: 300,
        alertCooldown: 600
      },
      {
        pairIRR: "XMRIRT",
        pairUSDT: "XMRUSDT",
        base: "Monero",
        chat: "************",
        thread: "*****",
        up: 0.1,
        down: -0.1,
        updateCooldown: 300,
        alertCooldown: 600
      }
    ];
    for (const cfg of PAIRS) {
      ctx.waitUntil(handlePair(cfg, env));
    }
  },
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return new Response("OK");
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }
    const token = env.TG_TOKEN;
    if (!token) return new Response("Bot token not configured", { status: 500 });
    const API_URL = `https://api.telegram.org/bot${token}`;
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data;
      const userId = cq.from.id;
      const msg = cq.message;
      const chatId = msg.chat.id;
      const messageId = msg.message_id;
      const callbackQueryId = cq.id;
      if (data.startsWith("vote_")) {
        const [, type, pair] = data.split("_");
        const userKey = `votes:user:${pair}:${userId}`;
        if (await env.PRICE_KV.get(userKey)) {
          await answerCallback(API_URL, callbackQueryId, "You have already voted today!");
          return new Response("OK");
        }
        await env.PRICE_KV.put(userKey, "1", { expirationTtl: 86400 });
        const voteKey = `votes:${type}:${pair}`;
        const count = (Number(await env.PRICE_KV.get(voteKey) || "0")) + 1;
        await env.PRICE_KV.put(voteKey, String(count));
        const up = Number(await env.PRICE_KV.get(`votes:up:${pair}`) || "0");
        const down = Number(await env.PRICE_KV.get(`votes:down:${pair}`) || "0");
        await editVoteMessage(API_URL, chatId, messageId, pair, up, down);
        await answerCallback(API_URL, callbackQueryId, "Vote recorded ✅");
      }
    }
    return new Response("OK");
  }
};
async function handlePair(cfg, env) {
  const token = env.TG_TOKEN;
  if (!token) return;
  const API_URL = `https://api.telegram.org/bot${token}`;
  const KV = env.PRICE_KV;
  const PREFIX = `pair:${cfg.base}`;
  let currentIRR = 0;
  let currentUSDT = 0;
  try {
    const [resIRR, resUSDT] = await Promise.all([
      fetch(`https://apiv2.nobitex.ir/v3/orderbook/${cfg.pairIRR}`),
      fetch(`https://apiv2.nobitex.ir/v3/orderbook/${cfg.pairUSDT}`)
    ]);
    const dataIRR = await resIRR.json();
    const dataUSDT = await resUSDT.json();
    if (dataIRR.status !== "ok" || dataUSDT.status !== "ok") return;
    currentIRR = Number(dataIRR.lastTradePrice);
    currentUSDT = Number(dataUSDT.lastTradePrice);
  } catch {
    return;
  }
  const prevStr = await KV.get(`${PREFIX}:last`);
  const previous = prevStr !== null ? Number(prevStr) : null;
  let percentChange = "N/A";
  let alertMsg = null;
  if (previous !== null && previous > 0) {
    const percent = ((currentIRR - previous) / previous) * 100;
    percentChange = percent.toFixed(2) + "%";
    const nowTs = Date.now();
    const lastUpAlert = await KV.get(`${PREFIX}:lastUpAlert`);
    const lastDownAlert = await KV.get(`${PREFIX}:lastDownAlert`);
    if (percent >= cfg.up && (!lastUpAlert || nowTs - Number(lastUpAlert) > cfg.alertCooldown * 1000)) {
      alertMsg = `🚀 *${cfg.base} Pumping!* (+${percent.toFixed(2)}%)`;
      await KV.put(`${PREFIX}:lastUpAlert`, String(nowTs));
    } else if (percent <= cfg.down && (!lastDownAlert || nowTs - Number(lastDownAlert) > cfg.alertCooldown * 1000)) {
      alertMsg = `⚠️ *${cfg.base} Dumping!* (${percent.toFixed(2)}%)`;
      await KV.put(`${PREFIX}:lastDownAlert`, String(nowTs));
    }
  }
  await KV.put(`${PREFIX}:last`, String(currentIRR));
  // ---------------- Daily Report ----------------
  const today = new Date().toISOString().slice(0, 10);
  const firstKey = `${PREFIX}:first:${today}`;
  const lastKey = `${PREFIX}:last:${today}`;
  const highKey = `${PREFIX}:high:${today}`;
  const lowKey = `${PREFIX}:low:${today}`;
  const reportKey = `${PREFIX}:reported:${today}`;
  if (!(await KV.get(firstKey))) {
    await KV.put(firstKey, String(currentIRR));
    await KV.put(highKey, String(currentIRR));
    await KV.put(lowKey, String(currentIRR));
  }
  await KV.put(lastKey, String(currentIRR));
  let high = Number(await KV.get(highKey)) || currentIRR;
  let low = Number(await KV.get(lowKey)) || currentIRR;
  if (currentIRR > high) await KV.put(highKey, String(currentIRR));
  if (currentIRR < low) await KV.put(lowKey, String(currentIRR));
  const now = new Date();
  if (now.getUTCHours() === 20 && now.getUTCMinutes() === 30 && !(await KV.get(reportKey))) {
    const firstVal = Number(await KV.get(firstKey)) || currentIRR;
    const lastVal = Number(await KV.get(lastKey)) || currentIRR;
    const highVal = Number(await KV.get(highKey)) || currentIRR;
    const lowVal = Number(await KV.get(lowKey)) || currentIRR;
    const percent = ((lastVal - firstVal) / firstVal) * 100;
    await send(API_URL, cfg.chat, cfg.thread,
      `📊 *${cfg.base} Daily Report*\n\n` +
      `🗓 Date: ${today}\n` +
      `💰 Close IRR: ${lastVal.toLocaleString('en-US')} IRR\n` +
      `💲 Current USDT: ${currentUSDT.toLocaleString('en-US')} USDT\n` +
      `📈 High: ${highVal.toLocaleString('en-US')} IRR\n` +
      `📉 Low: ${lowVal.toLocaleString('en-US')} IRR\n` +
      `🔄 Change: *${percent.toFixed(2)}%*`
    );
    await KV.delete(`votes:up:${cfg.base}`);
    await KV.delete(`votes:down:${cfg.base}`);
    await sendVoteMessage(API_URL, cfg.chat, cfg.thread, cfg.base, 0, 0);
    await KV.put(reportKey, "1", { expirationTtl: 86400 });
    await KV.delete(firstKey);
    await KV.delete(lastKey);
    await KV.delete(highKey);
    await KV.delete(lowKey);
  }
  // ---------------- Regular Update ----------------
  const lastUpdate = await KV.get(`${PREFIX}:lastUpdate`);
  const nowTs = Date.now();
  if (!lastUpdate || nowTs - Number(lastUpdate) > cfg.updateCooldown * 1000) {
    await send(API_URL, cfg.chat, cfg.thread,
      `📊 *${cfg.base}*\n\n` +
      `💰 IRR Price: *${currentIRR.toLocaleString('en-US')} IRR*\n` +
      `💲 USDT Price: *${currentUSDT.toLocaleString('en-US')} USDT*\n\n` +
      `↩️ Previous IRR: ${previous ? previous.toLocaleString('en-US') : "N/A"}\n` +
      `📈 Change: *${percentChange}*`
    );
    await KV.put(`${PREFIX}:lastUpdate`, String(nowTs));
  }
  if (alertMsg) {
    await send(API_URL, cfg.chat, cfg.thread, alertMsg);
  }
}
// ---------------- Telegram Helpers ----------------
async function send(API_URL, chat, thread, text) {
  const body = {
    chat_id: chat,
    text,
    parse_mode: "Markdown"
  };
  if (thread) body.message_thread_id = Number(thread);
  await fetch(`${API_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
async function sendVoteMessage(API_URL, chat, thread, pair, up, down) {
  const body = {
    chat_id: chat,
    text: `What is your prediction for *${pair}* tomorrow?`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: `📈 Bullish (${up})`, callback_data: `vote_up_${pair}` },
        { text: `📉 Bearish (${down})`, callback_data: `vote_down_${pair}` }
      ]]
    }
  };
  if (thread) body.message_thread_id = Number(thread);
  await fetch(`${API_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
async function editVoteMessage(API_URL, chat, msgId, pair, up, down) {
  await fetch(`${API_URL}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      message_id: msgId,
      text: `What is your prediction for *${pair}* tomorrow?`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: `📈 Bullish (${up})`, callback_data: `vote_up_${pair}` },
          { text: `📉 Bearish (${down})`, callback_data: `vote_down_${pair}` }
        ]]
      }
    })
  });
}
async function answerCallback(API_URL, id, text) {
  await fetch(`${API_URL}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text })
  });
}
