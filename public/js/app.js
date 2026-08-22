const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : {
    expand: () => {},
    ready: () => {},
    initData: "",
    initDataUnsafe: { user: { id: "guest_user_id", username: "Пользователь", first_name: "Пользователь" } },
    openLink: (url) => window.open(url, '_blank'),
    openTelegramLink: (url) => window.open(url, '_blank')
};

tg.expand();
tg.ready();

(function injectStyles() {
    const style = document.createElement('style');
    style.innerHTML = `
        .arena-player-avatar-node {
            position: absolute !important;
            transform: translate(-50%, -50%) !important;
            border-radius: 50% !important;
            border: 3px solid #ffffff !important;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5) !important;
            object-fit: cover !important;
            pointer-events: none !important;
            z-index: 5 !important;
        }

        #arena-svg-canvas,
        #arena-ball-svg {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            border-radius: 16px;
            overflow: hidden;
            aspect-ratio: 1 / 1 !important;
        }

        #arena-svg-canvas {
            z-index: 1;
            background: #110e25 !important;
        }

        #arena-ball-svg {
            z-index: 10;
            pointer-events: none;
            background: transparent !important;
        }

        #physics-ball {
            fill: #ffffff !important;
            r: 8 !important;
            filter: drop-shadow(0 0 8px #ffffff) drop-shadow(0 0 18px #8d3df5) !important;
        }

        .winning-segment-glow {
            stroke: #ffffff !important;
            stroke-width: 6px !important;
            stroke-linejoin: round !important;
            animation: winningSectorPulse 0.35s infinite alternate !important;
        }

        @keyframes winningSectorPulse {
            0% {
                filter: drop-shadow(0 0 15px var(--glow-color)) brightness(1.2);
                stroke-width: 5px;
            }
            50% {
                filter: drop-shadow(0 0 35px var(--glow-color)) brightness(1.7);
                stroke-width: 8px;
            }
            100% {
                filter: drop-shadow(0 0 15px var(--glow-color)) brightness(1.2);
                stroke-width: 5px;
            }
        }
    `;
    document.head.appendChild(style);
})();

let localGuestId = localStorage.getItem('mock_guest_id');
if (!localGuestId) {
    localGuestId = 'guest_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('mock_guest_id', localGuestId);
}

let initDataHeader = tg.initData || "";
if (!initDataHeader) {
    const mockUser = {
        id: localGuestId,
        username: "Игрок_" + localGuestId.substring(6),
        first_name: "Игрок",
        photo_url: "https://img.icons8.com/color/96/user.png"
    };
    initDataHeader = "user=" + encodeURIComponent(JSON.stringify(mockUser));
}

function formatUsername(name) {
    if (!name) return "Пользователь";
    return name.length > 15 ? name.substring(0, 15) + "..." : name;
}

function formatItemName(name) {
    if (!name) return "";
    let clean = name.replace(/\.(png|jpg|jpeg)$/i, '');
    clean = clean.replace(/_/g, ' ');
    return clean.trim();
}

function formatWalletAddress(rawAddress) {
    if (!rawAddress) return "";
    try {
        if (typeof TON_CONNECT_UI !== 'undefined' && TON_CONNECT_UI.toUserFriendlyAddress) {
            const friendly = TON_CONNECT_UI.toUserFriendlyAddress(rawAddress);
            return friendly.substring(0, 4) + "-..." + friendly.substring(friendly.length - 4);
        }
    } catch (e) {}
    return rawAddress.substring(0, 4) + "-..." + rawAddress.substring(rawAddress.length - 4);
}

function preloadImages(urls) {
    urls.forEach(url => {
        const img = new Image();
        img.src = url;
    });
}

const DEFAULT_COLOR_PALETTE = [
    '#ff2d55',
    '#00e676',
    '#0088cc',
    '#ffcc00',
    '#8d3df5',
    '#e040fb',
    '#00e5ff',
    '#ff9100',
    '#76ff03',
    '#d500f9',
    '#1de9b6',
    '#ff6d00',
    '#3d5afe',
    '#c6ff00',
    '#ff1744'
];

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 10000 } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

function triggerBalanceBadge(amount) {
    const container = document.getElementById('balance-badge-container');
    if (!container) return;

    const numericAmount = parseFloat(amount) || 0;
    const badge = document.createElement('div');
    const isNegative = numericAmount < 0;

    badge.className = `balance-popup-badge ${isNegative ? 'negative' : 'positive'}`;
    badge.innerText = (isNegative ? '' : '+') + numericAmount.toFixed(3);
    container.appendChild(badge);

    setTimeout(() => {
        if (badge.parentNode) badge.remove();
    }, 2500);
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const API_BASE_URL = window.location.origin;
        const GRAMCOIN_ICON_URL = "/Images/Items/gram_popolnenie.png";

        let currentUser = {};
        let isNewbieCaseMode = false;
        let customBets = [0.1, 1.0, 5.0];

        let arenaPlayers = [];
        let isPollingActive = false;
        let isBallAnimating = false;
        let arenaStatusStr = 'waiting';

        let lastAnimatedRound = null;
        let lastShowedWinnerRound = null;
        let lastObservedRoundNumber = null;
        let currentServerRoundNumber = 0;
        let localExpectedBetAmount = 0;
        let countdownIntervalId = null;
        let localCountdownValue = 0;
        let dailyCaseTimerInterval = null;
        let localBetThrottle = false;

        const safeSetText = (element, value) => {
            if (element) element.innerText = value;
        };

        let userId = tg.initDataUnsafe?.user?.id;

        if (!userId) {
            try {
                const params = new URLSearchParams(initDataHeader);
                const userRaw = params.get('user');
                if (userRaw) {
                    userId = JSON.parse(userRaw).id;
                }
            } catch (error) {}
        }

        if (!userId) userId = localGuestId;

        const elements = {
            homeSection: document.getElementById('home-section'),
            caseSection: document.getElementById('case-section'),
            inventorySection: document.getElementById('inventory-section'),
            ratingSection: document.getElementById('rating-section'),
            balanceSection: document.getElementById('balance-section'),
            arenaSection: document.getElementById('arena-section'),
            rouletteTrack: document.getElementById('roulette-track'),
            spinBtn: document.getElementById('spin-case-button'),
            balanceDisplayPill: document.getElementById('user-balance-pill-value'),
            largeBalanceDisplay: document.getElementById('large-balance-value'),
            rewardsGrid: document.getElementById('rewards-grid'),
            inventoryGrid: document.getElementById('inventory-grid'),
            bottomNavigation: document.querySelector('.floating-nav-container'),
            navTabs: document.querySelectorAll('.nav-tab'),
            dailyCaseBanner: document.getElementById('daily-case-banner'),
            newbieCaseBanner: document.getElementById('newbie-case-banner'),
            rewardsSectionContainer: document.getElementById('rewards-section-container'),
            rewardsGridTitle: document.getElementById('rewards-grid-title'),
            casePageMainTitle: document.getElementById('case-page-main-title'),
            connectWalletBtn: document.getElementById('connect-wallet-btn'),
            depositBalanceBtn: document.getElementById('deposit-balance-btn'),
            depositNoticeText: document.getElementById('deposit-notice-text'),
            depositAmountModal: document.getElementById('deposit-amount-modal'),
            depositModalCloseBtn: document.getElementById('deposit-modal-close-btn'),
            modalDepositInput: document.getElementById('modal-deposit-input'),
            modalDepositConfirmBtn: document.getElementById('modal-deposit-confirm-btn'),
            modalDepositCancelBtn: document.getElementById('modal-deposit-cancel-btn'),
            adminTgChatTrigger: document.getElementById('admin-tg-chat-trigger'),
            arenaRoundNumber: document.getElementById('arena-round-number'),
            arenaPlayersTotal: document.getElementById('arena-players-total'),
            bannedOverlay: document.getElementById('banned-screen')
        };

        function showBannedScreen() {
            if (elements.bannedOverlay) {
                elements.bannedOverlay.classList.remove('hidden');
            }

            stopArenaPolling();

            if (elements.bottomNavigation) {
                elements.bottomNavigation.classList.add('hidden');
            }

            document.querySelectorAll('.app-section').forEach(section => {
                section.classList.add('hidden');
            });
        }

        function loadSavedBets() {
            try {
                const saved = localStorage.getItem(`custom_bets_${userId}`);
                if (!saved) return;

                const parsed = JSON.parse(saved);
                if (!Array.isArray(parsed) || parsed.length !== 3) return;

                customBets = parsed.map(value => {
                    const numericValue = parseFloat(value);
                    return Number.isFinite(numericValue) && numericValue >= 0.1 ? numericValue : 0.1;
                });
            } catch (error) {
                customBets = [0.1, 1.0, 5.0];
            }
        }

        function loadCachedUserData() {
            try {
                const cachedData = localStorage.getItem(`user_cache_${userId}`);
                if (!cachedData) return;

                const cache = JSON.parse(cachedData);
                if (!cache) return;

                if (cache.is_banned === true || cache.is_banned === 'true') {
                    showBannedScreen();
                    return;
                }

                currentUser = cache;
                updateBalanceUI();

                const rawName = cache.username || cache.first_name || 'Пользователь';
                safeSetText(document.getElementById('user-username'), formatUsername(rawName));

                const mainAvatar = document.getElementById('user-avatar');
                if (mainAvatar && cache.avatar_url) {
                    mainAvatar.src = cache.avatar_url;
                    mainAvatar.onerror = () => {
                        mainAvatar.src = 'https://img.icons8.com/color/96/user.png';
                    };
                }
            } catch (error) {}
        }

        function showNotification(message, icon = '🎁') {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const toast = document.createElement('div');
            toast.className = 'custom-toast';
            toast.innerHTML = `
                <div class="custom-toast-icon">${icon}</div>
                <div class="custom-toast-content">${message}</div>
                <button class="custom-toast-close">&times;</button>
            `;

            container.appendChild(toast);

            setTimeout(() => toast.classList.add('show'), 50);

            const closeButton = toast.querySelector('.custom-toast-close');
            if (closeButton) {
                closeButton.addEventListener('click', () => {
                    toast.classList.remove('show');
                    setTimeout(() => {
                        if (toast.parentNode) toast.remove();
                    }, 400);
                });
            }

            setTimeout(() => {
                if (!toast.parentNode) return;
                toast.classList.remove('show');
                setTimeout(() => {
                    if (toast.parentNode) toast.remove();
                }, 400);
            }, 5000);
        }

        function showCustomModal({ icon = '🎁', title, message, buttons = [], onClose = null }) {
            const overlay = document.getElementById('custom-modal');
            const modalIcon = document.getElementById('modal-icon');
            const modalTitle = document.getElementById('modal-title');
            const modalMessage = document.getElementById('modal-message');
            const actionsContainer = document.getElementById('modal-actions');
            const closeButton = document.getElementById('modal-close-btn');

            if (!overlay) return;

            if (modalIcon) modalIcon.innerHTML = icon;
            if (modalTitle) modalTitle.innerText = title || '';
            if (modalMessage) modalMessage.innerText = message || '';
            if (actionsContainer) actionsContainer.innerHTML = '';

            buttons.forEach(buttonConfig => {
                const button = document.createElement('button');
                button.className = `modal-btn ${buttonConfig.primary ? 'modal-btn-primary' : 'modal-btn-secondary'}`;
                button.innerText = buttonConfig.text;

                button.addEventListener('click', () => {
                    overlay.classList.add('hidden');
                    if (buttonConfig.onClick) buttonConfig.onClick();
                });

                if (actionsContainer) actionsContainer.appendChild(button);
            });

            const handleClose = () => {
                overlay.classList.add('hidden');
                if (onClose) onClose();
            };

            if (closeButton) closeButton.onclick = handleClose;
            overlay.classList.remove('hidden');
        }

        // TON CONNECT
        let tonConnectUI = null;

        try {
            const manifestUrl = `${API_BASE_URL}/tonconnect-manifest.json`;
            const customStorage = {
                setItem: (key, value) => {
                    try {
                        localStorage.setItem(`tc-${userId}-${key}`, value);
                    } catch (error) {}
                },
                getItem: key => {
                    try {
                        return localStorage.getItem(`tc-${userId}-${key}`);
                    } catch (error) {
                        return null;
                    }
                },
                removeItem: key => {
                    try {
                        localStorage.removeItem(`tc-${userId}-${key}`);
                    } catch (error) {}
                }
            };

            const initTonConnect = () => {
                const TonConnectConstructor = window.TON_CONNECT_UI || window.TonConnectUI;
                if (!TonConnectConstructor) return;

                tonConnectUI = new TonConnectConstructor.TonConnectUI({
                    manifestUrl,
                    storage: customStorage
                });

                tonConnectUI.onStatusChange(wallet => {
                    if (wallet) {
                        const displayAddress = formatWalletAddress(wallet.account.address);

                        if (elements.connectWalletBtn) {
                            elements.connectWalletBtn.innerText = `Привязан: (${displayAddress})`;
                            elements.connectWalletBtn.style.background = 'linear-gradient(135deg, #00e676, #00b34a)';
                            elements.connectWalletBtn.style.color = '#000000';
                        }

                        if (elements.depositBalanceBtn) {
                            elements.depositBalanceBtn.removeAttribute('disabled');
                        }

                        if (elements.depositNoticeText) {
                            elements.depositNoticeText.innerText = 'Кошелек подключен!';
                            elements.depositNoticeText.style.color = '#00e676';
                        }
                    } else {
                        if (elements.connectWalletBtn) {
                            elements.connectWalletBtn.innerText = 'Привязать кошелёк';
                            elements.connectWalletBtn.style.background = 'linear-gradient(135deg, var(--accent-purple), #6a0dad)';
                            elements.connectWalletBtn.style.color = '#ffffff';
                        }

                        if (elements.depositBalanceBtn) {
                            elements.depositBalanceBtn.setAttribute('disabled', 'true');
                        }

                        if (elements.depositNoticeText) {
                            elements.depositNoticeText.innerText = 'Пополнение доступно после привязки кошелька';
                            elements.depositNoticeText.style.color = '#a5a1b8';
                        }
                    }
                });

                if (elements.connectWalletBtn) {
                    elements.connectWalletBtn.addEventListener('click', async () => {
                        if (tonConnectUI.connected) {
                            showCustomModal({
                                icon: '🔌',
                                title: 'Отключить кошелек?',
                                message: 'Вы уверены, что хотите отвязать текущий TON-кошелек?',
                                buttons: [
                                    {
                                        text: 'Отвязать',
                                        primary: true,
                                        onClick: async () => {
                                            await tonConnectUI.disconnect();
                                            showNotification('Кошелек успешно отвязан', '🔌');
                                        }
                                    },
                                    {
                                        text: 'Отмена',
                                        primary: false
                                    }
                                ]
                            });
                        } else {
                            await tonConnectUI.openModal();
                        }
                    });
                }
            };

            if (window.TON_CONNECT_UI || window.TonConnectUI) {
                initTonConnect();
            } else {
                document.addEventListener('ton-connect-ui-loaded', initTonConnect);
            }
        } catch (error) {
            console.error('TON Connect init error:', error);
        }

        if (elements.depositBalanceBtn) {
            elements.depositBalanceBtn.addEventListener('click', () => {
                if (elements.depositAmountModal) {
                    elements.depositAmountModal.classList.remove('hidden');
                }
                if (elements.modalDepositInput) {
                    elements.modalDepositInput.value = '0.1';
                }
            });
        }

        const closeDepositModal = () => {
            if (elements.depositAmountModal) {
                elements.depositAmountModal.classList.add('hidden');
            }
        };

        if (elements.depositModalCloseBtn) {
            elements.depositModalCloseBtn.addEventListener('click', closeDepositModal);
        }

        if (elements.modalDepositCancelBtn) {
            elements.modalDepositCancelBtn.addEventListener('click', closeDepositModal);
        }

        if (elements.modalDepositConfirmBtn) {
            elements.modalDepositConfirmBtn.addEventListener('click', async () => {
                const amount = parseFloat(elements.modalDepositInput?.value || '0');

                if (!Number.isFinite(amount) || amount < 0.1) {
                    showNotification('Минимальная сумма пополнения — 0.1 TON', '⚠️');
                    return;
                }

                if (!tonConnectUI || !tonConnectUI.connected) {
                    showNotification('Пожалуйста, сначала привяжите кошелек!', '⚠️');
                    return;
                }

                closeDepositModal();

                try {
                    const nanoAmount = Math.floor(amount * 1000000000).toString();
                    const transaction = {
                        validUntil: Math.floor(Date.now() / 1000) + 360,
                        messages: [{
                            address: 'EQC3481up9_gG98_wK8Jv_Zz1yLp9p0_Y-7Jv7x4b9a9JKe6',
                            amount: nanoAmount,
                            payload: 'te6ccgEBAQEAAgAAAA=='
                        }]
                    };

                    showNotification('Подтвердите транзакцию...', '⏳');
                    const result = await tonConnectUI.sendTransaction(transaction);

                    if (result) {
                        currentUser.balance = parseFloat((parseFloat(currentUser.balance || 0) + amount).toFixed(3));
                        updateBalanceUI();
                        triggerBalanceBadge(amount);
                        showNotification(`Баланс пополнен на +${amount.toFixed(3)} TON!`, '💎');

                        fetch(`${API_BASE_URL}/api/verify_payment`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Telegram-Init-Data': initDataHeader
                            },
                            body: JSON.stringify({ amount })
                        })
                            .then(response => {
                                if (response.status === 403) showBannedScreen();
                                else if (response.ok) fetchUserData();
                            })
                            .catch(error => console.error('Verify backend error:', error));
                    }
                } catch (error) {
                    showNotification('Транзакция отменена кошельком.', '⚠️');
                }
            });
        }

        // ===================== АРЕНА: ДИАГОНАЛЬНОЕ ДЕЛЕНИЕ И ФИЗИКА =====================

        function calculateSharesProtection(players) {
            const count = players.length;
            if (count === 0) return [];

            const bets = players.map(player => {
                const value = parseFloat(player.bet);
                return Number.isFinite(value) && value > 0 ? value : 0;
            });

            const total = bets.reduce((sum, value) => sum + value, 0);
            if (total <= 0) return bets.map(() => 1 / count);

            return bets.map(value => value / total);
        }

        function getPerimeterPoint(s) {
            s = ((s % 1280) + 1280) % 1280;
            if (s <= 320) return { x: s, y: 0 };
            if (s <= 640) return { x: 320, y: s - 320 };
            if (s <= 960) return { x: 320 - (s - 640), y: 320 };
            return { x: 0, y: 320 - (s - 960) };
        }

        function getPolygonCentroid(points) {
            if (!points || points.length === 0) {
                return { x: 160, y: 160 };
            }
            let averageX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
            let averageY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
            return { x: averageX, y: averageY };
        }

        function getPlayerColor(player, index) {
            if (player && player.color) return player.color;
            return DEFAULT_COLOR_PALETTE[index % DEFAULT_COLOR_PALETTE.length];
        }

        function drawArenaSegments() {
            try {
                const svg = document.getElementById('arena-svg-canvas');
                const avatarsContainer = document.getElementById('arena-avatars-container');
                const statusText = document.getElementById('arena-status-text');
                const countdownTimer = document.getElementById('arena-countdown-timer');

                if (!svg || !avatarsContainer) return;

                svg.innerHTML = '';
                avatarsContainer.innerHTML = '';

                const count = arenaPlayers.length;

                if (count === 0) {
                    if (statusText) {
                        statusText.classList.remove('hidden');
                        statusText.innerText = 'Ждем ставки...';
                    }
                    if (countdownTimer) countdownTimer.classList.add('hidden');
                    return;
                }

                if (count === 1) {
                    const player = arenaPlayers[0];
                    const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');

                    rectangle.setAttribute('x', '0');
                    rectangle.setAttribute('y', '0');
                    rectangle.setAttribute('width', '320');
                    rectangle.setAttribute('height', '320');
                    rectangle.setAttribute('fill', getPlayerColor(player, 0));
                    rectangle.setAttribute('fill-opacity', '0.96');
                    rectangle.setAttribute('data-user-id', String(player.userId));

                    svg.appendChild(rectangle);
                    createAvatarElement(160, 230, player.avatar, 56);

                    if (statusText) {
                        statusText.classList.remove('hidden');
                        statusText.innerText = 'Ждем ставки...';
                    }

                    if (countdownTimer) countdownTimer.classList.add('hidden');
                    return;
                }

                if (statusText) statusText.classList.add('hidden');

                const shares = calculateSharesProtection(arenaPlayers);
                let currentS = 0; // Старт строго с верхнего левого угла (0,0) -> s = 0
                const corners = [0, 320, 640, 960, 1280];

                for (let index = 0; index < count; index++) {
                    const player = arenaPlayers[index];
                    const share = Math.max(0.000001, shares[index] || 0);
                    const len = share * 1280;
                    const nextS = currentS + len;

                    const points = [{ x: 160, y: 160 }];
                    points.push(getPerimeterPoint(currentS));

                    corners.forEach(c => {
                        if (c > currentS && c < nextS) {
                            points.push(getPerimeterPoint(c));
                        }
                    });

                    points.push(getPerimeterPoint(nextS));

                    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                    polygon.setAttribute('points', points.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '));
                    polygon.setAttribute('fill', getPlayerColor(player, index));
                    polygon.setAttribute('fill-opacity', '0.96');
                    polygon.setAttribute('stroke', 'rgba(255,255,255,0.42)');
                    polygon.setAttribute('stroke-width', '2');
                    polygon.setAttribute('data-user-id', String(player.userId));

                    svg.appendChild(polygon);

                    const centroid = getPolygonCentroid(points);
                    const dx = centroid.x - 160;
                    const dy = centroid.y - 160;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    let avatarX = centroid.x;
                    let avatarY = centroid.y;

                    if (distance < 70) {
                        if (distance < 0.01) {
                            avatarX = 160;
                            avatarY = 80;
                        } else {
                            avatarX = 160 + (dx / distance) * 82;
                            avatarY = 160 + (dy / distance) * 82;
                        }
                    }

                    avatarX = Math.max(28, Math.min(292, avatarX));
                    avatarY = Math.max(28, Math.min(292, avatarY));
                    createAvatarElement(avatarX, avatarY, player.avatar, count <= 3 ? 48 : 38);

                    currentS = nextS;
                }
            } catch (error) {
                console.error('Ошибка отрисовки сегментов арены:', error);
            }
        }

        function createAvatarElement(x, y, src, size) {
            const container = document.getElementById('arena-avatars-container');
            if (!container) return;

            const image = document.createElement('img');
            image.className = 'arena-player-avatar-node';
            image.src = src || 'https://img.icons8.com/color/96/user.png';
            image.alt = 'Avatar';
            image.style.left = `${x}px`;
            image.style.top = `${y}px`;
            image.style.width = `${size}px`;
            image.style.height = `${size}px`;
            image.onerror = () => {
                image.src = 'https://img.icons8.com/color/96/user.png';
            };

            container.appendChild(image);
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

        function getPlayerAtCoords(x, y) {
            const count = arenaPlayers.length;
            if (count === 0) return null;
            if (count === 1) return arenaPlayers[0];

            const shares = calculateSharesProtection(arenaPlayers);
            let currentS = 0;
            const corners = [0, 320, 640, 960, 1280];

            for (let index = 0; index < count; index++) {
                const len = shares[index] * 1280;
                const nextS = currentS + len;
                const points = [{ x: 160, y: 160 }];

                points.push(getPerimeterPoint(currentS));
                corners.forEach(c => {
                    if (c > currentS && c < nextS) points.push(getPerimeterPoint(c));
                });
                points.push(getPerimeterPoint(nextS));

                if (isPointInPolygon(x, y, points)) {
                    return arenaPlayers[index];
                }
                currentS = nextS;
            }

            return arenaPlayers[count - 1];
        }

        function updatePlayersListUI() {
            const listContainer = document.getElementById('arena-players-list');
            if (!listContainer) return;

            if (arenaPlayers.length === 0) {
                listContainer.innerHTML = '<div class="empty-list-placeholder">Ставок еще нет. Станьте первым!</div>';
                safeSetText(elements.arenaPlayersTotal, '0');
                return;
            }

            const totalBet = arenaPlayers.reduce((sum, player) => {
                const amount = parseFloat(player.bet);
                return sum + (Number.isFinite(amount) ? amount : 0);
            }, 0);

            listContainer.innerHTML = '';

            arenaPlayers.forEach((player, index) => {
                const amount = parseFloat(player.bet) || 0;
                const chance = totalBet > 0 ? (amount / totalBet) * 100 : 0;
                const color = getPlayerColor(player, index);
                const row = document.createElement('div');

                row.className = 'player-list-row';
                row.style.borderLeft = `4px solid ${color}`;

                row.innerHTML = `
                    <div class="player-row-left">
                        <img class="player-row-avatar" src="${player.avatar || 'https://img.icons8.com/color/96/user.png'}" onerror="this.src='https://img.icons8.com/color/96/user.png';" alt="Avatar">
                        <div class="player-info-column">
                            <span class="player-row-name">${player.username || 'Игрок'}</span>
                            <span class="player-row-chance">${chance.toFixed(2)}% шанс</span>
                        </div>
                    </div>
                    <div class="player-row-right">
                        <span class="player-row-bet-value">${amount.toFixed(3)}</span>
                        <img class="player-row-coin" src="${GRAMCOIN_ICON_URL}" alt="GRAM">
                    </div>
                `;

                listContainer.appendChild(row);
            });

            safeSetText(elements.arenaPlayersTotal, String(arenaPlayers.length));
        }

        function renderBetButtons() {
            const balance = parseFloat(currentUser.balance || 0);
            const blockBets = isBallAnimating || arenaStatusStr === 'running';

            for (let index = 0; index < 3; index++) {
                const button = document.getElementById(`bet-btn-${index + 1}`);
                if (!button) continue;

                const betValue = parseFloat(customBets[index]);
                const valueElement = button.querySelector('.bet-val');

                if (valueElement) valueElement.innerText = String(betValue);
                button.setAttribute('data-bet', String(betValue));

                if (balance >= betValue && !blockBets) {
                    button.className = 'bet-button active';
                    button.disabled = false;
                } else {
                    button.className = 'bet-button disabled';
                    button.disabled = true;
                }
            }
        }

        function clearArenaRoundUi(forceClearBall = false) {
            const ballCanvas = document.getElementById('arena-ball-svg');
            const svgCanvas = document.getElementById('arena-svg-canvas');
            const avatarsContainer = document.getElementById('arena-avatars-container');
            const statusText = document.getElementById('arena-status-text');
            const countdownTimer = document.getElementById('arena-countdown-timer');

            if (forceClearBall && ballCanvas) ballCanvas.innerHTML = '';
            if (svgCanvas) svgCanvas.innerHTML = '';
            if (avatarsContainer) avatarsContainer.innerHTML = '';

            if (statusText) {
                statusText.classList.remove('hidden');
                statusText.innerText = 'Ждем ставки...';
            }

            if (countdownTimer) countdownTimer.classList.add('hidden');

            arenaPlayers = [];
            localExpectedBetAmount = 0;

            safeSetText(elements.arenaPlayersTotal, '0');
            updatePlayersListUI();
            renderBetButtons();
        }

        function getMergedPlayers(serverPlayers) {
            const myIdString = String(userId);
            const merged = serverPlayers.map(player => ({ ...player }));
            const serverMe = merged.find(player => String(player.userId) === myIdString);
            const serverMyBet = serverMe ? parseFloat(serverMe.bet) || 0 : 0;

            if (serverMyBet >= localExpectedBetAmount) {
                localExpectedBetAmount = serverMyBet;
            }

            const difference = localExpectedBetAmount - serverMyBet;

            if (difference > 0.0001) {
                if (serverMe) {
                    serverMe.bet = parseFloat((serverMe.bet + difference).toFixed(3));
                } else {
                    merged.push({
                        userId,
                        username: currentUser.username || currentUser.first_name || 'Я',
                        avatar: currentUser.avatar_url || 'https://img.icons8.com/color/96/user.png',
                        bet: parseFloat(difference.toFixed(3)),
                        color: DEFAULT_COLOR_PALETTE[merged.length % DEFAULT_COLOR_PALETTE.length]
                    });
                }
            }

            return merged;
        }

        async function pollArenaLoop(forceInstant = false) {
            if (isBallAnimating && !forceInstant) {
                if (isPollingActive) setTimeout(() => pollArenaLoop(), 1000);
                return;
            }

            if (!isPollingActive && !forceInstant) return;

            const arenaSection = document.getElementById('arena-section');
            if (!arenaSection || arenaSection.classList.contains('hidden')) {
                stopArenaPolling();
                return;
            }

            try {
                const response = await fetchWithTimeout(`${API_BASE_URL}/api/arena/state`, {
                    headers: {
                        'X-Telegram-Init-Data': initDataHeader
                    },
                    timeout: 4000
                });

                if (response.status === 403) {
                    showBannedScreen();
                    return;
                }

                if (!response.ok) return;

                const state = await response.json();
                const roundNumber = Number(state.roundNumber || 1);
                const rawBets = Array.isArray(state.bets) ? state.bets : [];

                currentServerRoundNumber = roundNumber;
                arenaStatusStr = state.status || 'waiting';
                safeSetText(elements.arenaRoundNumber, String(roundNumber));

                const serverPlayers = rawBets.map((bet, index) => ({
                    userId: bet.userId || bet.user_id || bet.id || '',
                    username: bet.username || bet.user_name || bet.name || 'Игрок',
                    avatar: bet.avatar || bet.avatar_url || 'https://img.icons8.com/color/96/user.png',
                    bet: parseFloat(bet.amount || bet.bet || 0),
                    color: bet.color || DEFAULT_COLOR_PALETTE[index % DEFAULT_COLOR_PALETTE.length]
                }));

                if (roundNumber !== lastObservedRoundNumber) {
                    localExpectedBetAmount = 0;
                    lastObservedRoundNumber = roundNumber;
                    lastAnimatedRound = null;
                    lastShowedWinnerRound = null;
                    isBallAnimating = false;
                    clearInterval(countdownIntervalId);
                    countdownIntervalId = null;
                    clearArenaRoundUi(true);
                }

                if (arenaStatusStr === 'waiting' && serverPlayers.length === 0) {
                    localExpectedBetAmount = 0;
                }

                arenaPlayers = getMergedPlayers(serverPlayers);
                drawArenaSegments();
                updatePlayersListUI();

                const statusText = document.getElementById('arena-status-text');
                const countdownTimer = document.getElementById('arena-countdown-timer');

                if (arenaStatusStr === 'waiting') {
                    clearInterval(countdownIntervalId);
                    countdownIntervalId = null;

                    if (countdownTimer) countdownTimer.classList.add('hidden');
                    if (statusText) {
                        statusText.classList.remove('hidden');
                        statusText.innerText = 'Ждем ставки...';
                    }
                } else if (arenaStatusStr === 'countdown') {
                    if (statusText) statusText.classList.add('hidden');

                    const serverCountdown = parseInt(state.timeLeft, 10);
                    if (Number.isFinite(serverCountdown)) {
                        if (!countdownIntervalId || Math.abs(localCountdownValue - serverCountdown) > 1) {
                            localCountdownValue = serverCountdown;
                            if (countdownTimer) {
                                countdownTimer.classList.remove('hidden');
                                countdownTimer.innerText = String(localCountdownValue);
                            }
                        }

                        if (!countdownIntervalId) {
                            countdownIntervalId = setInterval(() => {
                                localCountdownValue -= 1;

                                if (localCountdownValue <= 0) {
                                    clearInterval(countdownIntervalId);
                                    countdownIntervalId = null;
                                    if (countdownTimer) countdownTimer.classList.add('hidden');
                                    setTimeout(() => pollArenaLoop(true), 50);
                                } else if (countdownTimer) {
                                    countdownTimer.classList.remove('hidden');
                                    countdownTimer.innerText = String(localCountdownValue);
                                }
                            }, 1000);
                        }
                    }
                } else if (arenaStatusStr === 'running') {
                    clearInterval(countdownIntervalId);
                    countdownIntervalId = null;

                    if (countdownTimer) countdownTimer.classList.add('hidden');
                    if (statusText) statusText.classList.add('hidden');

                    if (roundNumber !== lastAnimatedRound) {
                        lastAnimatedRound = roundNumber;
                        runSynchronizedBallPhysics(state);
                    }
                }

                renderBetButtons();
                updateBalanceUI();
            } catch (error) {
                console.error('Ошибка получения состояния арены:', error);
            } finally {
                if (isPollingActive && !isBallAnimating && !forceInstant) {
                    setTimeout(() => pollArenaLoop(), 1000);
                }
            }
        }

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

            // 1. Пауза на старте 0.5 секунды (30 кадров)
            for (let i = 0; i < 30; i++) {
                path.push({ x, y });
            }

            // 2. Полет с динамичными отскоками
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

        function runSynchronizedBallPhysics(state) {
            isBallAnimating = true;
            renderBetButtons();

            const ballCanvas = document.getElementById('arena-ball-svg');
            if (!ballCanvas) {
                isBallAnimating = false;
                return;
            }

            ballCanvas.innerHTML = '';

            const ball = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            ball.setAttribute('id', 'physics-ball');
            ball.setAttribute('r', '8');
            ball.setAttribute('fill', '#ffffff');
            ballCanvas.appendChild(ball);

            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('id', 'physics-ball-text');
            label.setAttribute('fill', '#ffffff');
            label.setAttribute('font-size', '12');
            label.setAttribute('font-weight', '900');
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('filter', 'drop-shadow(0 2px 3px rgba(0,0,0,0.9))');
            ballCanvas.appendChild(label);

            const startX = Number(state.startX) || 160;
            const startY = Number(state.startY) || 160;
            const speed = Number(state.initialSpeed) || 28;
            const angle = Number(state.angle) || 0;
            const winnerId = state.winnerId;
            const totalPool = parseFloat(state.totalPool) || 0;

            const path = simulateBallPhysics(startX, startY, speed, angle);
            const motionFrames = path.length - 90; // Кадр полной остановки шарика

            let frameIndex = 0;
            let winnerGlowApplied = false;

            const applyWinnerGlow = () => {
                if (winnerGlowApplied) return;
                winnerGlowApplied = true;

                const svg = document.getElementById('arena-svg-canvas');
                if (!svg) return;

                const selector = `[data-user-id="${String(winnerId).replace(/"/g, '')}"]`;
                const polygon = svg.querySelector(selector);
                if (!polygon) return;

                const winnerColor = polygon.getAttribute('fill') || '#00e676';
                polygon.style.setProperty('--glow-color', winnerColor);
                polygon.classList.add('winning-segment-glow');
                svg.appendChild(polygon);
            };

            const animateFrame = () => {
                if (!isBallAnimating) return;

                if (frameIndex < path.length) {
                    const pos = path[frameIndex];
                    ball.setAttribute('cx', pos.x.toFixed(2));
                    ball.setAttribute('cy', pos.y.toFixed(2));
                    label.setAttribute('x', pos.x.toFixed(2));
                    label.setAttribute('y', (pos.y < 40 ? pos.y + 24 : pos.y - 16).toFixed(2));

                    const owner = getPlayerAtCoords(pos.x, pos.y);
                    label.textContent = owner ? owner.username : '';

                    // Как только движение завершилось — зажигаем свечение сектора победителя
                    if (frameIndex >= motionFrames) {
                        applyWinnerGlow();
                    }

                    frameIndex++;
                    requestAnimationFrame(animateFrame);
                } else {
                    // Анимация и 1.5 секунды остановки завершены
                    if (lastShowedWinnerRound !== state.roundNumber) {
                        lastShowedWinnerRound = state.roundNumber;

                        if (String(winnerId) === String(userId)) {
                            showCustomModal({
                                icon: '🏆',
                                title: 'Победа!',
                                message: `🎉 Поздравляем! Вы получили весь банк: +${totalPool.toFixed(3)} GRAM!`,
                                buttons: [{ text: 'Забрать!', primary: true }]
                            });
                            triggerBalanceBadge(totalPool);
                        }
                    }

                    isBallAnimating = false;
                    clearArenaRoundUi(true); // Мгновенный сброс поля до "Ждем ставки..."
                    fetchUserData();
                }
            };

            requestAnimationFrame(animateFrame);
        }

        function startArenaPolling() {
            if (isPollingActive) return;

            lastAnimatedRound = null;
            lastShowedWinnerRound = null;
            isPollingActive = true;
            pollArenaLoop();
        }

        function stopArenaPolling() {
            isPollingActive = false;
            clearInterval(countdownIntervalId);
            countdownIntervalId = null;

            if (!isBallAnimating) {
                clearArenaRoundUi(true);
            }
        }

        const handleBetClick = async event => {
            const button = event.currentTarget;
            if (button.classList.contains('disabled') || localBetThrottle) return;

            const amount = parseFloat(button.getAttribute('data-bet'));
            if (!Number.isFinite(amount) || amount < 0.1) return;

            localBetThrottle = true;
            button.style.opacity = '0.5';

            setTimeout(() => {
                localBetThrottle = false;
                button.style.opacity = '1';
                renderBetButtons();
            }, 250);

            localExpectedBetAmount = parseFloat((localExpectedBetAmount + amount).toFixed(3));
            arenaPlayers = getMergedPlayers(arenaPlayers);
            drawArenaSegments();
            updatePlayersListUI();
            updateBalanceUI();
            triggerBalanceBadge(-amount);

            try {
                const response = await fetchWithTimeout(`${API_BASE_URL}/api/place_bet`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Telegram-Init-Data': initDataHeader
                    },
                    body: JSON.stringify({ amount }),
                    timeout: 10000
                });

                if (response.status === 403) {
                    showBannedScreen();
                    return;
                }

                const data = await response.json();

                if (response.ok && data.success) {
                    currentUser.balance = data.newBalance;
                    setTimeout(() => pollArenaLoop(true), 100);
                } else {
                    triggerBalanceBadge(amount);
                    localExpectedBetAmount = parseFloat(Math.max(0, localExpectedBetAmount - amount).toFixed(3));
                    fetchUserData();
                }
            } catch (error) {
                console.warn('Сетевая ошибка при отправке ставки:', error);
                setTimeout(() => pollArenaLoop(true), 300);
            }
        };

        ['bet-btn-1', 'bet-btn-2', 'bet-btn-3'].forEach(id => {
            const button = document.getElementById(id);
            if (button) button.addEventListener('click', handleBetClick);
        });

        const editBetsModal = document.getElementById('edit-bets-modal');
        const betEditTrigger = document.getElementById('bet-edit-trigger');
        const editBetsClose = document.getElementById('edit-bets-close-btn');
        const cancelBetsBtn = document.getElementById('cancel-bets-btn');
        const saveBetsBtn = document.getElementById('save-bets-btn');

        if (betEditTrigger && editBetsModal) {
            betEditTrigger.addEventListener('click', () => {
                document.getElementById('bet-input-1').value = customBets[0];
                document.getElementById('bet-input-2').value = customBets[1];
                document.getElementById('bet-input-3').value = customBets[2];
                editBetsModal.classList.remove('hidden');
            });
        }

        const closeEditBetsModal = () => {
            if (editBetsModal) editBetsModal.classList.add('hidden');
        };

        if (editBetsClose) editBetsClose.addEventListener('click', closeEditBetsModal);
        if (cancelBetsBtn) cancelBetsBtn.addEventListener('click', closeEditBetsModal);

        const enforceThreeDecimals = event => {
            let value = event.target.value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
            const parts = value.split('.');

            if (parts.length > 2) {
                value = parts[0] + '.' + parts.slice(1).join('');
            }

            if (value.includes('.')) {
                const decimalParts = value.split('.');
                value = decimalParts[0] + '.' + decimalParts[1].substring(0, 3);
            }

            event.target.value = value;
        };

        ['bet-input-1', 'bet-input-2', 'bet-input-3'].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.addEventListener('input', enforceThreeDecimals);
        });

        if (saveBetsBtn) {
            saveBetsBtn.addEventListener('click', () => {
                const values = [1, 2, 3].map(index => parseFloat(document.getElementById(`bet-input-${index}`).value));

                if (values.some(value => !Number.isFinite(value) || value < 0.1)) {
                    showNotification('Ставка не может быть меньше 0.1 GRAM!', '⚠️');
                    return;
                }

                customBets = values.map(value => parseFloat(value.toFixed(3)));
                localStorage.setItem(`custom_bets_${userId}`, JSON.stringify(customBets));
                closeEditBetsModal();
                showNotification('Кнопки настроены!', '✏️');
                renderBetButtons();
            });
        }

        if (elements.adminTgChatTrigger) {
            elements.adminTgChatTrigger.addEventListener('click', () => {
                tg.openTelegramLink('https://t.me/Sintopa');
            });
        }

        const arenaTrigger = document.getElementById('game-arena-trigger');
        if (arenaTrigger) {
            arenaTrigger.addEventListener('click', () => navigateTo('arena'));
        }

        const backFromArena = document.getElementById('back-to-home-from-arena');
        if (backFromArena) {
            backFromArena.addEventListener('click', () => navigateTo('home'));
        }

        const GIFT_POOL = [
            { id: 1, name: 'Статуя птицы серая', icon: '/Images/Items/rare_bird.jpg', price: '20 GRAM', rawPrice: 20.0, isGold: true, type: 'gift' },
            { id: 2, name: 'Тыква', icon: '/Images/Items/pumpkin.jpg', price: '8 GRAM', rawPrice: 8.0, isGold: true, type: 'gift' },
            { id: 3, name: 'Шляпа', icon: '/Images/Items/hat.jpg', price: '7 GRAM', rawPrice: 7.0, isGold: true, type: 'gift' },
            { id: 4, name: 'Собачка Snoop Dogg', icon: '/Images/Items/snoopdog.jpg', price: '4 GRAM', rawPrice: 4.0, isGold: false, type: 'gift' },
            { id: 5, name: 'Рюкзак черный', icon: '/Images/Items/pack.jpg', price: '3 GRAM', rawPrice: 3.0, isGold: false, type: 'gift' },
            { id: 6, name: 'Доширак лапша', icon: '/Images/Items/ramen.jpg', price: '2.7 GRAM', rawPrice: 2.7, isGold: false, type: 'gift' },
            { id: 7, name: 'Факел', icon: '/Images/Items/chill_flame.jpg', price: '2.5 GRAM', rawPrice: 2.5, isGold: false, type: 'gift' },
            { id: 8, name: 'Мороженое пломбир', icon: '/Images/Items/plombir.jpg', price: '2.5 GRAM', rawPrice: 2.5, isGold: false, type: 'gift' },
            { id: 9, name: 'Алмазик', icon: '/Images/Items/almaz.jpg', price: '0.9 GRAM', rawPrice: 0.9, isGold: false, type: 'gift' },
            { id: 10, name: 'Роза', icon: '/Images/Items/roza.jpg', price: '0.27 GRAM', rawPrice: 0.27, isGold: false, type: 'gift' },
            { id: 11, name: 'Пополнение 0.1 GRAM', icon: GRAMCOIN_ICON_URL, price: '0.1 GRAM', rawPrice: 0.1, isGold: false, type: 'balance' },
            { id: 14, name: 'Пополнение 0.03 GRAM', icon: GRAMCOIN_ICON_URL, price: '0.03 GRAM', rawPrice: 0.03, isGold: false, type: 'balance' }
        ];

        const NEWBIE_GIFT_POOL = [
            { id: 101, name: 'Розовый мишка', icon: '/Images/Items/bearpink.png', price: '29 GRAM', rawPrice: 29.0, isGold: true, type: 'gift' },
            { id: 102, name: 'Шлем Неко', icon: '/Images/Items/Neko_helmet.png', price: '26.8 GRAM', rawPrice: 26.8, isGold: true, type: 'gift' },
            { id: 103, name: 'Перстень печатка', icon: '/Images/Items/signet_ring.png', price: '25.7 GRAM', rawPrice: 25.7, isGold: true, type: 'gift' },
            { id: 104, name: 'Папаха', icon: '/Images/Items/papakha.png', price: '18.5 GRAM', rawPrice: 18.5, isGold: true, type: 'gift' },
            { id: 105, name: 'Амулет Купидона', icon: '/Images/Items/cupid_charm.png', price: '15 GRAM', rawPrice: 15.0, isGold: true, type: 'gift' },
            { id: 106, name: 'Любовное зелье', icon: '/Images/Items/love_potion.png', price: '10 GRAM', rawPrice: 10.0, isGold: false, type: 'gift' },
            { id: 107, name: 'UFC Бокс', icon: '/Images/Items/UFC_box.png', price: '9.9 GRAM', rawPrice: 9.9, isGold: false, type: 'gift' },
            { id: 108, name: 'Всевидящее око', icon: '/Images/Items/eye.png', price: '5 GRAM', rawPrice: 5.0, isGold: false, type: 'gift' },
            { id: 109, name: 'Холодный огонь', icon: '/Images/Items/chill_flame.jpg', price: '2.2 GRAM', rawPrice: 2.2, isGold: false, type: 'gift' },
            { id: 112, name: 'Мишка классический', icon: '/Images/Items/michka.jpg', price: '0.11 GRAM', rawPrice: 0.11, isGold: false, type: 'gift' },
            { id: 113, name: 'Пополнение 0.1 GRAM (Новичок)', icon: GRAMCOIN_ICON_URL, price: '0.1 GRAM', rawPrice: 0.1, isGold: false, type: 'balance' }
        ];

        const preloadList = [
            '/Images/Logo/logotip.png',
            GRAMCOIN_ICON_URL,
            '/Images/Cases/freebox.png',
            '/Images/Cases/keysnovichka.png'
        ];

        [...GIFT_POOL, ...NEWBIE_GIFT_POOL].forEach(item => {
            if (item.icon) preloadList.push(item.icon);
        });

        preloadImages(preloadList);

        function navigateTo(target) {
            const sections = [
                elements.homeSection,
                elements.caseSection,
                elements.inventorySection,
                elements.ratingSection,
                elements.balanceSection,
                elements.arenaSection
            ];

            sections.forEach(section => {
                if (section) section.classList.add('hidden');
            });

            if (elements.bottomNavigation) {
                elements.bottomNavigation.classList.remove('hidden');
            }

            if (target === 'home') {
                if (elements.homeSection) elements.homeSection.classList.remove('hidden');
                setActiveTab('home');
                stopArenaPolling();
            } else if (target === 'inventory') {
                if (elements.inventorySection) elements.inventorySection.classList.remove('hidden');
                setActiveTab('inventory');
                fetchInventory();
                stopArenaPolling();
            } else if (target === 'rating') {
                if (elements.ratingSection) elements.ratingSection.classList.remove('hidden');
                setActiveTab('rating');
                stopArenaPolling();
            } else if (target === 'balance') {
                if (elements.balanceSection) elements.balanceSection.classList.remove('hidden');
                elements.navTabs.forEach(tab => tab.classList.remove('active'));
                stopArenaPolling();
            } else if (target === 'case') {
                if (elements.caseSection) elements.caseSection.classList.remove('hidden');
                if (elements.bottomNavigation) elements.bottomNavigation.classList.add('hidden');
                initRouletteTrack();
                stopArenaPolling();
            } else if (target === 'arena') {
                if (elements.arenaSection) elements.arenaSection.classList.remove('hidden');
                if (elements.bottomNavigation) elements.bottomNavigation.classList.add('hidden');
                startArenaPolling();
            }
        }

        function setActiveTab(targetId) {
            elements.navTabs.forEach(tab => {
                tab.classList.toggle('active', tab.getAttribute('data-target') === targetId);
            });
        }

        elements.navTabs.forEach(tab => {
            tab.addEventListener('click', () => navigateTo(tab.getAttribute('data-target')));
        });

        const backFromBalance = document.getElementById('back-to-home-from-balance');
        if (backFromBalance) {
            backFromBalance.addEventListener('click', () => navigateTo('home'));
        }

        const backToHome = document.getElementById('back-to-home-button');
        if (backToHome) {
            backToHome.addEventListener('click', () => navigateTo('home'));
        }

        if (elements.dailyCaseBanner) {
            elements.dailyCaseBanner.addEventListener('click', () => {
                isNewbieCaseMode = false;
                if (elements.rewardsSectionContainer) elements.rewardsSectionContainer.classList.remove('hidden');
                safeSetText(elements.casePageMainTitle, 'Ежедневный кейс');
                safeSetText(elements.rewardsGridTitle, '🏆 Содержимое кейса');
                safeSetText(elements.spinBtn, 'Запустить');
                renderRewardsGrid();
                updateDailyCaseTimer();
                navigateTo('case');
            });
        }

        if (elements.newbieCaseBanner) {
            elements.newbieCaseBanner.addEventListener('click', () => {
                isNewbieCaseMode = true;
                if (elements.rewardsSectionContainer) elements.rewardsSectionContainer.classList.remove('hidden');
                safeSetText(elements.casePageMainTitle, 'Кейс новичка');
                safeSetText(elements.rewardsGridTitle, '🏆 Содержимое кейса');
                safeSetText(elements.spinBtn, 'Открыть (0.1 GRAM)');
                renderRewardsGrid();
                updateDailyCaseTimer();
                navigateTo('case');
            });
        }

        function renderRewardsGrid() {
            if (!elements.rewardsGrid) return;

            elements.rewardsGrid.innerHTML = '';
            const pool = isNewbieCaseMode ? NEWBIE_GIFT_POOL : GIFT_POOL;

            pool.forEach(gift => {
                const card = document.createElement('div');
                card.className = `reward-card ${gift.isGold ? 'gold-tier' : ''}`;
                card.innerHTML = `
                    <div class="reward-price-top">${gift.price}</div>
                    <img src="${gift.icon}" alt="${formatItemName(gift.name)}" onerror="this.src='https://img.icons8.com/color/96/gift.png'">
                    <div class="reward-name">${formatItemName(gift.name)}</div>
                    ${gift.type === 'gift' ? '<div class="reward-random-badge">random</div>' : ''}
                `;
                elements.rewardsGrid.appendChild(card);
            });
        }

        function initRouletteTrack() {
            if (!elements.rouletteTrack) return;

            elements.rouletteTrack.style.transition = 'none';
            elements.rouletteTrack.style.transform = 'translate3d(0, 0, 0)';
            void elements.rouletteTrack.offsetWidth;
            elements.rouletteTrack.innerHTML = '';

            const pool = isNewbieCaseMode ? NEWBIE_GIFT_POOL : GIFT_POOL;

            for (let index = 0; index < 60; index++) {
                const item = pool[Math.floor(Math.random() * pool.length)];
                const itemElement = document.createElement('div');
                itemElement.className = 'roulette-item';
                itemElement.innerHTML = `
                    <img src="${item.icon}" onerror="this.src='https://img.icons8.com/color/96/gift.png'">
                    <span>${item.price}</span>
                `;
                elements.rouletteTrack.appendChild(itemElement);
            }
        }

        function spinRoulette(winningItem, onComplete) {
            if (!elements.rouletteTrack || !winningItem) return;

            const itemWidth = 96;
            const gap = 8;
            const itemFullWidth = itemWidth + gap;
            const targetIndex = 45;
            const targetItem = elements.rouletteTrack.children[targetIndex];

            if (targetItem) {
                targetItem.innerHTML = `
                    <img src="${winningItem.icon}" onerror="this.src='https://img.icons8.com/color/96/gift.png'">
                    <span>${winningItem.price}</span>
                `;
            }

            const containerWidth = elements.rouletteTrack.parentElement.offsetWidth;
            const centerOffset = containerWidth / 2 - itemWidth / 2;
            const translate = targetIndex * itemFullWidth - centerOffset;

            elements.rouletteTrack.style.transition = 'transform 5.5s cubic-bezier(0.12, 0.82, 0.12, 1)';
            elements.rouletteTrack.style.transform = `translate3d(-${translate}px, 0, 0)`;

            setTimeout(onComplete, 5600);
        }

        function processWinning(winningGift, newBalance = null) {
            if (!winningGift) return;

            if (newBalance !== null) {
                currentUser.balance = newBalance;
                updateBalanceUI();
            }

            const isBalance = winningGift.type === 'balance' || winningGift.name.toLowerCase().includes('пополнение');

            if (isBalance) {
                showCustomModal({
                    icon: '💰',
                    title: 'Баланс пополнен!',
                    message: `🎉 Вы выиграли пополнение счета на +${winningGift.price}!`,
                    buttons: [{ text: 'Отлично!', primary: true }]
                });
                triggerBalanceBadge(winningGift.rawPrice);
                fetchUserData();
            } else {
                showCustomModal({
                    icon: `<img src="${winningGift.icon}" style="width:70px;height:70px;object-fit:contain;" onerror="this.src='https://img.icons8.com/color/96/gift.png'">`,
                    title: 'Вы выиграли подарок!',
                    message: `🎁 Ваша награда: "${formatItemName(winningGift.name)}" сохранена в инвентарь!`,
                    buttons: [
                        {
                            text: `Продать за ${winningGift.price}`,
                            primary: true,
                            onClick: async () => {
                                try {
                                    const response = await fetchWithTimeout(`${API_BASE_URL}/api/sell_gift`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'X-Telegram-Init-Data': initDataHeader
                                        },
                                        body: JSON.stringify({
                                            itemId: winningGift.id,
                                            price: winningGift.rawPrice
                                        }),
                                        timeout: 3000
                                    });

                                    if (response.status === 403) {
                                        showBannedScreen();
                                        return;
                                    }

                                    if (response.ok) {
                                        const data = await response.json();
                                        currentUser.balance = data.newBalance;
                                        triggerBalanceBadge(winningGift.rawPrice);
                                        fetchUserData();
                                    }
                                } catch (error) {}
                            }
                        },
                        {
                            text: 'В инвентарь',
                            primary: false,
                            onClick: () => {
                                showNotification('📦 Сохранено в инвентарь!', '🎒');
                                fetchUserData();
                            }
                        }
                    ]
                });
            }
        }

        if (elements.spinBtn) {
            elements.spinBtn.addEventListener('click', async () => {
                const spinCost = 0.1;

                if (isNewbieCaseMode && parseFloat(currentUser.balance || 0) < spinCost) {
                    showNotification('Недостаточно баланса! (0.1 GRAM)', '⚠️');
                    return;
                }

                elements.spinBtn.disabled = true;

                if (isNewbieCaseMode) {
                    triggerBalanceBadge(-spinCost);
                    updateBalanceUI(Math.max(0, parseFloat(currentUser.balance || 0) - spinCost));
                }

                initRouletteTrack();

                setTimeout(async () => {
                    try {
                        const endpoint = isNewbieCaseMode ? '/api/open_newbie_case' : '/api/open_daily_case';
                        const response = await fetchWithTimeout(`${API_BASE_URL}${endpoint}`, {
                            method: 'POST',
                            headers: {
                                'X-Telegram-Init-Data': initDataHeader
                            },
                            timeout: 4500
                        });

                        if (response.status === 403) {
                            showBannedScreen();
                            return;
                        }

                        const data = await response.json();

                        if (response.ok) {
                            const pool = isNewbieCaseMode ? NEWBIE_GIFT_POOL : GIFT_POOL;
                            const winningGift = pool.find(item => item.id === data.wonItem.id) || pool.find(item => item.name.toLowerCase() === String(data.wonItem.name).toLowerCase());
                            spinRoulette(winningGift, () => processWinning(winningGift, data.newBalance));
                        } else {
                            if (isNewbieCaseMode) triggerBalanceBadge(spinCost);
                            fetchUserData();
                            showNotification(data.error || 'Ошибка.', '⚠️');
                            elements.spinBtn.disabled = false;
                        }
                    } catch (error) {
                        if (isNewbieCaseMode) triggerBalanceBadge(spinCost);
                        fetchUserData();
                        elements.spinBtn.disabled = false;
                        showNotification('Ошибка сети при открытии.', '⚠️');
                    }
                }, 50);
            });
        }

        const balancePill = document.getElementById('balance-pill');
        if (balancePill) {
            balancePill.addEventListener('click', () => navigateTo('balance'));
        }

        // ИНВЕНТАРЬ
        async function fetchInventory() {
            if (!elements.inventoryGrid) return;

            try {
                const response = await fetchWithTimeout(`${API_BASE_URL}/api/inventory`, {
                    headers: {
                        'X-Telegram-Init-Data': initDataHeader
                    },
                    timeout: 3000
                });

                if (response.status === 403) {
                    showBannedScreen();
                    return;
                }

                if (!response.ok) throw new Error('Inventory request failed');

                const items = await response.json();
                elements.inventoryGrid.innerHTML = '';

                if (!Array.isArray(items) || items.length === 0) {
                    elements.inventoryGrid.innerHTML = '<div class="empty-inventory">🎒 Ваш инвентарь пуст.<br>Открывайте кейсы!</div>';
                    return;
                }

                items.forEach(item => {
                    const matchedItem = GIFT_POOL.find(gift => parseInt(gift.id) === parseInt(item.item_id)) || NEWBIE_GIFT_POOL.find(gift => parseInt(gift.id) === parseInt(item.item_id));
                    const imageSrc = matchedItem ? matchedItem.icon : item.image_url;
                    const card = document.createElement('div');

                    card.className = 'reward-card';
                    card.innerHTML = `
                        <div class="reward-price-top">${parseFloat(item.value || 0).toFixed(2)} GRAM</div>
                        <img src="${imageSrc}" onerror="this.src='https://img.icons8.com/color/96/gift.png'">
                        <div class="reward-name">${formatItemName(item.name)}</div>
                        <div class="inv-actions">
                            <button class="inv-btn withdraw-btn">Вывести</button>
                            <button class="inv-btn sell-btn">Продать</button>
                            <button class="inv-btn send-btn">Отправить</button>
                        </div>
                    `;

                    const withdrawButton = card.querySelector('.withdraw-btn');
                    const sellButton = card.querySelector('.sell-btn');
                    const sendButton = card.querySelector('.send-btn');

                    if (withdrawButton) {
                        withdrawButton.addEventListener('click', () => {
                            showCustomModal({
                                icon: `<img src="${imageSrc}" style="width:70px;height:70px;object-fit:contain;" onerror="this.src='https://img.icons8.com/color/96/gift.png'">`,
                                title: 'Вывод подарка',
                                message: `Отправить "${formatItemName(item.name)}" вам в Telegram?`,
                                buttons: [
                                    {
                                        text: 'Подтвердить вывод',
                                        primary: true,
                                        onClick: async () => {
                                            const response = await fetchWithTimeout(`${API_BASE_URL}/api/withdraw_gift`, {
                                                method: 'POST',
                                                headers: {
                                                    'Content-Type': 'application/json',
                                                    'X-Telegram-Init-Data': initDataHeader
                                                },
                                                body: JSON.stringify({ itemId: item.item_id }),
                                                timeout: 3000
                                            });

                                            if (response.status === 403) {
                                                showBannedScreen();
                                                return;
                                            }

                                            if (response.ok) {
                                                showNotification('Подарок в очереди на вывод!', '📥');
                                                fetchInventory();
                                            } else {
                                                const data = await response.json();
                                                showNotification(data.error || 'Заявка отклонена.', '⚠️');
                                            }
                                        }
                                    },
                                    {
                                        text: 'Отмена',
                                        primary: false
                                    }
                                ]
                            });
                        });
                    }

                    if (sellButton) {
                        sellButton.addEventListener('click', () => {
                            showCustomModal({
                                icon: '💰',
                                title: 'Продажа подарка',
                                message: `Продать подарок "${formatItemName(item.name)}" за ${item.value} GRAM?`,
                                buttons: [
                                    {
                                        text: 'Продать за GRAM',
                                        primary: true,
                                        onClick: async () => {
                                            const response = await fetchWithTimeout(`${API_BASE_URL}/api/sell_gift`, {
                                                method: 'POST',
                                                headers: {
                                                    'Content-Type': 'application/json',
                                                    'X-Telegram-Init-Data': initDataHeader
                                                },
                                                body: JSON.stringify({
                                                    itemId: item.item_id,
                                                    price: item.value
                                                }),
                                                timeout: 3000
                                            });

                                            if (response.status === 403) {
                                                showBannedScreen();
                                                return;
                                            }

                                            if (response.ok) {
                                                const data = await response.json();
                                                currentUser.balance = data.newBalance;
                                                triggerBalanceBadge(parseFloat(item.value));
                                                fetchUserData();
                                                fetchInventory();
                                            }
                                        }
                                    },
                                    {
                                        text: 'Отмена',
                                        primary: false
                                    }
                                ]
                            });
                        });
                    }

                    if (sendButton) {
                        sendButton.addEventListener('click', () => openSendGiftModal(items));
                    }

                    elements.inventoryGrid.appendChild(card);
                });
            } catch (error) {
                console.error('Inventory fetch error:', error);
            }
        }

        function openSendGiftModal(userInventory) {
            const overlay = document.getElementById('custom-modal');
            const modalIcon = document.getElementById('modal-icon');
            const modalTitle = document.getElementById('modal-title');
            const modalMessage = document.getElementById('modal-message');
            const actionsContainer = document.getElementById('modal-actions');
            const closeButton = document.getElementById('modal-close-btn');

            if (!overlay) return;

            if (modalIcon) modalIcon.innerHTML = '📤';
            if (modalTitle) modalTitle.innerText = 'Отправить подарок другу';

            const options = userInventory.map(item => `<option value="${item.item_id}">${formatItemName(item.name)} (${parseFloat(item.value || 0).toFixed(3)} GRAM)</option>`).join('');

            if (modalMessage) {
                modalMessage.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:12px; width:100%; text-align:left;">
                        <div>
                            <label style="font-size:12px; font-weight:700; color:#a5a1b8; display:block; margin-bottom:4px;">Telegram Юзернейм получателя</label>
                            <input type="text" id="send-gift-username" placeholder="@friend" style="width:100%; background:#0b0914; border:1px solid #241c44; border-radius:12px; padding:12px; color:#fff; font-size:14px; box-sizing:border-box;">
                        </div>
                        <div>
                            <label style="font-size:12px; font-weight:700; color:#a5a1b8; display:block; margin-bottom:4px;">Выберите подарок</label>
                            <select id="send-gift-item-select" style="width:100%; background:#0b0914; border:1px solid #241c44; border-radius:12px; padding:12px; color:#fff; font-size:14px; box-sizing:border-box; appearance:none;">${options}</select>
                        </div>
                    </div>
                `;
            }

            if (actionsContainer) {
                actionsContainer.innerHTML = `
                    <button id="send-gift-confirm-btn" class="modal-btn modal-btn-primary">Отправить 🎁</button>
                    <button id="send-gift-cancel-btn" class="modal-btn modal-btn-secondary">Отмена</button>
                `;
            }

            const closeModal = () => overlay.classList.add('hidden');
            if (closeButton) closeButton.onclick = closeModal;

            const cancelButton = document.getElementById('send-gift-cancel-btn');
            if (cancelButton) cancelButton.onclick = closeModal;

            const confirmButton = document.getElementById('send-gift-confirm-btn');
            if (confirmButton) {
                confirmButton.onclick = async () => {
                    const usernameInput = document.getElementById('send-gift-username');
                    const itemSelect = document.getElementById('send-gift-item-select');
                    const targetUsername = usernameInput ? usernameInput.value.trim() : '';
                    const itemId = itemSelect ? itemSelect.value : '';

                    if (!targetUsername) {
                        showNotification('Введите юзернейм получателя', '⚠️');
                        return;
                    }

                    if (!itemId) {
                        showNotification('Выберите подарок', '⚠️');
                        return;
                    }

                    confirmButton.disabled = true;
                    confirmButton.innerText = 'Отправка...';

                    try {
                        const response = await fetchWithTimeout(`${API_BASE_URL}/api/send_gift`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Telegram-Init-Data': initDataHeader
                            },
                            body: JSON.stringify({
                                targetUsername,
                                itemId: parseInt(itemId)
                            }),
                            timeout: 8000
                        });

                        if (response.status === 403) {
                            showBannedScreen();
                            return;
                        }

                        const data = await response.json();

                        if (response.ok) {
                            showNotification(data.message || 'Подарок успешно отправлен!', '🎉');
                            closeModal();
                            fetchInventory();
                            fetchUserData();
                        } else {
                            showNotification(data.error || 'Ошибка при отправке', '❌');
                        }
                    } catch (error) {
                        showNotification('Ошибка сети. Попробуйте позже.', '⚠️');
                    } finally {
                        confirmButton.disabled = false;
                        confirmButton.innerText = 'Отправить 🎁';
                    }
                };
            }

            overlay.classList.remove('hidden');
        }

        function updateBalanceUI(forcedValue = null) {
            const rawBalance = forcedValue !== null ? forcedValue : currentUser.balance;
            const balance = parseFloat(rawBalance) || 0;
            const myIdString = String(userId);
            const myPlayer = arenaPlayers.find(player => String(player.userId) === myIdString);
            const confirmedBet = myPlayer ? parseFloat(myPlayer.bet) || 0 : 0;
            const unconfirmedBet = Math.max(0, localExpectedBetAmount - confirmedBet);
            const visibleBalance = Math.max(0, balance - unconfirmedBet);
            const formatted = visibleBalance.toFixed(3);

            safeSetText(elements.balanceDisplayPill, formatted);
            safeSetText(elements.largeBalanceDisplay, formatted);
        }

        async function fetchUserData() {
            try {
                const response = await fetchWithTimeout(`${API_BASE_URL}/api/user`, {
                    headers: {
                        'X-Telegram-Init-Data': initDataHeader
                    },
                    timeout: 4000
                });

                if (response.status === 403) {
                    showBannedScreen();
                    return;
                }

                if (!response.ok) throw new Error('User request failed');
                currentUser = await response.json();

                try {
                    localStorage.setItem(`user_cache_${userId}`, JSON.stringify(currentUser));
                } catch (error) {}
            } catch (error) {
                console.warn('Не удалось обновить данные пользователя:', error);
            }

            if (!currentUser) currentUser = {};

            updateBalanceUI();

            const avatar = document.getElementById('user-avatar');
            if (avatar) {
                avatar.src = currentUser.avatar_url || 'https://img.icons8.com/color/96/user.png';
                avatar.onerror = () => {
                    avatar.src = 'https://img.icons8.com/color/96/user.png';
                };
            }

            const username = currentUser.username || currentUser.first_name || 'Пользователь';
            safeSetText(document.getElementById('user-username'), formatUsername(username));
            updateDailyCaseTimer();
            renderBetButtons();
        }

        function updateDailyCaseTimer() {
            clearInterval(dailyCaseTimerInterval);

            const timerContainer = document.getElementById('timer-container');
            const timerValue = document.getElementById('daily-case-timer');

            if (isNewbieCaseMode || !currentUser.last_daily_case_open) {
                if (elements.spinBtn) {
                    elements.spinBtn.classList.remove('hidden');
                    elements.spinBtn.disabled = false;
                }
                if (timerContainer) timerContainer.classList.add('hidden');
                return;
            }

            const lastOpen = new Date(currentUser.last_daily_case_open);
            const nextOpen = new Date(lastOpen.getTime() + 24 * 60 * 60 * 1000);

            const update = () => {
                const difference = nextOpen.getTime() - Date.now();

                if (difference <= 0) {
                    clearInterval(dailyCaseTimerInterval);
                    if (elements.spinBtn) {
                        elements.spinBtn.classList.remove('hidden');
                        elements.spinBtn.disabled = false;
                    }
                    if (timerContainer) timerContainer.classList.add('hidden');
                    return;
                }

                if (elements.spinBtn) {
                    elements.spinBtn.classList.add('hidden');
                    elements.spinBtn.disabled = true;
                }

                if (timerContainer) timerContainer.classList.remove('hidden');

                const hours = Math.floor(difference / (1000 * 60 * 60));
                const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((difference % (1000 * 60)) / 1000);

                if (timerValue) {
                    timerValue.innerText = `${hours}ч ${minutes}м ${seconds}с`;
                }
            };

            update();
            dailyCaseTimerInterval = setInterval(update, 1000);
        }

        loadSavedBets();
        loadCachedUserData();
        renderRewardsGrid();
        fetchUserData();
        navigateTo('home');
    } catch (error) {
        console.error('Global init error:', error);
    }
});
