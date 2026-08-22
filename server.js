const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Импорт экземпляра бота из bot.js для избежания конфликта 409 Conflict (двойного polling)
let botModule = null;
try {
    botModule = require('./bot');
} catch (e) {
    console.warn("Модуль bot.js не подключен или загрузился с предупреждением:", e.message);
}
const bot = botModule ? botModule.bot : null;

app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        console.log(`[API REQUEST] ${req.method} ${req.path}`);
    }
    next();
});

process.on('uncaughtException', (err) => {
    console.error('⛔ СИСТЕМНЫЙ ПЕРЕХВАТ ОШИБКИ:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⛔ СИСТЕМНЫЙ ПЕРЕХВАТ НЕОБРАБОТАННОГО ПРОМИСА:', reason);
});

// ПАЛИТРА ЯРКИХ УНИКАЛЬНЫХ ЦВЕТОВ ДЛЯ ИГРОКОВ (НЕ ПОВТОРЯЮТСЯ В РАУНДЕ)
const COLOR_PALETTE = [
    '#ff2d55', '#00e676', '#0088cc', '#ffcc00', '#8d3df5', 
    '#e040fb', '#00e5ff', '#ff9100', '#76ff03', '#d500f9', 
    '#1de9b6', '#ff6d00', '#3d5afe', '#c6ff00', '#ff1744'
];

function assignUniqueColor(currentBets) {
    const usedColors = currentBets.map(b => b.color);
    const available = COLOR_PALETTE.filter(c => !usedColors.includes(c));
    if (available.length > 0) {
        return available[Math.floor(Math.random() * available.length)];
    }
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue}, 85%, 55%)`;
}

const userQueues = {};
function enqueueUserAction(userId, actionFn) {
    const idStr = String(userId);
    if (!userQueues[idStr]) { userQueues[idStr] = Promise.resolve(); }
    const nextPromise = userQueues[idStr].then(async () => { return await actionFn(); });
    userQueues[idStr] = nextPromise.catch((err) => { console.error(`⛔ Ошибка очереди для пользователя ${idStr}:`, err); });
    return nextPromise;
}

const ADMIN_CHAT_ID = String(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_CHAT_ID || '').trim().replace(/^["']|["']$/g, '');
const DEPOSIT_ADDRESS = String(process.env.ADMIN_TON_ADDRESS || 'EQC3481up9_gG98_wK8Jv_Zz1yLp9p0_Y-7Jv7x4b9a9JKe6').trim().replace(/^["']|["']$/g, '');

const ALL_GIFT_ITEMS = {
    1: { name: "Статуя птицы серая", value: 20.0, icon: "/Images/Items/rare_bird.jpg" },
    2: { name: "Тыква", value: 8.0, icon: "/Images/Items/pumpkin.jpg" },
    3: { name: "Шляпа", value: 7.0, icon: "/Images/Items/hat.jpg" },
    4: { name: "Собачка Snoop Dogg", value: 4.0, icon: "/Images/Items/snoopdog.jpg" },
    5: { name: "Рюкзак черный", value: 3.0, icon: "/Images/Items/pack.jpg" },
    6: { name: "Доширак лапша", value: 2.7, icon: "/Images/Items/ramen.jpg" },
    7: { name: "Факел", value: 2.5, icon: "/Images/Items/chill_flame.jpg" },
    8: { name: "Мороженое пломбир", value: 2.5, icon: "/Images/Items/plombir.jpg" },
    9: { name: "Алмазик", value: 0.9, icon: "/Images/Items/almaz.jpg" },
    10: { name: "Роза", value: 0.27, icon: "/Images/Items/roza.jpg" },
    101: { name: "Розовый мишка", value: 29.0, icon: "/Images/Items/bearpink.png" },
    102: { name: "Шлем Неко", value: 26.8, icon: "/Images/Items/Neko_helmet.png" },
    103: { name: "Перстень печатка", value: 25.7, icon: "/Images/Items/signet_ring.png" },
    104: { name: "Папаха", value: 18.5, icon: "/Images/Items/papakha.png" },
    105: { name: "Амулет Купидона", value: 15.0, icon: "/Images/Items/cupid_charm.png" },
    106: { name: "Любовное зелье", value: 10.0, icon: "/Images/Items/love_potion.png" },
    107: { name: "UFC Бокс", value: 9.9, icon: "/Images/Items/UFC_box.png" },
    108: { name: "Всевидящее око", value: 5.0, icon: "/Images/Items/eye.png" },
    109: { name: "Холодный огонь", value: 2.2, icon: "/Images/Items/chill_flame.jpg" },
    110: { name: "Вкусный пломбир", value: 2.2, icon: "/Images/Items/plombir.jpg" },
    111: { name: "Прекрасная роза", value: 0.2, icon: "/Images/Items/roza.jpg" },
    112: { name: "Мишка классический", value: 0.11, icon: "/Images/Items/michka.jpg" }
};

let pgPool = null;
const localUsersFile = path.join(__dirname, 'database_users.json');
const localInvFile = path.join(__dirname, 'database_inventory.json');
const localDepFile = path.join(__dirname, 'database_deposits.json');
const localArenaFile = path.join(__dirname, 'database_arena.json');

if (!fs.existsSync(localUsersFile)) fs.writeFileSync(localUsersFile, JSON.stringify({}));
if (!fs.existsSync(localInvFile)) fs.writeFileSync(localInvFile, JSON.stringify([]));
if (!fs.existsSync(localDepFile)) fs.writeFileSync(localDepFile, JSON.stringify([]));
if (!fs.existsSync(localArenaFile)) fs.writeFileSync(localArenaFile, JSON.stringify({}));

if (process.env.DATABASE_URL) {
    pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
}

async function dbGetUser(id) {
    try {
        if (pgPool) {
            const res = await pgPool.query("SELECT * FROM users WHERE id = $1", [String(id)]);
            return res.rows[0] || null;
        }
    } catch (e) {
        console.error("DB Fallback GetUser:", e.message);
    }
    const data = JSON.parse(fs.readFileSync(localUsersFile, 'utf8') || '{}');
    return data[String(id)] || null;
}

async function dbGetUserByUsername(username) {
    if (!username) return null;
    const cleanUsername = username.replace('@', '').trim().toLowerCase();
    try {
        if (pgPool) {
            const res = await pgPool.query("SELECT * FROM users WHERE LOWER(username) = $1", [cleanUsername]);
            return res.rows[0] || null;
        }
    } catch (e) {
        console.error("DB GetUserByUsername Error:", e.message);
    }
    const data = JSON.parse(fs.readFileSync(localUsersFile, 'utf8') || '{}');
    for (const id in data) {
        const u = data[id];
        if (u.username && u.username.replace('@', '').trim().toLowerCase() === cleanUsername) {
            return u;
        }
    }
    return null;
}

async function dbSaveUser(id, user) {
    const isBannedValue = (user.is_banned === true || user.is_banned === 'true');
    try {
        if (pgPool) {
            await pgPool.query(`
                INSERT INTO users (id, username, first_name, balance, avatar_url, last_daily_case_open, is_banned)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (id) DO UPDATE 
                SET username = $2, first_name = $3, balance = $4, avatar_url = $5, last_daily_case_open = $6, is_banned = $7
            `, [String(id), user.username, user.first_name, user.balance, user.avatar_url, user.last_daily_case_open, isBannedValue]);
            return;
        }
    } catch (e) {
        console.error("DB Fallback SaveUser:", e.message);
    }
    const data = JSON.parse(fs.readFileSync(localUsersFile, 'utf8') || '{}');
    user.is_banned = isBannedValue;
    data[String(id)] = user;
    fs.writeFileSync(localUsersFile, JSON.stringify(data, null, 2));
}

async function dbGetInventory(userId) {
    try {
        if (pgPool) {
            const res = await pgPool.query("SELECT * FROM inventory WHERE user_id = $1", [String(userId)]);
            return res.rows;
        }
    } catch (e) {
        console.error("DB Fallback GetInventory:", e.message);
    }
    const items = JSON.parse(fs.readFileSync(localInvFile, 'utf8') || '[]');
    return items.filter(i => String(i.user_id) === String(userId));
}

async function dbAddInventoryItem(userId, itemId) {
    const gift = ALL_GIFT_ITEMS[itemId];
    if (!gift) return;

    try {
        if (pgPool) {
            await pgPool.query(`
                INSERT INTO inventory (user_id, item_id, name, value, image_url)
                VALUES ($1, $2, $3, $4, $5)
            `, [String(userId), itemId, gift.name, gift.value, gift.icon]);
            return;
        }
    } catch (e) {
        console.error("DB Fallback AddInventory:", e.message);
    }
    const items = JSON.parse(fs.readFileSync(localInvFile, 'utf8') || '[]');
    const newItem = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        user_id: String(userId),
        item_id: parseInt(itemId),
        name: gift.name,
        value: gift.value,
        image_url: gift.icon
    };
    items.push(newItem);
    fs.writeFileSync(localInvFile, JSON.stringify(items, null, 2));
}

async function dbRemoveInventoryItem(userId, itemId) {
    try {
        if (pgPool) {
            await pgPool.query("DELETE FROM inventory WHERE id = (SELECT id FROM inventory WHERE user_id = $1 AND item_id = $2 LIMIT 1)", [String(userId), parseInt(itemId)]);
            return;
        }
    } catch (e) {
        console.error("DB Fallback RemoveInventory:", e.message);
    }
    const items = JSON.parse(fs.readFileSync(localInvFile, 'utf8') || '[]');
    const idx = items.findIndex(i => String(i.user_id) === String(userId) && parseInt(i.item_id) === parseInt(itemId));
    if (idx !== -1) {
        items.splice(idx, 1);
        fs.writeFileSync(localInvFile, JSON.stringify(items, null, 2));
    }
}

// СОСТОЯНИЕ ИГРЫ BEST ARENA
let arenaState = {
    status: "waiting", // "waiting", "countdown", "running"
    roundNumber: 1,
    bets: [],
    timeLeft: 15,
    resolvedAt: 0,
    winnerId: null,
    winnerName: null,
    winnerX: 160,
    winnerY: 160,
    totalPool: 0,
    seed: "seed_1",
    startX: 160,
    startY: 160,
    angle: 0,
    initialSpeed: 28
};

function loadArenaState() {
    try {
        if (fs.existsSync(localArenaFile)) {
            const data = JSON.parse(fs.readFileSync(localArenaFile, 'utf8'));
            if (data && typeof data === 'object') {
                arenaState.roundNumber = data.roundNumber || arenaState.roundNumber;
                arenaState.bets = [];
                arenaState.status = "waiting";
                arenaState.timeLeft = 15;
                arenaState.resolvedAt = 0;
                arenaState.winnerId = null;
                arenaState.winnerName = null;
                arenaState.winnerX = 160;
                arenaState.winnerY = 160;
                arenaState.totalPool = 0;
                console.log("SUCCESS: Arena State restored. Round number: " + arenaState.roundNumber);
            }
        }
    } catch (e) {
        console.error("Error loading Arena State:", e.message);
    }
}

function saveArenaState() {
    try {
        fs.writeFileSync(localArenaFile, JSON.stringify(arenaState, null, 2));
    } catch (e) {
        console.error("Error saving Arena State:", e.message);
    }
}

loadArenaState();

// Главный серверный цикл Арены (каждую 1 секунду)
setInterval(() => {
    try {
        let stateChanged = false;

        if (arenaState.status === "waiting") {
            if (arenaState.bets.length >= 2) {
                arenaState.status = "countdown";
                arenaState.timeLeft = 15;
                stateChanged = true;
                console.log(`[ARENA] 🟢 Начат отсчет раунда №${arenaState.roundNumber}: 15 сек.`);
            }
        } else if (arenaState.status === "countdown") {
            if (arenaState.bets.length < 2) {
                arenaState.status = "waiting";
                arenaState.timeLeft = 15;
                stateChanged = true;
            } else {
                arenaState.timeLeft--;
                stateChanged = true;
                if (arenaState.timeLeft <= 0) {
                    console.log(`[ARENA] ⏳ Время отсчета истекло. Запускаем физику симуляции...`);
                    resolveArenaRound().catch(e => console.error("Error resolving round:", e.message));
                }
            }
        } else if (arenaState.status === "running") {
            const elapsed = Date.now() - arenaState.resolvedAt;
            // Раунд длится ровно 5.6 сек (0.5с старт + ~3.6с полет + 1.5с остановка). Сброс на 5.6 сек.
            if (elapsed >= 5600) {
                console.log(`[ARENA] 🔄 Раунд завершен. Сброс к ожиданию ставок для Игры №${arenaState.roundNumber + 1}`);
                arenaState.bets = [];
                arenaState.status = "waiting";
                arenaState.timeLeft = 15;
                arenaState.winnerId = null;
                arenaState.winnerName = null;
                arenaState.totalPool = 0;
                arenaState.roundNumber++;
                stateChanged = true;
            }
        }

        if (stateChanged) {
            saveArenaState();
        }
    } catch (err) {
        console.error("Arena interval error:", err.message);
    }
}, 1000);

// ДИАГОНАЛЬНОЕ ДЕЛЕНИЕ КВАДРАТА С ВЕРХНЕГО ЛЕВОГО УГЛА (0,0)
function getPerimeterPoint(s) {
    s = ((s % 1280) + 1280) % 1280;
    if (s <= 320) return { x: s, y: 0 };
    if (s <= 640) return { x: 320, y: s - 320 };
    if (s <= 960) return { x: 320 - (s - 640), y: 320 };
    return { x: 0, y: 320 - (s - 960) };
}

function getPlayerPolygons(bets) {
    const N = bets.length;
    if (N === 0) return [];

    let total = bets.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
    const shares = total > 0 ? bets.map(b => (parseFloat(b.amount) || 0) / total) : bets.map(() => 1 / N);

    let currentS = 0; // Старт строго с верхнего левого угла (0,0) -> s = 0
    const corners = [0, 320, 640, 960, 1280];
    const polygons = [];

    for (let i = 0; i < N; i++) {
        const share = shares[i];
        const len = share * 1280;
        const nextS = currentS + len;

        const pts = [{ x: 160, y: 160 }];
        pts.push(getPerimeterPoint(currentS));

        corners.forEach(c => {
            if (c > currentS && c < nextS) {
                pts.push(getPerimeterPoint(c));
            }
        });

        pts.push(getPerimeterPoint(nextS));

        polygons.push({
            userId: bets[i].userId,
            username: bets[i].username,
            points: pts,
            color: bets[i].color
        });

        currentS = nextS;
    }
    return polygons;
}

function isPointInPolygon(px, py, polygonPoints) {
    let inside = false;
    for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
        const xi = polygonPoints[i].x, yi = polygonPoints[i].y;
        const xj = polygonPoints[j].x, yj = polygonPoints[j].y;
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function getPolygonCentroid(pts) {
    if (!pts || pts.length === 0) return { x: 160, y: 160 };
    let sx = 0, sy = 0;
    pts.forEach(p => { sx += p.x; sy += p.y; });
    return { x: sx / pts.length, y: sy / pts.length };
}

// 100% ДЕТЕРМИНИРОВАННАЯ ФИЗИКА ДВИЖЕНИЯ ШАРИКА
function simulateBallPhysics(startX, startY, speed, angle) {
    const path = [];
    let x = Number(startX) || 160;
    let y = Number(startY) || 160;
    let vx = Math.cos(angle) * speed;
    let vy = Math.sin(angle) * speed;
    const radius = 8;
    const minX = radius;
    const maxX = 320 - radius;
    const minY = radius;
    const maxY = 320 - radius;

    // 1. Старт с паузой 0.5 секунды (30 кадров)
    for (let i = 0; i < 30; i++) {
        path.push({ x, y });
    }

    // 2. Быстрые и динамичные отскоки от стенок
    while (Math.hypot(vx, vy) > 0.15) {
        x += vx;
        y += vy;

        if (x <= minX) { x = minX; vx = -vx * 0.94; }
        else if (x >= maxX) { x = maxX; vx = -vx * 0.94; }

        if (y <= minY) { y = minY; vy = -vy * 0.94; }
        else if (y >= maxY) { y = maxY; vy = -vy * 0.94; }

        vx *= 0.984;
        vy *= 0.984;

        path.push({ x, y });
    }

    // 3. Полная остановка на 1.5 секунды (90 кадров)
    const finalX = x;
    const finalY = y;
    for (let i = 0; i < 90; i++) {
        path.push({ x: finalX, y: finalY });
    }

    return path;
}

// ОПРЕДЕЛЕНИЕ ПОБЕДИТЕЛЯ И РАСЧЕТ ТРАЕКТОРИИ ПОЛЁТА
async function resolveArenaRound() {
    try {
        if (arenaState.bets.length < 2) {
            arenaState.status = "waiting";
            arenaState.timeLeft = 15;
            saveArenaState();
            return;
        }

        let pool = 0;
        arenaState.bets.forEach(b => pool += parseFloat(b.amount));
        arenaState.totalPool = parseFloat(pool.toFixed(3));

        // Выбор победителя на основе величины ставки
        const rand = Math.random() * pool;
        let sum = 0;
        let winnerBet = arenaState.bets[arenaState.bets.length - 1];

        for (let i = 0; i < arenaState.bets.length; i++) {
            sum += arenaState.bets[i].amount;
            if (rand <= sum) {
                winnerBet = arenaState.bets[i];
                break;
            }
        }

        const winnerPolygons = getPlayerPolygons(arenaState.bets);
        const winnerPolyObj = winnerPolygons.find(p => String(p.userId) === String(winnerBet.userId));

        // Подбор высокой скорости и случайной траектории
        let chosenStartX = 160, chosenStartY = 160, chosenSpeed = 28, chosenAngle = 0;
        let trajectoryFound = false;

        for (let attempt = 0; attempt < 120; attempt++) {
            const startX = 35 + Math.random() * 250;
            const startY = 35 + Math.random() * 250;
            const speed = 25.0 + Math.random() * 12.0; // Высокая скорость полёта
            const angle = Math.random() * Math.PI * 2;

            const path = simulateBallPhysics(startX, startY, speed, angle);
            const restPoint = path[path.length - 1];

            if (winnerPolyObj && isPointInPolygon(restPoint.x, restPoint.y, winnerPolyObj.points)) {
                chosenStartX = startX;
                chosenStartY = startY;
                chosenSpeed = speed;
                chosenAngle = angle;
                trajectoryFound = true;
                break;
            }
        }

        if (!trajectoryFound) {
            chosenStartX = 160;
            chosenStartY = 160;
            chosenSpeed = 26;
            if (winnerPolyObj) {
                let centroid = getPolygonCentroid(winnerPolyObj.points);
                chosenAngle = Math.atan2(centroid.y - 160, centroid.x - 160);
            } else {
                chosenAngle = Math.random() * Math.PI * 2;
            }
        }

        const finalPath = simulateBallPhysics(chosenStartX, chosenStartY, chosenSpeed, chosenAngle);
        const finalRest = finalPath[finalPath.length - 1];

        arenaState.winnerId = winnerBet.userId;
        arenaState.winnerName = winnerBet.username;
        arenaState.winnerX = finalRest.x;
        arenaState.winnerY = finalRest.y;
        arenaState.startX = chosenStartX;
        arenaState.startY = chosenStartY;
        arenaState.initialSpeed = chosenSpeed;
        arenaState.angle = chosenAngle;
        arenaState.seed = "seed_" + Date.now();
        arenaState.resolvedAt = Date.now();
        arenaState.status = "running";
        arenaState.timeLeft = 0;

        saveArenaState();
        console.log(`[ARENA] 🏆 Победитель: @${winnerBet.username} (ID: ${winnerBet.userId}) Банк: ${pool} GRAM! Rest: x=${finalRest.x.toFixed(1)}, y=${finalRest.y.toFixed(1)}`);

        const winnerUser = await dbGetUser(winnerBet.userId);
        if (winnerUser) {
            winnerUser.balance = parseFloat((parseFloat(winnerUser.balance) + pool).toFixed(3));
            await dbSaveUser(winnerBet.userId, winnerUser);
        }
    } catch (err) {
        console.error("[ARENA] ❌ Ошибка розыгрыша раунда:", err);
        arenaState.status = "waiting";
        arenaState.timeLeft = 15;
        saveArenaState();
    }
}

async function getOrCreateUser(initDataUnsafe) {
    const tgUser = initDataUnsafe?.user || { id: "guest_user_id", username: "Пользователь", first_name: "Пользователь" };
    const id = String(tgUser.id);

    let user = await dbGetUser(id);
    if (!user) {
        user = {
            id: id,
            username: tgUser.username || tgUser.first_name || "Пользователь",
            first_name: tgUser.first_name || "",
            balance: 50.0,
            avatar_url: tgUser.photo_url || "https://img.icons8.com/color/96/user.png",
            last_daily_case_open: null,
            is_banned: false
        };
        await dbSaveUser(id, user);
    }
    return user;
}

async function parseTelegramInitData(req, res, next) {
    const rawHeader = req.headers['x-telegram-init-data'];
    let initDataUnsafe = {};
    if (rawHeader) {
        try {
            const params = new URLSearchParams(rawHeader);
            const userRaw = params.get('user');
            if (userRaw) {
                initDataUnsafe.user = JSON.parse(userRaw);
            }
        } catch (e) {
            console.error("InitData parsing error:", e);
        }
    }

    const user = await getOrCreateUser(initDataUnsafe);

    if (user.is_banned === true || user.is_banned === 'true') {
        return res.status(403).json({ banned: true, error: "Ваш аккаунт заблокирован!" });
    }

    req.user = user;
    next();
}

app.get('/api/user', parseTelegramInitData, (req, res) => {
    const user = req.user;
    const isAdmin = String(user.id).trim() === String(ADMIN_CHAT_ID).trim();

    res.json({
        id: user.id,
        username: user.username,
        first_name: user.first_name,
        balance: user.balance,
        avatar_url: user.avatar_url,
        last_daily_case_open: user.last_daily_case_open,
        is_banned: user.is_banned,
        isAdmin: isAdmin
    });
});

app.post('/api/verify_payment', parseTelegramInitData, async (req, res) => {
    const { amount } = req.body;
    const paymentAmount = parseFloat(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    const userId = req.user.id;
    enqueueUserAction(userId, async () => {
        const user = await dbGetUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        user.balance = parseFloat((parseFloat(user.balance) + paymentAmount).toFixed(3));
        await dbSaveUser(user.id, user);

        if (bot && ADMIN_CHAT_ID) {
            const textMsg = "💎 **Пополнение баланса!**\n" +
                "Игрок @" + user.username + " (ID: " + user.id + ") успешно зачислил через кошелек **+" + paymentAmount.toFixed(3) + " TON**!";
            bot.sendMessage(ADMIN_CHAT_ID, textMsg, { parse_mode: "Markdown" });
        }

        res.json({ success: true, newBalance: user.balance });
    });
});

app.post('/api/deposit_gift_request', parseTelegramInitData, async (req, res) => {
    const { itemId } = req.body;
    const gift = ALL_GIFT_ITEMS[itemId];
    const user = req.user;

    if (!gift) {
        return res.status(400).json({ error: "Item not found" });
    }

    if (bot && ADMIN_CHAT_ID) {
        const messageText = "📥 **Заявка на ввод NFT-подарка!**\n\n" +
            "**Игрок:** @" + user.username + " (ID: `" + user.id + "`)\n" +
            "**Подарок:** *" + gift.name + "*\n" +
            "**Номинал:** " + gift.value + " GRAM";

        const inlineKeyboard = {
            inline_keyboard: [
                [
                    { text: "Одобрить ✅", callback_data: "approve_dep_" + user.id + "_" + itemId },
                    { text: "Отклонить ❌", callback_data: "reject_dep_" + user.id + "_" + itemId }
                ]
            ]
        };

        bot.sendMessage(ADMIN_CHAT_ID, messageText, { parse_mode: "Markdown", reply_markup: inlineKeyboard });
    }

    res.json({ success: true });
});

app.get('/api/inventory', parseTelegramInitData, async (req, res) => {
    const userInventory = await dbGetInventory(req.user.id);
    res.json(userInventory);
});

app.post('/api/sell_gift', parseTelegramInitData, async (req, res) => {
    const { itemId, price } = req.body;
    const userId = req.user.id;
    const sellPrice = parseFloat(price) || 0.1;

    enqueueUserAction(userId, async () => {
        const user = await dbGetUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        await dbRemoveInventoryItem(user.id, itemId);

        user.balance = parseFloat((parseFloat(user.balance) + sellPrice).toFixed(3));
        await dbSaveUser(user.id, user);

        res.json({ success: true, newBalance: user.balance });
    });
});

app.post('/api/withdraw_gift', parseTelegramInitData, async (req, res) => {
    const { itemId } = req.body;
    const user = req.user;
    const gift = ALL_GIFT_ITEMS[itemId];

    if (!gift) return res.status(400).json({ error: "Item not found" });

    await dbRemoveInventoryItem(user.id, itemId);

    if (bot && ADMIN_CHAT_ID) {
        const textMsg = "📤 **Заявка на вывод подарка!**\n" +
            "**Игрок:** @" + user.username + " (ID: " + user.id + ")\n" +
            "**Предмет на вывод:** *" + gift.name + "* (" + gift.value + " GRAM)\n\n" +
            "_Пожалуйста, отправьте ему этот подарок в Telegram!_";
        bot.sendMessage(ADMIN_CHAT_ID, textMsg, { parse_mode: "Markdown" });
    }

    res.json({ success: true });
});

app.post('/api/send_gift', parseTelegramInitData, async (req, res) => {
    const { targetUsername, itemId } = req.body;
    const senderId = req.user.id;

    if (!targetUsername || !itemId) {
        return res.status(400).json({ error: "Неверные параметры запроса" });
    }

    enqueueUserAction(senderId, async () => {
        const recipient = await dbGetUserByUsername(targetUsername);
        if (!recipient) {
            return res.status(404).json({ error: "Пользователь с таким юзернеймом не найден" });
        }

        if (String(recipient.id) === String(senderId)) {
            return res.status(400).json({ error: "Нельзя отправить подарок самому себе" });
        }

        const senderInv = await dbGetInventory(senderId);
        const hasItem = senderInv.some(i => parseInt(i.item_id) === parseInt(itemId));
        if (!hasItem) {
            return res.status(400).json({ error: "У вас нет этого предмета в инвентаре" });
        }

        await dbRemoveInventoryItem(senderId, itemId);
        await dbAddInventoryItem(recipient.id, itemId);

        if (bot) {
            bot.sendMessage(
                recipient.id, 
                `🎁 **Вам подарок!**\nПользователь @${req.user.username || 'Друг'} отправляет вам подарок! Зайдите в раздел «Инвентарь» в приложении!`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        res.json({ success: true, message: `Подарок успешно передан пользователю @${recipient.username}!` });
    });
});

app.post('/api/place_bet', parseTelegramInitData, async (req, res) => {
    const userId = req.user.id;

    enqueueUserAction(userId, async () => {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount < 0.1) {
            return res.status(400).json({ error: "Недопустимая сумма ставки" });
        }

        if (arenaState.status === "running") {
            return res.status(400).json({ error: "Раунд в процессе симуляции, подождите..." });
        }

        const user = await dbGetUser(userId);
        if (!user) {
            return res.status(404).json({ error: "Пользователь не найден" });
        }

        if (parseFloat(user.balance) < amount) {
            return res.status(400).json({ error: "Недостаточно баланса" });
        }

        user.balance = parseFloat((parseFloat(user.balance) - amount).toFixed(3));
        await dbSaveUser(user.id, user);

        const existingBet = arenaState.bets.find(b => String(b.userId) === String(user.id));
        if (existingBet) {
            existingBet.amount = parseFloat((existingBet.amount + amount).toFixed(3));
        } else {
            const chosenColor = assignUniqueColor(arenaState.bets);
            arenaState.bets.push({
                userId: user.id,
                username: user.username,
                avatar: user.avatar_url,
                amount: amount,
                color: chosenColor
            });
        }

        saveArenaState();
        res.json({ success: true, newBalance: user.balance });
    }).catch(err => {
        console.error("Bet queue error:", err);
        res.status(500).json({ error: "Внутренняя ошибка сервера" });
    });
});

app.get('/api/arena/state', parseTelegramInitData, (req, res) => {
    res.json({
        status: arenaState.status,
        roundNumber: arenaState.roundNumber,
        bets: arenaState.bets,
        timeLeft: arenaState.timeLeft,
        resolvedAt: arenaState.resolvedAt,
        winnerId: arenaState.winnerId,
        winnerName: arenaState.winnerName,
        winnerX: arenaState.winnerX,
        winnerY: arenaState.winnerY,
        totalPool: arenaState.totalPool,
        seed: arenaState.seed,
        startX: arenaState.startX,
        startY: arenaState.startY,
        angle: arenaState.angle,
        initialSpeed: arenaState.initialSpeed,
        serverTime: Date.now()
    });
});

app.post('/api/open_daily_case', parseTelegramInitData, async (req, res) => {
    const userId = req.user.id;

    enqueueUserAction(userId, async () => {
        const user = await dbGetUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const now = Date.now();
        const cooldown = 24 * 60 * 60 * 1000;
        const isAdmin = String(user.id).trim() === String(ADMIN_CHAT_ID).trim();

        if (!isAdmin && user.last_daily_case_open && (now - new Date(user.last_daily_case_open).getTime() < cooldown)) {
            return res.status(400).json({ error: "Кейс еще недоступен" });
        }

        const rewards = [
            { id: 10, name: "Роза", type: "gift", value: 0.27 },
            { id: 11, name: "Пополнение 0.1 GRAM", type: "balance", value: 0.1 },
            { id: 14, name: "Пополнение 0.03 GRAM", type: "balance", value: 0.03 }
        ];
        const won = rewards[Math.floor(Math.random() * rewards.length)];

        user.last_daily_case_open = new Date().toISOString();
        if (won.type === "balance") {
            user.balance = parseFloat((parseFloat(user.balance) + won.value).toFixed(3));
        } else {
            await dbAddInventoryItem(user.id, won.id);
            if (bot && ADMIN_CHAT_ID) {
                const winNotify = "🎉 **Новый выигрыш в Кейсе!**\n" +
                    "Игрок @" + user.username + " (ID: " + user.id + ") выиграл *" + won.name + "* в **Ежедневном Кейсе**!";
                bot.sendMessage(ADMIN_CHAT_ID, winNotify, { parse_mode: "Markdown" });
            }
        }
        await dbSaveUser(user.id, user);

        res.json({ success: true, wonItem: won, newBalance: user.balance });
    });
});

app.post('/api/open_newbie_case', parseTelegramInitData, async (req, res) => {
    const userId = req.user.id;

    enqueueUserAction(userId, async () => {
        const user = await dbGetUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const price = 0.1;

        if (parseFloat(user.balance) < price) {
            return res.status(400).json({ error: "Недостаточно баланса" });
        }

        user.balance = parseFloat((parseFloat(user.balance) - price).toFixed(3));

        const rewards = [
            { id: 109, name: "Холодный огонь", type: "gift", value: 2.2 },
            { id: 112, name: "Мишка классический", type: "gift", value: 0.11 },
            { id: 113, name: "Пополнение 0.1 GRAM (Новичок)", type: "balance", value: 0.1 }
        ];
        const won = rewards[Math.floor(Math.random() * rewards.length)];

        if (won.type === "balance") {
            user.balance = parseFloat((parseFloat(user.balance) + won.value).toFixed(3));
        } else {
            await dbAddInventoryItem(user.id, won.id);
            if (bot && ADMIN_CHAT_ID) {
                const winNotify = "🎉 **Новый выигрыш в Кейсе!**\n" +
                    "Игрок @" + user.username + " (ID: " + user.id + ") выиграл *" + won.name + "* в **Кейсе Новичка**!";
                bot.sendMessage(ADMIN_CHAT_ID, winNotify, { parse_mode: "Markdown" });
            }
        }
        await dbSaveUser(user.id, user);

        res.json({ success: true, wonItem: won, newBalance: user.balance });
    });
});

app.get('/api/daily_case_info', (req, res) => {
    res.json({ channel_username: "@BestGiftsChannel" });
});

app.get('/api/deposit_address', (req, res) => {
    res.json({ address: DEPOSIT_ADDRESS });
});

app.get('/api/generate_payload', (req, res) => {
    res.json({ payload: "te6ccgEBAQEAAgAAAA==" });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
