export default {
  async scheduled(event, env, ctx) {
    const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;
    const CHAT_ID = env.CHAT_ID;
    const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

    const PAIR = "USDTIRT";
    const KV_KEY = "last_price";

    // Alert thresholds (%)
    const UP_ALERT = 0.1;
    const DOWN_ALERT = -0.1;

    try {
      // Fetch current price
      const res = await fetch(`https://apiv2.nobitex.ir/v3/orderbook/${PAIR}`);
      const data = await res.json();

      if (data.status !== "ok" || !data.lastTradePrice) {
        await send(API_URL, CHAT_ID, "❌ Error fetching price");
        return;
      }

      const current = Number(data.lastTradePrice);

      // Read previous price
      const previousStr = await env.PRICE_KV.get(KV_KEY);
      const previous = previousStr ? Number(previousStr) : null;

      let percentChange = null;
      let alertMsg = null;

      if (previous) {
        const diff = current - previous;
        const percent = (diff / previous) * 100;
        percentChange = percent.toFixed(2) + "%";

        if (percent >= UP_ALERT) {
          alertMsg = `🚀 *ALERT: USDT is pumping!* (+${percent.toFixed(2)}%)`;
        } else if (percent <= DOWN_ALERT) {
          alertMsg = `⚠️ *ALERT: USDT is dumping!* (${percent.toFixed(2)}%)`;
        }
      }

      // Save new price
      await env.PRICE_KV.put(KV_KEY, String(current));

      // Save daily prices safely
      const today = new Date().toISOString().slice(0, 10);
      const dailyKey = `daily_prices:${today}`;

      let prices = [];
      try {
        const raw = await env.PRICE_KV.get(dailyKey);
        prices = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(prices)) prices = [];
      } catch {
        prices = [];
      }

      prices.push(current);
      await env.PRICE_KV.put(dailyKey, JSON.stringify(prices));

      // Daily report at 00:00 Iran (20:30 UTC)
      const now = new Date();
      if (now.getUTCHours() === 20 && now.getUTCMinutes() === 30) {
        if (prices.length > 1) {
          const first = prices[0];
          const last = prices[prices.length - 1];
          const high = Math.max(...prices);
          const low = Math.min(...prices);
          const percent = ((last - first) / first) * 100;

          const report =
            `📊 *USDT/IRT Daily Report*\n\n` +
            `🗓 Date: ${today}\n` +
            `💵 Start: ${first.toLocaleString("en-US")} IRR\n` +
            `💵 End: ${last.toLocaleString("en-US")} IRR\n` +
            `📈 High: ${high.toLocaleString("en-US")} IRR\n` +
            `📉 Low: ${low.toLocaleString("en-US")} IRR\n` +
            `🔄 Change: *${percent.toFixed(2)}%*`;

          await send(API_URL, CHAT_ID, report);

          // Cleanup
          await env.PRICE_KV.delete(dailyKey);
        }
      }

      // Normal update message
      const updateMsg =
        `📊 *USDT*\n\n` +
        `Price: *${current.toLocaleString("en-US")} IRR*\n` +
        `Prev: ${previous ? previous.toLocaleString("en-US") : "N/A"}\n` +
        `Change: *${percentChange || "N/A"}*`;

      await send(API_URL, CHAT_ID, updateMsg);

      if (alertMsg) {
        await send(API_URL, CHAT_ID, alertMsg);
      }

    } catch (err) {
      await send(API_URL, CHAT_ID, "❌ Worker crashed but recovered");
    }
  },

  async fetch() {
    return new Response("USDT Telegram tracker with daily reports", {
      status: 200,
    });
  },
};

// Telegram sender
async function send(API_URL, CHAT_ID, text) {
  try {
    await fetch(`${API_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err);
  }
}
