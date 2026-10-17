require('dotenv').config();

const mineflayer = require('mineflayer');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const Vec3 = require('vec3').Vec3;

const { Movements, pathfinder } = require('mineflayer-pathfinder');
const { GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

const config = require('./settings.json');
const logger = require('./logging.js').logger;

const app = express();

const PORT = Number(process.env.PORT || 3000);
const CAMERA_PORT = Number(process.env.CAMERA_PORT || 3007);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN;
const HEARTBEAT_TIMEOUT = 7000;

let currentBot = null;
let botReady = false;
let manualMode = false;
let currentCameraMode = 'first';
let reconnectTimer = null;
let stopping = false;
let lastHeartbeatAt = 0;

const activeControls = new Set();

app.use(express.json({ limit: '32kb' }));

function log(message) {
    console.log(`[BOT] ${message}`);

    if (logger && logger.info) {
        logger.info(message);
    }
}

function isConnected() {
    return Boolean(
        currentBot &&
        botReady &&
        currentBot.entity &&
        currentBot.player
    );
}

// ========================================
// CAMERA PROXY
// ========================================

const cameraProxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${CAMERA_PORT}`,
    changeOrigin: true,
    ws: true
});

cameraProxy.on('error', (err, req, res) => {
    log(`[CAMERA PROXY] ${err.message}`);

    if (res && typeof res.writeHead === 'function' && !res.headersSent) {
        res.writeHead(502, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store'
        });

        res.end(
            'Camera chưa sẵn sàng. Hãy chờ bot vào server rồi tải lại trang.'
        );
    }
});

// Giữ nguyên đường dẫn /camera khi chuyển tiếp đến Viewer.
app.use((req, res, next) => {
    if (req.url === '/camera' || req.url.startsWith('/camera/')) {
        return cameraProxy.web(req, res);
    }

    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ========================================
// XÁC THỰC WEBSITE
// ========================================

function authenticate(req, res, next) {
    if (!CONTROL_TOKEN) {
        return res.status(503).json({
            ok: false,
            error: 'Chưa cấu hình CONTROL_TOKEN trong file .env.'
        });
    }

    const supplied = Buffer.from(req.get('x-control-token') || '');
    const expected = Buffer.from(CONTROL_TOKEN);

    if (
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
    ) {
        return res.status(401).json({
            ok: false,
            error: 'CONTROL_TOKEN không đúng.'
        });
    }

    next();
}

// ========================================
// ĐIỀU KHIỂN
// ========================================

function stopControls(bot = currentBot) {
    if (!bot) return;

    const controls = [
        'forward',
        'back',
        'left',
        'right',
        'jump',
        'sneak',
        'sprint'
    ];

    for (const control of controls) {
        try {
            bot.setControlState(control, false);
        } catch {}
    }

    activeControls.clear();
}

function stopBreaking(bot = currentBot) {
    if (!bot) return;

    if (bot._webBreakTimer) {
        clearInterval(bot._webBreakTimer);
        bot._webBreakTimer = null;
    }

    bot._webBreaking = false;

    try {
        if (bot.targetDigBlock) {
            bot.stopDigging();
        }
    } catch {}
}

function requireManual(req, res) {
    if (!isConnected()) {
        res.status(503).json({
            ok: false,
            error: 'Bot chưa kết nối vào Minecraft.'
        });

        return false;
    }

    if (!manualMode) {
        res.status(409).json({
            ok: false,
            error: 'Hãy bật chế độ Thủ công trước.'
        });

        return false;
    }

    return true;
}

function resumeAutomaticMode() {
    manualMode = false;

    stopControls(currentBot);
    stopBreaking(currentBot);

    if (!isConnected()) {
        log('Đã chuyển sang chế độ tự động; đang chờ bot kết nối.');
        return;
    }

    try {
        currentBot.pathfinder.setGoal(null);
    } catch {}

    const pos = config.position;

    if (pos && pos.enabled) {
        try {
            currentBot.pathfinder.setGoal(
                new GoalBlock(pos.x, pos.y, pos.z)
            );
        } catch (err) {
            log(`Không đặt lại được mục tiêu: ${err.message}`);
        }
    }

    log('Đã chuyển về chế độ tự động.');
}

function setManualMode(enabled) {
    if (!enabled) {
        resumeAutomaticMode();
        return;
    }

    if (!isConnected()) {
        throw new Error('Bot chưa vào thế giới Minecraft.');
    }

    manualMode = true;

    try {
        currentBot.pathfinder.setGoal(null);
    } catch {}

    log('Đã chuyển sang chế độ thủ công.');
}

// ========================================
// CAMERA
// ========================================

function startCamera(bot) {
    if (!bot || bot !== currentBot || bot._webViewerStarted) {
        return;
    }

    try {
        mineflayerViewer(bot, {
            port: CAMERA_PORT,
            prefix: '/camera',
            firstPerson: currentCameraMode === 'first',
            viewDistance: 4
        });

        bot._webViewerStarted = true;

        log(
            `Camera chạy tại cổng ${CAMERA_PORT}; ` +
            `góc nhìn: ${currentCameraMode}.`
        );
    } catch (err) {
        bot._webViewerStarted = false;
        log(`Không khởi động được camera: ${err.message}`);
    }
}

function setCameraMode(mode) {
    if (!isConnected()) {
        throw new Error('Bot chưa vào thế giới Minecraft.');
    }

    if (mode !== 'first' && mode !== 'overview') {
        throw new Error('Góc nhìn không hợp lệ.');
    }

    if (
        mode === currentCameraMode &&
        currentBot._webViewerStarted
    ) {
        return;
    }

    currentCameraMode = mode;

    const bot = currentBot;

    try {
        if (bot.viewer && typeof bot.viewer.close === 'function') {
            bot.viewer.close();
        }
    } catch (err) {
        log(`Đóng camera cũ: ${err.message}`);
    }

    bot._webViewerStarted = false;

    setTimeout(() => {
        if (bot !== currentBot || !isConnected()) return;

        startCamera(bot);
    }, 1000);
}

// ========================================
// CHỐNG AFK
// ========================================

function startAntiAfk(bot) {
    const antiAfk = config.utils && config.utils['anti-afk'];

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

        const timer = setInterval(() => {
            if (
                bot !== currentBot ||
                !isConnected() ||
                manualMode
            ) {
                return;
            }

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

        bot._webAntiAfkTimers.push(timer);
    }

    if (antiAfk.rotate) {
        const timer = setInterval(() => {
            if (
                bot !== currentBot ||
                !isConnected() ||
                manualMode
            ) {
                return;
            }

            try {
                bot.look(
                    bot.entity.yaw + 0.05,
                    bot.entity.pitch,
                    true
                );
            } catch {}
        }, 100);

        bot._webAntiAfkTimers.push(timer);
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

        const timer = setInterval(() => {
            if (
                bot !== currentBot ||
                !isConnected() ||
                manualMode ||
                !bot.entity
            ) {
                return;
            }

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

        bot._webAntiAfkTimers.push(timer);
    }
}

function clearBotTimers(bot) {
    if (!bot) return;

    for (const timer of bot._webAntiAfkTimers || []) {
        clearInterval(timer);
        clearTimeout(timer);
    }

    bot._webAntiAfkTimers = [];

    stopBreaking(bot);
}

// ========================================
// TÚI ĐỒ
// ========================================

function inventoryData(bot) {
    if (!bot || !bot.inventory) {
        return {
            items: [],
            selectedSlot: 0
        };
    }

    const items = [];

    for (let slot = 0; slot < bot.inventory.slots.length; slot++) {
        const item = bot.inventory.slots[slot];

        if (!item) continue;

        items.push({
            slot,
            name: item.name,
            displayName: item.displayName || item.name,
            count: item.count,
            type: item.type
        });
    }

    return {
        items,
        selectedSlot: Number(bot.quickBarSlot) || 0
    };
}

// ========================================
// PHÁ KHỐI
// ========================================

async function breakTargetBlock(bot) {
    if (
        bot !== currentBot ||
        !isConnected() ||
        !manualMode ||
        !bot._webBreaking ||
        bot._webDigBusy
    ) {
        return;
    }

    const block = bot.blockAtCursor(5);

    if (
        !block ||
        block.name === 'air' ||
        block.boundingBox === 'empty'
    ) {
        return;
    }

    bot._webDigBusy = true;

    try {
        await bot.dig(block, true);
    } catch (err) {
        if (bot._webBreaking && manualMode) {
            log(`Không phá được khối: ${err.message}`);
        }
    } finally {
        bot._webDigBusy = false;
    }
}

// ========================================
// ĐẶT KHỐI
// ========================================

async function placeTargetBlock(bot) {
    if (!isConnected() || bot !== currentBot || !manualMode) {
        throw new Error('Bot chưa ở chế độ thủ công.');
    }

    const item = bot.heldItem;
    if (!item) {
        throw new Error('Tay bot đang trống. Hãy chọn một khối trong túi đồ.');
    }

    const yaw = bot.entity.yaw;
    const pitch = bot.entity.pitch;
    const eyeHeight = bot.entity.eyeHeight ?? 1.62;
    const eye = bot.entity.position.offset(0, eyeHeight, 0);

    const direction = new Vec3(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
    );

    const hit = bot.world.raycast(eye, direction, 5);

    if (!hit || !hit.position || hit.face == null) {
        throw new Error('Không tìm thấy mặt khối đang ngắm. Hãy ngắm vào một khối đặc trong phạm vi 5 block.');
    }

    const block = bot.blockAt(hit.position);

    if (!block || block.name === 'air' || block.boundingBox === 'empty') {
        throw new Error('Khối đang ngắm không hợp lệ.');
    }

    let face;

    if (typeof hit.face === 'number') {
        const faces = [
            new Vec3(0, -1, 0),
            new Vec3(0, 1, 0),
            new Vec3(0, 0, -1),
            new Vec3(0, 0, 1),
            new Vec3(-1, 0, 0),
            new Vec3(1, 0, 0)
        ];

        if (hit.face < 0 || hit.face >= faces.length) {
            throw new Error('Raycast trả về mặt khối không hợp lệ.');
        }

        face = faces[hit.face];
    } else if (
        typeof hit.face === 'object' &&
        typeof hit.face.x === 'number' &&
        typeof hit.face.y === 'number' &&
        typeof hit.face.z === 'number'
    ) {
        face = new Vec3(hit.face.x, hit.face.y, hit.face.z);
    } else {
        throw new Error('Không đọc được mặt khối.');
    }

    const targetPos = block.position.plus(face);
    const targetBlock = bot.blockAt(targetPos);

    if (!targetBlock) {
        throw new Error('Không đọc được vị trí dự định đặt khối.');
    }

    if (
        targetBlock.name !== 'air' &&
        targetBlock.boundingBox !== 'empty'
    ) {
        throw new Error(
            `Vị trí (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) đã bị chiếm.`
        );
    }

    try {
        await bot.placeBlock(block, face);

        return {
            placed: true,
            item: item.name,
            position: {
                x: targetPos.x,
                y: targetPos.y,
                z: targetPos.z
            }
        };
    } catch (err) {
        throw new Error(`Đặt khối thất bại: ${err.message}`);
    }
}

// ========================================
// TẠO BOT MINECRAFT
// ========================================

function createBot() {
    const account = config['bot-account'];

    const bot = mineflayer.createBot({
        username: account.username,
        password: account.password,
        auth: account.type,
        host: config.server.ip,
        port: config.server.port,
        version: config.server.version
    });

    currentBot = bot;
    botReady = false;
    manualMode = false;

    bot._webAntiAfkTimers = [];
    bot._webViewerStarted = false;
    bot._webBreaking = false;
    bot._webDigBusy = false;
    bot._webBreakTimer = null;

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
        if (bot !== currentBot) return;

        botReady = true;

        console.log('Minecraft server version:', bot.version);
        log('Bot đã vào server Minecraft.');

        try {
            const mcData = require('minecraft-data')(bot.version);

            bot.pathfinder.setMovements(
                new Movements(bot, mcData)
            );
        } catch (err) {
            log(`Pathfinder: ${err.message}`);
        }

        // Đăng nhập tự động nếu settings.json đã bật.
        const autoAuth = config.utils && config.utils['auto-auth'];

        if (autoAuth && autoAuth.enabled) {
            setTimeout(() => {
                if (!isConnected()) return;

                try {
                    const password = autoAuth.password;

                    bot.chat(`/register ${password} ${password}`);
                    bot.chat(`/login ${password}`);
                } catch (err) {
                    log(`Lỗi đăng nhập tự động: ${err.message}`);
                }
            }, 500);
        }

        // Tin nhắn tự động.
        const chatMessages =
            config.utils && config.utils['chat-messages'];

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

                const timer = setInterval(() => {
                    if (!isConnected() || manualMode) return;

                    try {
                        bot.chat(chatMessages.messages[i]);

                        i = (i + 1) % chatMessages.messages.length;
                    } catch {}
                }, delay * 1000);

                bot._webAntiAfkTimers.push(timer);
            } else {
                for (const message of chatMessages.messages) {
                    try {
                        bot.chat(message);
                    } catch {}
                }
            }
        }

        // Mục tiêu tự động đã được cấu hình.
        if (config.position && config.position.enabled) {
            const pos = config.position;

            try {
                bot.pathfinder.setGoal(
                    new GoalBlock(pos.x, pos.y, pos.z)
                );
            } catch (err) {
                log(`Không đặt được vị trí tự động: ${err.message}`);
            }
        }

        startCamera(bot);
        startAntiAfk(bot);
    });

    bot.on('chat', (username, message) => {
        if (config.utils && config.utils['chat-log']) {
            log(`<${username}> ${message}`);
        }
    });

    bot.on('goal_reached', () => {
        if (
            config.position &&
            config.position.enabled &&
            bot.entity
        ) {
            log(`Bot đã tới mục tiêu: ${bot.entity.position}`);
        }
    });

    bot.on('death', () => {
        log('Bot đã chết.');
    });

    bot.on('kicked', reason => {
        log(`Bot bị kick: ${String(reason)}`);
    });

    bot.on('error', err => {
        log(`Minecraft error: ${err.message}`);
    });

    bot.on('end', () => {
        if (bot !== currentBot) return;

        botReady = false;
        manualMode = false;

        clearBotTimers(bot);
        stopControls(bot);

        try {
            if (bot.viewer && bot.viewer.close) {
                bot.viewer.close();
            }
        } catch {}

        log('Bot đã ngắt kết nối.');

        if (
            config.utils &&
            config.utils['auto-reconnect'] &&
            !stopping
        ) {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }

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

// ========================================
// TRANG WEB
// ========================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========================================
// API TRẠNG THÁI
// ========================================

app.get('/api/status', authenticate, (req, res) => {
    const connected = isConnected();

    res.json({
        ok: true,
        connected,
        username: connected ? currentBot.username : '',
        mode: manualMode ? 'manual' : 'auto',
        cameraMode: currentCameraMode,

        position: connected
            ? {
                x: Number(currentBot.entity.position.x.toFixed(2)),
                y: Number(currentBot.entity.position.y.toFixed(2)),
                z: Number(currentBot.entity.position.z.toFixed(2))
            }
            : null,

        health: connected ? currentBot.health : null,
        food: connected ? currentBot.food : null,
        cameraPort: CAMERA_PORT
    });
});

// ========================================
// HEARTBEAT
// ========================================

app.post('/api/session/heartbeat', authenticate, (req, res) => {
    lastHeartbeatAt = Date.now();

    res.json({ ok: true });
});

// Nếu website mất heartbeat quá 7 giây,
// chuyển bot về chế độ tự động, không tạo bot mới.
setInterval(() => {
    if (
        manualMode &&
        lastHeartbeatAt > 0 &&
        Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT
    ) {
        log(
            'Mất kết nối website điều khiển; ' +
            'tự chuyển về chế độ tự động.'
        );

        lastHeartbeatAt = 0;
        resumeAutomaticMode();
    }
}, 1000);

// ========================================
// API CAMERA
// ========================================

app.post('/api/camera/mode', authenticate, (req, res) => {
    try {
        setCameraMode(req.body.mode);

        res.json({
            ok: true,
            mode: currentCameraMode
        });
    } catch (err) {
        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

app.post('/api/camera/rotate', authenticate, (req, res) => {
    if (!requireManual(req, res)) return;

    if (currentCameraMode !== 'first') {
        return res.status(409).json({
            ok: false,
            error: 'Hãy chọn góc nhìn thứ nhất để điều khiển chuột.'
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

    const mouseX = Math.max(-500, Math.min(500, dx));
    const mouseY = Math.max(-500, Math.min(500, dy));
    const sensitivity = 0.0025;

    try {
        currentBot.look(
            currentBot.entity.yaw - mouseX * sensitivity,

            Math.max(
                -Math.PI / 2,
                Math.min(
                    Math.PI / 2,
                    currentBot.entity.pitch - mouseY * sensitivity
                )
            ),

            true
        );

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ========================================
// API ĐIỀU KHIỂN
// ========================================

app.post('/api/control', authenticate, (req, res) => {
    const { action, value, state } = req.body;

    try {
        // Chuyển chế độ.
        if (action === 'mode') {
            if (value === 'auto') {
                resumeAutomaticMode();

                return res.json({
                    ok: true,
                    mode: 'auto'
                });
            }

            if (value === 'manual') {
                setManualMode(true);

                return res.json({
                    ok: true,
                    mode: 'manual'
                });
            }

            return res.status(400).json({
                ok: false,
                error: 'Chế độ không hợp lệ.'
            });
        }

        if (action === 'auto') {
            resumeAutomaticMode();

            return res.json({
                ok: true,
                mode: 'auto'
            });
        }

        if (!isConnected()) {
            return res.status(503).json({
                ok: false,
                error: 'Bot chưa kết nối vào Minecraft.'
            });
        }

        // Dừng toàn bộ chuyển động.
        if (action === 'stop') {
            if (!requireManual(req, res)) return;

            stopControls(currentBot);
            stopBreaking(currentBot);

            try {
                currentBot.pathfinder.setGoal(null);
            } catch {}

            return res.json({ ok: true });
        }

        // Điều khiển di chuyển.
        if (action === 'move') {
            if (!requireManual(req, res)) return;

            const allowed = [
                'forward',
                'back',
                'left',
                'right',
                'jump',
                'sneak',
                'sprint'
            ];

            if (!allowed.includes(value)) {
                return res.status(400).json({
                    ok: false,
                    error: 'Lệnh di chuyển không hợp lệ.'
                });
            }

            const enabled = Boolean(state);

            currentBot.setControlState(value, enabled);

            if (enabled) {
                activeControls.add(value);
            } else {
                activeControls.delete(value);
            }

            return res.json({
                ok: true,
                mode: 'manual'
            });
        }

        // Đặt góc nhìn trực tiếp.
        if (action === 'look') {
            if (!requireManual(req, res)) return;

            const yaw = Number(req.body.yaw);
            const pitch = Number(req.body.pitch);

            if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
                return res.status(400).json({
                    ok: false,
                    error: 'Góc nhìn không hợp lệ.'
                });
            }

            currentBot.look(
                yaw,
                Math.max(
                    -Math.PI / 2,
                    Math.min(Math.PI / 2, pitch)
                ),
                true
            );

            return res.json({ ok: true });
        }

        // Chat trong Minecraft.
        if (action === 'chat') {
            if (!requireManual(req, res)) return;

            const message = String(value || '').trim();

            if (!message || message.length > 256) {
                return res.status(400).json({
                    ok: false,
                    error: 'Tin nhắn trống hoặc quá dài.'
                });
            }

            currentBot.chat(message);

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

// ========================================
// API TÚI ĐỒ
// ========================================

app.get('/api/inventory', authenticate, (req, res) => {
    if (!isConnected()) {
        return res.status(503).json({
            ok: false,
            error: 'Bot chưa kết nối.'
        });
    }

    res.json({
        ok: true,
        ...inventoryData(currentBot)
    });
});

app.post('/api/inventory/select', authenticate, (req, res) => {
    if (!requireManual(req, res)) return;

    const slot = Number(req.body.slot);

    if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
        return res.status(400).json({
            ok: false,
            error: 'Ô đồ phải từ 1 đến 9.'
        });
    }

    try {
        currentBot.setQuickBarSlot(slot);

        res.json({
            ok: true,
            ...inventoryData(currentBot)
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ========================================
// API PHÁ KHỐI
// ========================================

app.post('/api/game/break', authenticate, (req, res) => {
    if (!requireManual(req, res)) return;

    const bot = currentBot;
    const pressed = Boolean(req.body.state);

    if (!pressed) {
        stopBreaking(bot);

        return res.json({ ok: true });
    }

    if (bot._webBreaking) {
        return res.json({ ok: true });
    }

    bot._webBreaking = true;

    breakTargetBlock(bot);

    bot._webBreakTimer = setInterval(() => {
        if (
            bot !== currentBot ||
            !manualMode ||
            !bot._webBreaking
        ) {
            stopBreaking(bot);
            return;
        }

        breakTargetBlock(bot);
    }, 350);

    res.json({ ok: true });
});

app.post('/api/game/break-once', authenticate, async (req, res) => {
    if (!requireManual(req, res)) return;

    const bot = currentBot;

    try {
        const block = bot.blockAtCursor(5);

        if (
            !block ||
            block.name === 'air' ||
            block.boundingBox === 'empty'
        ) {
            return res.status(400).json({
                ok: false,
                error: 'Không thấy khối để phá trong tầm ngắm.'
            });
        }

        await bot.dig(block, true);

        res.json({
            ok: true,
            block: block.name
        });
    } catch (err) {
        log(`Lỗi phá khối: ${err.message}`);

        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

// ========================================
// API ĐẶT KHỐI
// ========================================

app.post('/api/game/place', authenticate, async (req, res) => {
    if (!requireManual(req, res)) return;

    try {
        const result = await placeTargetBlock(currentBot);

        res.json({
            ok: true,
            ...result
        });
    } catch (err) {
        log(`Lỗi đặt khối: ${err.message}`);

        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

// ========================================
// API SỬ DỤNG VẬT PHẨM
// ========================================

app.post('/api/game/use', authenticate, async (req, res) => {
    if (!requireManual(req, res)) return;

    try {
        await currentBot.activateItem();

        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

// ========================================
// KHỞI ĐỘNG WEBSITE
// ========================================

const server = app.listen(PORT, () => {
    log(`Website đang chạy tại cổng ${PORT}`);

    if (!CONTROL_TOKEN) {
        log('CẢNH BÁO: Chưa cấu hình CONTROL_TOKEN trong .env');
    }
});

// Chuyển tiếp WebSocket của camera.
server.on('upgrade', (req, socket, head) => {
    if (
        req.url === '/camera/socket.io' ||
        req.url.startsWith('/camera/socket.io/')
    ) {
        cameraProxy.ws(req, socket, head);
    }
});

// ========================================
// TẮT BOT AN TOÀN
// ========================================

function shutdown() {
    stopping = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (currentBot) {
        clearBotTimers(currentBot);
        stopControls(currentBot);

        try {
            if (
                currentBot.viewer &&
                currentBot.viewer.close
            ) {
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

process.on('uncaughtException', err => {
    log(`Lỗi không xử lý: ${err.stack || err.message}`);
});

process.on('unhandledRejection', err => {
    log(
        `Promise bị lỗi: ${
            err && err.stack ? err.stack : err
        }`
    );
});

// Chỉ tạo một bot ban đầu.
// Khi mất kết nối, logic tự kết nối lại sẽ tạo bot thay thế.
createBot();
