const mineflayer = require('mineflayer');
const express = require('express');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalXZ } = goals;

const config = require('./settings.json');
const loggers = require('./logging.js');
const logger = loggers.logger;

const app = express();

app.get('/', (req, res) => {
   const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
   res.send('Bot is running ✔');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   logger.info(`Web server started on ${PORT}`);
});

let reconnecting = false;

function createBot() {
   const bot = mineflayer.createBot({
      username: config['bot-account']['username'],
      password: config['bot-account']['password'],
      auth: config['bot-account']['type'],
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
   });

   bot.loadPlugin(pathfinder);

   // ===== PATHFINDER =====
   bot.once('spawn', () => {
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      bot.pathfinder.setMovements(defaultMove);

      logger.info("Bot joined + Pathfinder ready");

      // ===== AUTO-RECONNECT TIMER RESET =====
      reconnecting = false;

      // ===== ANTI AFK (SAFE VERSION) =====
      if (config.utils['anti-afk']?.enabled) {
         setInterval(() => {
            if (!bot.entity) return;

            bot.look(bot.entity.yaw + 0.3, bot.entity.pitch, true);

            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 500);

         }, 20000);
      }

      // ===== AUTO AUTH =====
      if (config.utils['auto-auth']?.enabled) {
         setTimeout(() => {
            const pass = config.utils['auto-auth'].password;
            bot.chat(`/register ${pass} ${pass}`);
            bot.chat(`/login ${pass}`);
         }, 1000);
      }

      // ===== CHAT =====
      if (config.utils['chat-messages']?.enabled) {
         const messages = config.utils['chat-messages'].messages;
         let i = 0;

         if (config.utils['chat-messages'].repeat) {
            setInterval(() => {
               bot.chat(messages[i]);
               i = (i + 1) % messages.length;
            }, config.utils['chat-messages'].repeat-delay * 1000);
         }
      }

      // ===== MOVE =====
      if (config.position?.enabled) {
         const pos = config.position;
         bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
      }
   });

   // ===== RECONNECT 24/7 =====
   bot.on('end', () => {
      logger.warn("Bot disconnected");

      if (reconnecting) return;
      reconnecting = true;

      setTimeout(() => {
         logger.info("Reconnecting...");
         createBot();
      }, 30000);
   });

   bot.on('kicked', (reason) => {
      logger.warn("Kicked:", reason);
   });

   bot.on('error', (err) => {
      logger.error(err.message);
   });
}

createBot();
