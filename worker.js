export default {
  async scheduled(event, env, ctx) {
    const TELEGRAM_TOKEN = "8019475390:AAFLKfmlQ3goP-V96T6Cu3ywuFDzq2c4Al4";
    const CHAT_ID = "-1003116535375";
    const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

    const COINS = [
      "BTCIRT","DOGEIRT","ETHIRT","SOLIRT",
      "TRXIRT","USDTIRT","XRPIRT"
    ];

    let currentMessage = "📊 *Nobitex Prices:*\n\n";
    const messages = [];

    for (const [i, pair] of COINS.entries()) {
      try {
        const res = await fetch(`https://apiv2.nobitex.ir/v3/orderbook/${pair}`);
        const data = await res.json();

        if (data.status === "ok" && data.lastTradePrice) {
          const price = Number(data.lastTradePrice).toLocaleString("en-US");
          currentMessage += `${pair}: ${price}\n`;
        } else {
          currentMessage += `${pair}: ❌ Error\n`;
        }
      } catch {
        currentMessage += `${pair}: ⚠️ Fetch error\n`;
      }

      // اگر پیام خیلی بزرگ شد، یه پیام جدید بساز
      if (currentMessage.length > 3500 || i === COINS.length - 1) {
        messages.push(currentMessage.trim());
        currentMessage = "";
      }
    }

    // ارسال پیام‌ها با بررسی نتیجه
    for (const msg of messages) {
      const res = await fetch(`${API_URL}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: msg,
          parse_mode: "Markdown",
        }),
      });

      const data = await res.json();
      console.log("Telegram response:", data);
    }
  },

  async fetch() {
    return new Response("✅ Nobitex multi-coin bot is running", { status: 200 });
  },
};
