require('dotenv').config();

const mineflayer = require('mineflayer');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { Movements, pathfinder } = require('mineflayer-pathfinder');
const { GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

const config = require('./settings.json');
const logger = require('./logging.js').logger;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CAMERA_PORT = Number(process.env.CAMERA_PORT || 3007);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let currentBot = null;
let botReady = false;
let manualMode = false;
let manualTimer = null;
let currentCameraMode = 'first';
let reconnectTimer = null;
let stopping = false;

const activeControls = new Set();

function log(message) {
    console.log(`[BOT] ${message}`);
    if (logger && logger.info) logger.info(message);
}

function isConnected() {
    return Boolean(
        currentBot &&
        botReady &&
        currentBot.entity &&
        currentBot.player
    );
}

function authenticate(req, res, next) {
    if (!CONTROL_TOKEN) {
        return res.status(503).json({
            ok: false,
            error: 'Server chưa cấu hình CONTROL_TOKEN trong file .env'
        });
    }

    const suppliedBuffer = Buffer.from(
        req.get('x-control-token') || ''
    );

    const expectedBuffer = Buffer.from(CONTROL_TOKEN);

    if (
        expectedBuffer.length !== suppliedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
        return res.status(401).json({
            ok: false,
            error: 'Token không đúng'
        });
    }

    next();
}

function stopControls(bot) {
    if (!bot) return;

    for (const control of [
        'forward', 'back', 'left', 'right',
        'jump', 'sneak', 'sprint'
    ]) {
        try {
            bot.setControlState(control, false);
        } catch {}
    }

    activeControls.clear();
}

function beginManualControl() {
    if (!isConnected()) return;

    manualMode = true;

    if (manualTimer) clearTimeout(manualTimer);

    try {
        currentBot.pathfinder.setGoal(null);
    } catch {}

    manualTimer = setTimeout(() => {
        manualMode = false;
        manualTimer = null;

        stopControls(currentBot);

        if (!isConnected()) return;

        log('Hết 10 giây không điều khiển: chuyển về chế độ tự động.');
        resumeAutomaticMode();
    }, 10000);
}

function resumeAutomaticMode() {
    if (!isConnected()) return;

    manualMode = false;
    stopControls(currentBot);

    const pos = config.position;

    if (pos && pos.enabled) {
        try {
            currentBot.pathfinder.setGoal(
                new GoalBlock(pos.x, pos.y, pos.z)
            );
        } catch (err) {
            log(`Không khôi phục được mục tiêu: ${err.message}`);
        }
    }

    log('Đã chuyển về chế độ tự động.');
}

function setCameraMode(mode) {
    if (!isConnected()) {
        throw new Error('Bot chưa vào thế giới Minecraft.');
    }

    if (mode !== 'first' && mode !== 'overview') {
        throw new Error('Góc nhìn không hợp lệ.');
    }

    if (mode === currentCameraMode && currentBot._webViewerStarted) {
        return;
    }

    currentCameraMode = mode;

    const bot = currentBot;

    try {
        if (bot.viewer && typeof bot.viewer.close === 'function') {
            bot.viewer.close();
        }
    } catch (err) {
        log(`Đóng viewer cũ: ${err.message}`);
    }

    bot._webViewerStarted = false;

    setTimeout(() => {
        if (bot !== currentBot || !isConnected()) return;
        startCamera(bot);
    }, 1000);
}

function startCamera(bot) {
    if (!bot || bot !== currentBot || bot._webViewerStarted) return;

    try {
        mineflayerViewer(bot, {
            port: CAMERA_PORT,
            firstPerson: currentCameraMode === 'first',
            viewDistance: 4
        });

        bot._webViewerStarted = true;

        log(
            `Camera đang chạy tại cổng ${CAMERA_PORT}; ` +
            `chế độ: ${currentCameraMode}; khoảng nhìn: 4 chunks.`
        );
    } catch (err) {
        bot._webViewerStarted = false;
        log(`Không khởi động được camera: ${err.message}`);
    }
}

function startAntiAfk(bot) {
    const antiAfk = config.utils['anti-afk'];

    if (!antiAfk || !antiAfk.enabled) return;

    if (antiAfk.sneak) {
        bot.setControlState('sneak', true);
    }

    if (antiAfk.jump) {
        bot.setControlState('jump', true);
    }

    if (antiAfk.hit && antiAfk.hit.enabled) {
        const delay = Math.max(
            250,
            Number(antiAfk.hit.delay) || 1000
        );

        const attackMobs = Boolean(antiAfk.hit['attack-mobs']);

        const hitTimer = setInterval(() => {
            if (bot !== currentBot || !isConnected() || manualMode) return;

            try {
                if (attackMobs) {
                    const entity = bot.nearestEntity(e =>
                        e.type !== 'object' &&
                        e.type !== 'player' &&
                        e.type !== 'global' &&
                        e.type !== 'orb' &&
                        e.type !== 'other'
                    );

                    if (entity) {
                        bot.attack(entity);
                        return;
                    }
                }

                bot.swingArm('right', true);
            } catch {}
        }, delay);

        bot._webAntiAfkTimers.push(hitTimer);
    }

    // Xoay camera chống AFK hiện có.
    // Khi manualMode=true, thao tác xoay tự động tạm dừng.
    if (antiAfk.rotate) {
        const rotateTimer = setInterval(() => {
            if (bot !== currentBot || !isConnected() || manualMode) return;

            try {
                bot.look(
                    bot.entity.yaw + 0.05,
                    bot.entity.pitch,
                    true
                );
            } catch {}
        }, 100);

        bot._webAntiAfkTimers.push(rotateTimer);
    }

    const circle = antiAfk['circle-walk'];

    if (circle && circle.enabled) {
        const radius = Math.max(1, Number(circle.radius) || 4);

        const points = [
            [radius, 0],
            [0, radius],
            [-radius, 0],
            [0, -radius]
        ];

        let index = 0;

        const walkTimer = setInterval(() => {
            if (bot !== currentBot || !isConnected() || manualMode) return;
            if (!bot.entity) return;

            const origin = bot.entity.position;
            const point = points[index];

            try {
                bot.pathfinder.setGoal(
                    new GoalXZ(
                        Math.floor(origin.x + point[0]),
                        Math.floor(origin.z + point[1])
                    )
                );
            } catch {}

            index = (index + 1) % points.length;
        }, 5000);

        bot._webAntiAfkTimers.push(walkTimer);
    }
}

function clearBotTimers(bot) {
    if (!bot || !bot._webAntiAfkTimers) return;

    for (const timer of bot._webAntiAfkTimers) {
        clearInterval(timer);
        clearTimeout(timer);
    }

    bot._webAntiAfkTimers = [];
}

function createBot() {
    const bot = mineflayer.createBot({
        username: config['bot-account'].username,
        password: config['bot-account'].password,
        auth: config['bot-account'].type,
        host: config.server.ip,
        port: config.server.port,
        version: config.server.version
    });

    currentBot = bot;
    botReady = false;
    bot._webAntiAfkTimers = [];

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
        if (bot !== currentBot) return;
        console.log('Minecraft server version:', bot.version);
        botReady = true;
        log('Bot đã vào server Minecraft.');

        try {
            const mcData = require('minecraft-data')(bot.version);
            const movements = new Movements(bot, mcData);
            bot.pathfinder.setMovements(movements);
        } catch (err) {
            log(`Pathfinder: ${err.message}`);
        }

        const autoAuth = config.utils['auto-auth'];

        if (autoAuth && autoAuth.enabled) {
            const password = autoAuth.password;

            setTimeout(() => {
                if (!isConnected()) return;

                bot.chat(`/register ${password} ${password}`);
                bot.chat(`/login ${password}`);
            }, 500);
        }

        const chatMessages = config.utils['chat-messages'];

        if (
            chatMessages &&
            chatMessages.enabled &&
            Array.isArray(chatMessages.messages) &&
            chatMessages.messages.length
        ) {
            if (chatMessages.repeat) {
                let i = 0;

                const delay = Math.max(
                    1,
                    Number(chatMessages['repeat-delay']) || 60
                );

                const chatTimer = setInterval(() => {
                    if (!isConnected() || manualMode) return;

                    bot.chat(chatMessages.messages[i]);
                    i = (i + 1) % chatMessages.messages.length;
                }, delay * 1000);

                bot._webAntiAfkTimers.push(chatTimer);
            } else {
                for (const message of chatMessages.messages) {
                    bot.chat(message);
                }
            }
        }

        if (config.position && config.position.enabled) {
            const pos = config.position;

            bot.pathfinder.setGoal(
                new GoalBlock(pos.x, pos.y, pos.z)
            );
        }

        startCamera(bot);
        startAntiAfk(bot);
    });

    bot.on('chat', (username, message) => {
        if (config.utils['chat-log']) {
            log(`<${username}> ${message}`);
        }
    });

    bot.on('goal_reached', () => {
        if (config.position && config.position.enabled) {
            log(`Bot đã tới mục tiêu: ${bot.entity.position}`);
        }
    });

    bot.on('death', () => log('Bot đã chết.'));
    bot.on('kicked', reason => log(`Bot bị kick: ${String(reason)}`));
    bot.on('error', err => log(`Minecraft error: ${err.message}`));

    bot.on('end', () => {
        if (bot !== currentBot) return;

        botReady = false;
        manualMode = false;

        if (manualTimer) clearTimeout(manualTimer);
        manualTimer = null;

        clearBotTimers(bot);
        stopControls(bot);

        try {
            if (bot.viewer && bot.viewer.close) bot.viewer.close();
        } catch {}

        log('Bot đã ngắt kết nối.');

        if (config.utils['auto-reconnect'] && !stopping) {
            if (reconnectTimer) clearTimeout(reconnectTimer);

            reconnectTimer = setTimeout(() => {
                if (!stopping) {
                    log('Đang kết nối lại...');
                    createBot();
                }
            }, 20000);
        }
    });

    return bot;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', authenticate, (req, res) => {
    const connected = isConnected();

    res.json({
        ok: true,
        connected,
        username: connected ? currentBot.username : '',
        mode: manualMode ? 'manual' : 'auto',
        cameraMode: currentCameraMode,
        position: connected ? {
            x: Number(currentBot.entity.position.x.toFixed(2)),
            y: Number(currentBot.entity.position.y.toFixed(2)),
            z: Number(currentBot.entity.position.z.toFixed(2))
        } : null,
        health: connected ? currentBot.health : null,
        food: connected ? currentBot.food : null,
        cameraPort: CAMERA_PORT
    });
});

app.post('/api/camera/mode', authenticate, (req, res) => {
    try {
        const mode = req.body.mode;
        setCameraMode(mode);
        res.json({ ok: true, mode });
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

// Điều khiển xoay bằng chuột, dùng cùng bot.look() với cơ chế chống AFK.
app.post('/api/camera/rotate', authenticate, (req, res) => {
    if (!isConnected()) {
        return res.status(503).json({
            ok: false,
            error: 'Bot chưa kết nối vào Minecraft.'
        });
    }

    if (currentCameraMode !== 'first') {
        return res.status(409).json({
            ok: false,
            error: 'Hãy chọn Góc nhìn thứ nhất để điều khiển bằng chuột.'
        });
    }

    const dx = Number(req.body.dx);
    const dy = Number(req.body.dy);

    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        return res.status(400).json({
            ok: false,
            error: 'Dữ liệu chuột không hợp lệ.'
        });
    }

    const mouseX = Math.max(-150, Math.min(150, dx));
    const mouseY = Math.max(-150, Math.min(150, dy));
    const sensitivity = 0.004;
    const bot = currentBot;

    beginManualControl();

    const yaw = bot.entity.yaw - mouseX * sensitivity;
    const pitch = Math.max(
        -Math.PI / 2,
        Math.min(
            Math.PI / 2,
            bot.entity.pitch - mouseY * sensitivity
        )
    );

    try {
        bot.look(yaw, pitch, true);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/control', authenticate, (req, res) => {
    if (!isConnected()) {
        return res.status(503).json({
            ok: false,
            error: 'Bot chưa kết nối vào Minecraft.'
        });
    }

    const { action, value, state } = req.body;
    const bot = currentBot;

    try {
        if (action === 'auto') {
            if (manualTimer) clearTimeout(manualTimer);
            manualTimer = null;
            resumeAutomaticMode();
            return res.json({ ok: true, mode: 'auto' });
        }

        if (action === 'stop') {
            beginManualControl();
            stopControls(bot);
            try { bot.pathfinder.setGoal(null); } catch {}
            return res.json({ ok: true });
        }

        if (action === 'move') {
            const allowed = [
                'forward', 'back', 'left', 'right',
                'jump', 'sneak', 'sprint'
            ];

            if (!allowed.includes(value)) {
                return res.status(400).json({
                    ok: false,
                    error: 'Lệnh di chuyển không hợp lệ.'
                });
            }

            beginManualControl();

            const enabled = Boolean(state);
            bot.setControlState(value, enabled);

            if (enabled) activeControls.add(value);
            else activeControls.delete(value);

            return res.json({ ok: true, mode: 'manual' });
        }

        if (action === 'look') {
            const yaw = Number(req.body.yaw);
            const pitch = Number(req.body.pitch);

            if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
                return res.status(400).json({
                    ok: false,
                    error: 'Góc nhìn không hợp lệ.'
                });
            }

            beginManualControl();

            bot.look(
                yaw,
                Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
                true
            );

            return res.json({ ok: true });
        }

        if (action === 'chat') {
            const message = String(value || '').trim();

            if (!message || message.length > 256) {
                return res.status(400).json({
                    ok: false,
                    error: 'Tin nhắn trống hoặc quá dài.'
                });
            }

            beginManualControl();
            bot.chat(message);

            return res.json({ ok: true });
        }

        return res.status(400).json({
            ok: false,
            error: 'Hành động không được hỗ trợ.'
        });
    } catch (err) {
        log(`Lỗi điều khiển: ${err.message}`);

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

const server = app.listen(PORT, () => {
    log(`Website đang chạy tại cổng ${PORT}`);

    if (!CONTROL_TOKEN) {
        log('CẢNH BÁO: Chưa cấu hình CONTROL_TOKEN trong .env');
    }
});

function shutdown() {
    stopping = true;

    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (manualTimer) clearTimeout(manualTimer);

    if (currentBot) {
        clearBotTimers(currentBot);
        stopControls(currentBot);

        try {
            if (currentBot.viewer && currentBot.viewer.close) {
                currentBot.viewer.close();
            }
        } catch {}

        try {
            currentBot.quit('Server shutting down');
        } catch {}
    }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

createBot();
