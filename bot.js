
require('dotenv').config();

const mineflayer = require('mineflayer');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Vec3 = require('vec3').Vec3;
const { RaycastIterator } = require('prismarine-world').iterators;

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

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let currentBot = null;
let botReady = false;
let manualMode = false;
let currentCameraMode = 'first';
let reconnectTimer = null;
let stopping = false;
let lastHeartbeatAt = 0;

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


function stopControls(bot = currentBot) {
    if (!bot) return;

    for (const control of [
        'forward',
        'back',
        'left',
        'right',
        'jump',
        'sneak',
        'sprint'
    ]) {
        try {
            bot.setControlState(control, false);
        } catch {}
    }

    activeControls.clear();
}


function stopBreaking(bot = currentBot) {
    if (!bot) return;

    // Hủy hiệu lực của mọi lần phá khối đã bắt đầu trước đó.
    bot._webBreakGeneration = (bot._webBreakGeneration || 0) + 1;
    bot._webBreaking = false;

    if (bot._webBreakTimer) {
        clearInterval(bot._webBreakTimer);
        clearTimeout(bot._webBreakTimer);
        bot._webBreakTimer = null;
    }

    // Yêu cầu Mineflayer dừng đào ngay.
    try {
        bot.stopDigging();
    } catch {}

    bot._webDigBusy = false;
}

function resumeAutomaticMode() {
    if (!isConnected()) {
        manualMode = false;
        stopControls(currentBot);
        stopBreaking(currentBot);
        log('Đã chuyển sang chế độ tự động; đang chờ bot kết nối.');
        return;
    }

    manualMode = false;
    stopControls(currentBot);
    stopBreaking(currentBot);

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
            `Camera chạy tại cổng ${CAMERA_PORT}; ` +
            `góc nhìn: ${currentCameraMode}.`
        );
    } catch (err) {
        bot._webViewerStarted = false;
        log(`Không khởi động được camera: ${err.message}`);
    }
}

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
        const delay = Math.max(250, Number(antiAfk.hit.delay) || 1000);
        const attackMobs = Boolean(antiAfk.hit['attack-mobs']);

        const timer = setInterval(() => {
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

        bot._webAntiAfkTimers.push(timer);
    }

    if (antiAfk.rotate) {
        const timer = setInterval(() => {
            if (bot !== currentBot || !isConnected() || manualMode) return;

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

function inventoryData(bot) {
    if (!bot || !bot.inventory) {
        return { items: [], selectedSlot: 0 };
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

    const generation = bot._webBreakGeneration || 0;
    const block = bot.blockAtCursor(5);

    if (!block || block.name === 'air' || block.boundingBox === 'empty') {
        return;
    }

    bot._webDigBusy = true;

    try {
        // Kiểm tra lại trước khi gửi lệnh đào.
        if (
            bot !== currentBot ||
            !isConnected() ||
            !manualMode ||
            !bot._webBreaking ||
            generation !== (bot._webBreakGeneration || 0)
        ) {
            return;
        }

        await bot.dig(block, 'ignore');
    } catch (err) {
        if (
            bot === currentBot &&
            manualMode &&
            bot._webBreaking &&
            generation === (bot._webBreakGeneration || 0)
        ) {
            log(`Không phá được khối: ${err.message}`);
        }
    } finally {
        bot._webDigBusy = false;
    }
}

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
    bot._webViewerStarted = false;
    bot._webBreaking = false;
    bot._webDigBusy = false;
    bot._webBreakGeneration = 0;
    bot._webBreakTimer = null;

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
        if (bot !== currentBot) return;

        botReady = true;
        console.log('Minecraft server version:', bot.version);
        log('Bot đã vào server Minecraft.');

        try {
            const mcData = require('minecraft-data')(bot.version);
            bot.pathfinder.setMovements(new Movements(bot, mcData));
        } catch (err) {
            log(`Pathfinder: ${err.message}`);
        }

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

        const chatMessages = config.utils && config.utils['chat-messages'];

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
                    try { bot.chat(message); } catch {}
                }
            }
        }

        if (config.position && config.position.enabled) {
            const pos = config.position;

            try {
                bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
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
        if (config.position && config.position.enabled && bot.entity) {
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

        clearBotTimers(bot);
        stopControls(bot);

        try {
            if (bot.viewer && bot.viewer.close) bot.viewer.close();
        } catch {}

        log('Bot đã ngắt kết nối.');

        if (config.utils && config.utils['auto-reconnect'] && !stopping) {
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

// Trang web chính.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Trạng thái bot.
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

// Website gửi heartbeat định kỳ.
// Nếu đóng trang/mất heartbeat khi đang thủ công, bot tự trở về tự động.
app.post('/api/session/heartbeat', authenticate, (req, res) => {
    lastHeartbeatAt = Date.now();
    res.json({ ok: true });
});

setInterval(() => {
    if (
        manualMode &&
        lastHeartbeatAt > 0 &&
        Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT
    ) {
        log('Mất kết nối website điều khiển; tự chuyển về chế độ tự động.');
        lastHeartbeatAt = 0;
        resumeAutomaticMode();
    }
}, 1000);

// Công tắc góc nhìn camera.
app.post('/api/camera/mode', authenticate, (req, res) => {
    try {
        setCameraMode(req.body.mode);
        res.json({ ok: true, mode: currentCameraMode });
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

// Xoay camera bằng chuột.
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
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Di chuyển, chat, chuyển chế độ.
app.post('/api/control', authenticate, (req, res) => {
    const { action, value, state } = req.body;

    try {
        if (action === 'mode') {
            if (value === 'auto') {
                resumeAutomaticMode();
                return res.json({ ok: true, mode: 'auto' });
            }

            if (value === 'manual') {
                setManualMode(true);
                return res.json({ ok: true, mode: 'manual' });
            }

            return res.status(400).json({
                ok: false,
                error: 'Chế độ không hợp lệ.'
            });
        }

        if (action === 'auto') {
            resumeAutomaticMode();
            return res.json({ ok: true, mode: 'auto' });
        }

        if (!isConnected()) {
            return res.status(503).json({
                ok: false,
                error: 'Bot chưa kết nối vào Minecraft.'
            });
        }

        if (action === 'stop') {
            if (!requireManual(req, res)) return;

            stopControls(currentBot);
            stopBreaking(currentBot);

            try { currentBot.pathfinder.setGoal(null); } catch {}

            return res.json({ ok: true });
        }

        
        if (action === 'move') {
            if (!requireManual(req, res)) return;

            const allowed = [
                'forward', 'back', 'left', 'right',
                'jump', 'sneak', 'sprint'
            ];

            if (
                typeof value !== 'string' ||
                !allowed.includes(value) ||
                typeof state !== 'boolean'
            ) {
                return res.status(400).json({
                    ok: false,
                    error: 'Lệnh di chuyển không hợp lệ.'
                });
            }

            const bot = currentBot;

            // Chỉ thay đổi đúng điều khiển được gửi đến.
            // Nhảy không tự bật tiến; chạy nhanh không tự bật tiến.
            try {
                bot.setControlState(value, state);

                if (state) {
                    activeControls.add(value);
                } else {
                    activeControls.delete(value);
                }

                return res.json({
                    ok: true,
                    mode: 'manual',
                    control: value,
                    state
                });
            } catch (err) {
                return res.status(500).json({
                    ok: false,
                    error: err.message
                });
            }
            console.log(
    `[CONTROL] ${value} = ${state}`,
    '| forward =', bot.getControlState('forward'),
    '| jump =', bot.getControlState('jump'),
    '| sprint =', bot.getControlState('sprint')
);
        }


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
                Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
                true
            );

            return res.json({ ok: true });
        }

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

// Túi đồ.
app.get('/api/inventory', authenticate, (req, res) => {
    if (!isConnected()) {
        return res.status(503).json({
            ok: false,
            error: 'Bot chưa kết nối.'
        });
    }

    res.json({ ok: true, ...inventoryData(currentBot) });
});

// Chọn ô đồ nhanh từ 1 đến 9.
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
        res.json({ ok: true, ...inventoryData(currentBot) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Phá khối: bắt đầu khi giữ chuột trái, dừng khi nhả.
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
        if (bot !== currentBot || !manualMode || !bot._webBreaking) {
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

        if (!block || block.name === 'air' || block.boundingBox === 'empty') {
            return res.status(400).json({
                ok: false,
                error: 'Không thấy khối để phá trong tầm ngắm.'
            });
        }

        const generation = bot._webBreakGeneration || 0;

if (!manualMode || bot !== currentBot) {
    throw new Error('Bot đã chuyển khỏi chế độ thủ công.');
}

await bot.dig(block, 'ignore');

if (
    bot !== currentBot ||
    !manualMode ||
    generation !== (bot._webBreakGeneration || 0)
) {
    return res.status(409).json({
        ok: false,
        error: 'Đã hủy thao tác phá khối vì chế độ điều khiển thay đổi.'
    });
}

        res.json({ ok: true, block: block.name });
    } catch (err) {
        log(`Lỗi phá khối: ${err.message}`);
        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

// Đặt khối bằng chuột phải.

app.post('/api/game/place', authenticate, async (req, res) => {
    if (!requireManual(req, res)) return;

    try {
        const result = await placeTargetBlock(currentBot);
        res.json({ ok: true, ...result });
    } catch (err) {
        log(`Lỗi đặt khối: ${err.message}`);
        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});


// Đánh/sử dụng vật phẩm bằng nút tương tác.
app.post('/api/game/use', authenticate, async (req, res) => {
    if (!requireManual(req, res)) return;

    try {
        await currentBot.activateItem();
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
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

    if (currentBot) {
        clearBotTimers(currentBot);
        stopControls(currentBot);

        try {
            if (currentBot.viewer && currentBot.viewer.close) {
                currentBot.viewer.close();
            }
        } catch {}

        try { currentBot.quit('Server shutting down'); } catch {}
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
    log(`Promise bị lỗi: ${err && err.stack ? err.stack : err}`);
});


const dns = require('node:dns');
const net = require('node:net');

async function testAternosNetwork() {
    const host = 'the_gioi_moi.aternos.me';
    const port = 19013;

    try {
        const addresses = await dns.promises.lookup(host, {
            all: true
        });

        log(`[NET TEST] DNS: ${JSON.stringify(addresses)}`);

        const socket = net.createConnection({ host, port });

        socket.setTimeout(10000);

        socket.once('connect', () => {
            log(`[NET TEST] TCP OK: ${host}:${port}`);
            socket.destroy();
        });

        socket.once('timeout', () => {
            log(`[NET TEST] TCP TIMEOUT: ${host}:${port}`);
            socket.destroy();
        });

        socket.once('error', err => {
            log(`[NET TEST] TCP ERROR: ${err.code} - ${err.message}`);
        });
    } catch (err) {
        log(`[NET TEST] DNS ERROR: ${err.message}`);
    }
}

testAternosNetwork();


createBot();
