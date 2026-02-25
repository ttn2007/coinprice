export default {
  // ──────────────────────────────────────────────
  // Scheduled Trigger (Cloudflare internal cron)
  // ──────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log("[SCHEDULED] Cron started at:", new Date().toISOString());
    console.log("[SCHEDULED] TG_TOKEN exists?", !!env.TG_TOKEN);
    console.log("[SCHEDULED] PRICE_KV exists?", !!env.PRICE_KV);

    const cfg = {
      pair: "USDTIRT",
      base: "USDT",
      chat: "***********",
      thread: "*****",
      up: 0.1,
      down: -0.1,
      updateCooldown: 300,     // 5 minutes
      alertCooldown: 600       // 10 minutes
    };

    console.log("[SCHEDULED] Starting USDT processing");
    ctx.waitUntil(handlePair(cfg, env));
  },

  // ──────────────────────────────────────────────
  // Telegram Webhook – Inline vote handling
  // ──────────────────────────────────────────────
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response("OK");
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    const token = env.TG_TOKEN;
    if (!token) {
      return new Response("Bot token not configured", { status: 500 });
    }

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

// ──────────────────────────────────────────────
// USDTIRT Price Processing
// ──────────────────────────────────────────────
async function handlePair(cfg, env) {
  console.log("[HANDLE] Starting USDT processing");
  console.log("[HANDLE] TG_TOKEN exists?", !!env.TG_TOKEN);
  console.log("[HANDLE] PRICE_KV exists?", !!env.PRICE_KV);

  const token = env.TG_TOKEN;
  if (!token) {
    console.error("[HANDLE] TG_TOKEN is missing");
    return;
  }

  const API_URL = `https://api.telegram.org/bot${token}`;
  const KV = env.PRICE_KV;
  if (!KV) {
    console.error("[HANDLE] PRICE_KV binding is missing");
    return;
  }

  const PREFIX = `pair:${cfg.base}`;

  let current = 0;

  // Fetch price from Nobitex
  try {
    console.log("[FETCH] Requesting USDTIRT from Nobitex");
    const res = await fetch(`https://apiv2.nobitex.ir/v3/orderbook/${cfg.pair}`);
    const data = await res.json();

    if (data.status !== "ok") {
      console.error("[FETCH] Nobitex status not ok:", data.status);
      return;
    }

    current = Number(data.lastTradePrice) || 0;
    console.log("[FETCH] Current USDT price:", current, "IRR");
  } catch (e) {
    console.error("[FETCH] Nobitex fetch error:", e.message);
    return;
  }

  if (current <= 0) {
    console.error("[PRICE] Invalid price received");
    return;
  }

  // Calculate percentage change
  const prevStr = await KV.get(`${PREFIX}:last`);
  const previous = prevStr !== null ? Number(prevStr) : null;

  let percentChange = "N/A";
  let alertMsg = null;

  if (previous !== null && previous > 0) {
    const percent = ((current - previous) / previous) * 100;
    percentChange = percent.toFixed(2) + "%";

    const nowTs = Date.now();
    const lastUpAlert = await KV.get(`${PREFIX}:lastUpAlert`);
    const lastDownAlert = await KV.get(`${PREFIX}:lastDownAlert`);

    if (percent >= cfg.up && (!lastUpAlert || nowTs - Number(lastUpAlert) > cfg.alertCooldown * 1000)) {
      alertMsg = `🚀 *USDT Pumping!* (+${percent.toFixed(2)}%)`;
      await KV.put(`${PREFIX}:lastUpAlert`, String(nowTs));
      console.log("[ALERT] Pump alert registered");
    } else if (percent <= cfg.down && (!lastDownAlert || nowTs - Number(lastDownAlert) > cfg.alertCooldown * 1000)) {
      alertMsg = `⚠️ *USDT Dumping!* (${percent.toFixed(2)}%)`;
      await KV.put(`${PREFIX}:lastDownAlert`, String(nowTs));
      console.log("[ALERT] Dump alert registered");
    }
  }

  await KV.put(`${PREFIX}:last`, String(current));

  // ────────────────────── Daily Report (20:30 UTC) ──────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const firstKey = `${PREFIX}:first:${today}`;
  const lastKey = `${PREFIX}:last:${today}`;
  const highKey = `${PREFIX}:high:${today}`;
  const lowKey = `${PREFIX}:low:${today}`;
  const reportKey = `${PREFIX}:reported:${today}`;

  if (!(await KV.get(firstKey))) {
    await KV.put(firstKey, String(current));
    await KV.put(highKey, String(current));
    await KV.put(lowKey, String(current));
    console.log("[DAILY] First price of the day recorded");
  }

  await KV.put(lastKey, String(current));

  let high = Number(await KV.get(highKey)) || current;
  let low = Number(await KV.get(lowKey)) || current;

  if (current > high) {
    await KV.put(highKey, String(current));
    console.log("[DAILY] New high recorded");
  }
  if (current < low) {
    await KV.put(lowKey, String(current));
    console.log("[DAILY] New low recorded");
  }

  const now = new Date();
  if (now.getUTCHours() === 20 && now.getUTCMinutes() === 30 && !(await KV.get(reportKey))) {
    const firstVal = Number(await KV.get(firstKey)) || current;
    const lastVal = Number(await KV.get(lastKey)) || current;
    const highVal = Number(await KV.get(highKey)) || current;
    const lowVal = Number(await KV.get(lowKey)) || current;
    const percent = ((lastVal - firstVal) / firstVal) * 100;

    console.log("[DAILY] Daily report time reached - sending");

    await send(API_URL, cfg.chat, cfg.thread,
      `📊 *USDT Daily Report*\n\n` +
      `🗓 Date: ${today}\n` +
      `💵 Open: ${firstVal.toLocaleString('en-US')} IRR\n` +
      `💵 Close: ${lastVal.toLocaleString('en-US')} IRR\n` +
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

    console.log("[DAILY] Daily report sent and keys cleaned");
  }

  // ────────────────────── Regular Update ──────────────────────
  const lastUpdate = await KV.get(`${PREFIX}:lastUpdate`);
  const nowTs = Date.now();

  if (!lastUpdate || nowTs - Number(lastUpdate) > cfg.updateCooldown * 1000) {
    console.log("[REGULAR] Regular update time reached");

    await send(API_URL, cfg.chat, cfg.thread,
      `📊 *USDT*\n\n` +
      `💰 Current Price: *${current.toLocaleString('en-US')} IRR*\n` +
      `↩️ Previous: ${previous ? previous.toLocaleString('en-US') : "N/A"}\n` +
      `📈 Change: *${percentChange}*`
    );

    await KV.put(`${PREFIX}:lastUpdate`, String(nowTs));
    console.log("[REGULAR] Regular update sent");
  }

  // ────────────────────── Pump/Dump Alert ──────────────────────
  if (alertMsg) {
    console.log("[ALERT] Sending alert");
    await send(API_URL, cfg.chat, cfg.thread, alertMsg);
  }

  console.log("[HANDLE] USDT processing finished");
}

// ──────────────────────────────────────────────
// Telegram Helper Functions
// ──────────────────────────────────────────────

async function send(API_URL, chat, thread, text) {
  const body = {
    chat_id: chat,
    text,
    parse_mode: "Markdown"
  };
  if (thread) body.message_thread_id = Number(thread);

  try {
    console.log("[SEND] Attempting to send message to chat", chat, "thread", thread || "main");
    const res = await fetch(`${API_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const json = await res.json();
      console.log("[SEND] Message sent successfully - ID:", json.result?.message_id);
    } else {
      const err = await res.json();
      console.error("[SEND] Telegram error:", res.status, err.description || err);
    }
  } catch (e) {
    console.error("[SEND] Network error sending message:", e.message);
  }
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

  try {
    console.log("[VOTE] Sending new vote message for", pair);
    const res = await fetch(`${API_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      console.log("[VOTE] Vote message sent");
    } else {
      const err = await res.json();
      console.error("[VOTE] Vote message send error:", err);
    }
  } catch (e) {
    console.error("[VOTE] Network error in vote message:", e.message);
  }
}

async function editVoteMessage(API_URL, chat, msgId, pair, up, down) {
  const body = {
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
  };

  try {
    console.log("[EDIT] Editing vote message ID", msgId);
    const res = await fetch(`${API_URL}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      console.log("[EDIT] Vote message edited successfully");
    } else {
      const err = await res.json();
      console.error("[EDIT] Edit error:", err);
    }
  } catch (e) {
    console.error("[EDIT] Network error editing message:", e.message);
  }
}

async function answerCallback(API_URL, id, text) {
  try {
    await fetch(`${API_URL}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text })
    });
    console.log("[CALLBACK] Callback answered");
  } catch (e) {
    console.error("[CALLBACK] Error answering callback:", e.message);
  }
}
