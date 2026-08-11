/**
 * WebChess — обучающие веб-шахматы.
 * Пользователь ходит за обе стороны; Stockfish 16 NNUE (максимальная сила)
 * всегда анализирует позицию, рекомендует лучший ход и объясняет теорию.
 */
"use strict";

// ---------------- Константы ----------------
// Stockfish 18 (полная сборка, обе NNUE-сети вшиты в wasm — EvalFile не нужен).
// Запасной вариант для слабых машин: lib/stockfish-18-lite-single.js (7 МБ).
const ENGINE_PATH = "lib/stockfish-18-lite-single.js";
const HASH_MB = 128;
const GO_COMMAND = "go depth 24 movetime 2500"; // стоп по первому из лимитов
const MATE_SCORE_CP = 100000;

// Уровни силы бота для обычной игры. elo=null — без ограничения (полный Stockfish).
// UCI_Elo у Stockfish ограничен снизу 1320 — «новичок» дожимается мелкой глубиной.
const DIFFICULTY_LEVELS = {
    novice:     { name: "Новичок (≈1000)",  elo: 1320, go: "go depth 4 movetime 300",  approx: 1000 },
    club:       { name: "Средний (≈1500)",  elo: 1500, go: "go depth 10 movetime 700", approx: 1500 },
    strong:     { name: "Максимум (≈2300)", elo: 2300, go: "go depth 16 movetime 1500", approx: 2300 },
    impossible: { name: "Невозможный (полный Stockfish)", elo: null, go: GO_COMMAND, approx: 3200 },
};

// ОБА цвета — залитые глифы: контурные «белые» (♔♙…) на iOS/Android рендерятся
// тонкими прозрачными скелетами разного размера. Цвет задаётся CSS-классами.
// ︎ (VARIATION SELECTOR-15) обязателен: без него iOS рисует ♟ как ЦВЕТНОЙ
// ЭМОДЗИ (всегда чёрный), игнорируя CSS-цвет.
const UNICODE_PIECES = {
    w: { k: "♚︎", q: "♛︎", r: "♜︎", b: "♝︎", n: "♞︎", p: "♟︎" },
    b: { k: "♚︎", q: "♛︎", r: "♜︎", b: "♝︎", n: "♞︎", p: "♟︎" },
};
const FILES = "abcdefgh";
const SAN_RU = { K: "Кр", Q: "Ф", R: "Л", B: "С", N: "К" };
// Ценность фигур для сортировки съеденных и подсчёта материала (король не съедается).
const PIECE_VALUES = { q: 9, r: 5, b: 3, n: 3, p: 1 };
// Русские названия фигур: [1 штука, 2–4 штуки, 5+ штук].
const PIECE_RU_FORMS = {
    p: ["пешка", "пешки", "пешек"],
    n: ["конь", "коня", "коней"],
    b: ["слон", "слона", "слонов"],
    r: ["ладья", "ладьи", "ладей"],
    q: ["ферзь", "ферзя", "ферзей"],
};
const EQUAL_MATERIAL_TEXT = "фигуры равны";
// ---------------- Рейтинг игрока ----------------
// Честные проценты по ТЗ: победа +2.5% от эло соперника/задачи, поражение −5%,
// решение задачи +2.5%, неверная попытка −1.5%. Минимум рейтинга — 100.
const RATING_KEY = "webchess_rating";
const RATING_START = 800;
const RATING_PCT = { win: 0.025, lose: 0.05, puzzleSolve: 0.025, puzzleFail: 0.015 };
const RATING_MIN = 100;

function getRating() {
    const v = parseInt(localStorage.getItem(RATING_KEY) || "", 10);
    return Number.isFinite(v) ? v : RATING_START;
}

function setRating(v) {
    localStorage.setItem(RATING_KEY, String(Math.max(RATING_MIN, Math.round(v))));
    renderRatingBadge();
}

/** Изменение рейтинга: pct от опорного эло (бота/задачи), знак = направление. */
function ratingApply(refElo, pct, sign) {
    const delta = Math.max(1, Math.round(refElo * pct)) * sign;
    setRating(getRating() + delta);
    return delta;
}

function renderRatingBadge() {
    const el = $("rating-badge");
    if (el) el.innerHTML = `🏅 Твой рейтинг: <b>${getRating()}</b>`;
}

// ---------------- Облачная синхронизация (GitHub Gist, опционально) ----------------
// Личный кабинет без сервера: прогресс хранится в ПРИВАТНОМ gist пользователя.
// Нужен персональный токен GitHub со скоупом gist (вводится один раз).
const SYNC_TOKEN_KEY = "webchess_gh_token";
const SYNC_GIST_KEY = "webchess_gh_gist";
const SYNC_GIST_DESC = "webchess-progress";
const SYNC_FILE = "webchess.json";

function cloudToken() {
    let t = localStorage.getItem(SYNC_TOKEN_KEY);
    if (!t) {
        t = prompt("Вставь GitHub-токен со скоупом «gist».\nСоздать: github.com/settings/tokens → Generate new token (classic) → отметь только gist.");
        if (t) localStorage.setItem(SYNC_TOKEN_KEY, t.trim());
    }
    return t ? t.trim() : null;
}

async function cloudApi(path, method, body, token) {
    const resp = await fetch("https://api.github.com" + path, {
        method: method || "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401) { localStorage.removeItem(SYNC_TOKEN_KEY); throw new Error("токен не подошёл (удалён — введи заново)"); }
    if (!resp.ok) throw new Error("GitHub API: " + resp.status);
    return resp.json();
}

async function cloudFindGist(token) {
    const cached = localStorage.getItem(SYNC_GIST_KEY);
    if (cached) return cached;
    const gists = await cloudApi("/gists?per_page=100", "GET", null, token);
    const g = gists.find((x) => x.description === SYNC_GIST_DESC);
    if (g) { localStorage.setItem(SYNC_GIST_KEY, g.id); return g.id; }
    return null;
}

async function cloudSave() {
    const token = cloudToken();
    if (!token) return;
    const payload = {
        elo: getRating(),
        puzzlesSolved: puzzlesSolvedIds(),
        theoryPos: theoryLoadPos(),
        ts: new Date().toISOString(),
    };
    try {
        const files = {}; files[SYNC_FILE] = { content: JSON.stringify(payload, null, 2) };
        const gistId = await cloudFindGist(token);
        if (gistId) await cloudApi("/gists/" + gistId, "PATCH", { files }, token);
        else {
            const g = await cloudApi("/gists", "POST", { description: SYNC_GIST_DESC, public: false, files }, token);
            localStorage.setItem(SYNC_GIST_KEY, g.id);
        }
        alert(`Сохранено в облако: рейтинг ${payload.elo}, задач решено ${payload.puzzlesSolved.length}.`);
    } catch (e) { alert("Не удалось сохранить: " + e.message); }
}

async function cloudLoad() {
    const token = cloudToken();
    if (!token) return;
    try {
        const gistId = await cloudFindGist(token);
        if (!gistId) { alert("В облаке пока нет сохранения — сначала «Сохранить прогресс»."); return; }
        const g = await cloudApi("/gists/" + gistId, "GET", null, token);
        const data = JSON.parse(g.files[SYNC_FILE].content);
        if (Number.isFinite(data.elo)) setRating(data.elo);
        if (Array.isArray(data.puzzlesSolved)) localStorage.setItem(PUZZLE_STORAGE_KEY, JSON.stringify(data.puzzlesSolved));
        if (data.theoryPos) theorySavePos(data.theoryPos.s || 0, data.theoryPos.p || 0);
        renderRatingBadge();
        alert(`Загружено: рейтинг ${data.elo}, задач решено ${(data.puzzlesSolved || []).length} (сохранение от ${data.ts ? data.ts.slice(0, 10) : "?"}).`);
    } catch (e) { alert("Не удалось загрузить: " + e.message); }
}

const MODE_BADGES = {
    training: "Режим: тренировка",
    casual: "Режим: обычная игра",
    tutor: "Режим: самоучитель дебютов",
    drill: "Режим: тренировка дебютов",
    learn: "Режим: учим дебют",
    puzzles: "Режим: задачи",
    theory: "Режим: теория",
};
// Подсказка на 2-м шаге настройки — своя для каждого режима.
const MODE_HINTS = {
    training: "Вы ходите за обе стороны. Не хотите думать за противника — жмите «Ход Stockfish».",
    casual: "Честная партия против бота: подсказок нет, бот ходит сам.",
    openings: "Выберите дебют и свой цвет — на следующем шаге решите, как заниматься.",
};
const DRILL_OPP_MOVE_DELAY_MS = 650;   // пауза перед авто-ходом тренажёра
const DRILL_MODAL_DELAY_MS = 700;      // пауза между последним ходом линии и модалкой
const DRILL_SF_MAX_PLIES = 40;         // потолок доигрывания партии движком (полуходы)

// ---------------- Состояние ----------------
const state = {
    game: new Chess(),
    playerColor: "w",     // цвет пользователя (он всегда снизу)
    mode: "training",     // training | casual | tutor
    selected: null,       // выбранная клетка
    lastMove: null,       // verbose-объект последнего хода
    pendingPromotion: null,
    gameOver: false,
    // Анализ текущей позиции:
    analysisId: 0,
    analysis: null,       // {id, fen, turn, bestUci, bestSan, cp, mate, depth, pvSan, done}
    lastMoveReview: null, // разбор последнего хода
    engineMoveRequested: false,
    drill: null,          // состояние тренировки дебютов {drill, phase, feedback, wrongTries, replayPly}
    drillForceId: null,   // ?drill=<id> — детерминированный выбор тренировки (тесты)
    difficulty: "club",   // уровень бота в обычной игре (ключ DIFFICULTY_LEVELS)
    puzzle: null,         // состояние задачи {p, idx, solved, fails, lastDelta}
    theory: null,         // позиция в учебнике {s, p}
};

// ---------------- Движок ----------------
// ВАЖНО: обёртка Stockfish 18 виснет, если послать «stop» во время поиска и сразу
// новый «go» (проверено в tests). Поэтому поиск НИКОГДА не прерываем: новый запрос
// ждёт в queuedFen и уходит после естественного завершения текущего (≤2.5 с).
const engine = {
    worker: null,
    ready: false,
    searching: false,   // идёт ли поиск прямо сейчас
    currentFen: null,   // позиция, которую движок реально ищет
    queuedFen: null,    // отложенный запрос, пришедший во время поиска

    init() {
        this.worker = new Worker(ENGINE_PATH);
        this.worker.onmessage = (e) => this.onMessage(String(e.data));
        this.send("uci");
    },

    send(cmd) { this.worker.postMessage(cmd); },

    onMessage(line) {
        if (line === "uciok") {
            this.send(`setoption name Hash value ${HASH_MB}`);
            this.send("isready");
            return;
        }
        if (line === "readyok" && !this.ready) {
            this.ready = true;
            setEngineStatus("Движок готов");
            requestAnalysis();
            return;
        }
        if (line.startsWith("info ")) { handleInfo(line); return; }
        if (line.startsWith("bestmove ")) { handleBestmove(line); return; }
    },

    goCommand: GO_COMMAND, // команда поиска: в обычной игре зависит от сложности

    analyze(fen) {
        if (this.searching) { this.queuedFen = fen; return; }
        this.searching = true;
        this.currentFen = fen;
        this.send("position fen " + fen);
        this.send(this.goCommand);
    },

    /** Настроить силу под режим: level=null — полная сила (анализ/подсказки). */
    configureStrength(levelKey) {
        const level = levelKey ? DIFFICULTY_LEVELS[levelKey] : null;
        if (level && level.elo) {
            this.send("setoption name UCI_LimitStrength value true");
            this.send(`setoption name UCI_Elo value ${level.elo}`);
        } else {
            this.send("setoption name UCI_LimitStrength value false");
        }
        this.goCommand = level ? level.go : GO_COMMAND;
    },
};

// ---------------- Утилиты ----------------
function $(id) { return document.getElementById(id); }

function sanToRu(san) {
    return san.replace(/[KQRBN]/g, (ch) => SAN_RU[ch]);
}

function uciToVerbose(fen, uci) {
    const tmp = new Chess(fen);
    return tmp.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
}

/** PV (uci-ходы) → массив SAN от позиции fen. */
function pvToSan(fen, pvUci, maxPlies) {
    const tmp = new Chess(fen);
    const sans = [];
    for (const uci of pvUci.slice(0, maxPlies)) {
        const mv = tmp.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
        if (!mv) break;
        sans.push(mv.san);
    }
    return sans;
}

/** Оценка с точки зрения БЕЛЫХ в сантипешках (mate → огромное число). */
function whiteCp(analysis) {
    if (!analysis) return null;
    let cp = null;
    if (analysis.mate !== null && analysis.mate !== undefined) {
        cp = analysis.mate > 0 ? MATE_SCORE_CP - Math.abs(analysis.mate) : -MATE_SCORE_CP + Math.abs(analysis.mate);
    } else if (analysis.cp !== null && analysis.cp !== undefined) {
        cp = analysis.cp;
    } else {
        return null;
    }
    return analysis.turn === "w" ? cp : -cp;
}

function formatEval(analysis) {
    if (!analysis) return "…";
    if (analysis.mate !== null && analysis.mate !== undefined) {
        const side = (analysis.mate > 0) === (analysis.turn === "w") ? "белых" : "чёрных";
        return `мат в ${Math.abs(analysis.mate)} (у ${side})`;
    }
    if (analysis.cp === null || analysis.cp === undefined) return "…";
    const w = whiteCp(analysis);
    const sign = w > 0 ? "+" : "";
    return `${sign}${(w / 100).toFixed(2)}`;
}

// ---------------- Анализ ----------------
function requestAnalysis() {
    // В тренировке дебютов движок молчит (рекомендация раскрыла бы загаданный ход) —
    // КРОМЕ просмотра исторических партий: там оценка показывает, где ошибались мастера.
    if (!engine.ready || state.gameOver) return;
    if (state.mode === "puzzles" || state.mode === "theory") return; // движок не нужен
    if (isDrillMode() && (!state.drill || state.drill.phase !== "replay")) return;
    state.analysisId++;
    const fen = state.game.fen();
    state.analysis = {
        id: state.analysisId, fen, turn: state.game.turn(),
        bestUci: null, bestSan: null, cp: null, mate: null, depth: 0, pvSan: [], pvUci: [], done: false,
    };
    engine.analyze(fen);
    renderAll();
}

function handleInfo(line) {
    const a = state.analysis;
    if (!a || a.done) return;
    // Движок может дозавершать поиск старой позиции — его инфо нам не нужно.
    if (engine.currentFen !== a.fen) return;
    const depthM = line.match(/\bdepth (\d+)/);
    const cpM = line.match(/score cp (-?\d+)/);
    const mateM = line.match(/score mate (-?\d+)/);
    const pvM = line.match(/\bpv (.+)$/);
    if (!depthM || !pvM) return;
    a.depth = parseInt(depthM[1], 10);
    if (mateM) { a.mate = parseInt(mateM[1], 10); a.cp = null; }
    else if (cpM) { a.cp = parseInt(cpM[1], 10); a.mate = null; }
    a.pvUci = pvM[1].trim().split(/\s+/);
    a.bestUci = a.pvUci[0];
    a.pvSan = pvToSan(a.fen, a.pvUci, 8);
    a.bestSan = a.pvSan[0] || null;
    updateAfterEvalTick();
    renderAll();
}

function handleBestmove(line) {
    engine.searching = false;
    // Пока движок думал, позиция изменилась — запускаем отложенный поиск.
    if (engine.queuedFen) {
        const fen = engine.queuedFen;
        engine.queuedFen = null;
        engine.analyze(fen);
        return;
    }
    const a = state.analysis;
    if (!a || a.done || engine.currentFen !== a.fen) return;
    const uci = line.split(/\s+/)[1];
    if (uci && uci !== "(none)") {
        a.bestUci = uci;
        if (!a.bestSan) {
            const mv = uciToVerbose(a.fen, uci);
            a.bestSan = mv ? mv.san : uci;
        }
    }
    a.done = true;
    if (state.engineMoveRequested) {
        state.engineMoveRequested = false;
        applyEngineMove();
    }
    // Доигрывание исторической партии движком (просмотр в тренировке дебютов).
    if (isDrillMode() && state.drill && state.drill.phase === "replay" && state.drill.sfContinue) {
        drillSfTick();
    }
    renderAll();
}

/** По мере поступления оценки новой позиции — уточняем качество последнего хода. */
function updateAfterEvalTick() {
    const review = state.lastMoveReview;
    const a = state.analysis;
    if (!review || !a || review.fenAfter !== a.fen || a.depth < 10) return;
    const afterW = whiteCp(a);
    if (afterW === null || review.evalBeforeW === null) return;
    const moverSign = review.move.color === "w" ? 1 : -1;
    const cpLoss = Math.max(0, (review.evalBeforeW - afterW) * moverSign);
    review.quality = classifyQuality(review.matchedBest, review.matchedBest ? 0 : cpLoss);
    review.planSan = a.pvSan.slice(0, 6);
    review.evalAfterText = formatEval(a);
}

// ---------------- Ходы ----------------
function tryMove(from, to) {
    const legal = state.game.moves({ square: from, verbose: true }).find((m) => m.to === to);
    if (!legal) return false;
    if (state.mode === "puzzles") return puzzleTryMove(legal);
    if (isDrillMode()) return drillTryMove(legal);
    if (legal.flags.includes("p")) {
        state.pendingPromotion = { from, to };
        renderPromotionDialog();
        return true;
    }
    makeMove({ from, to });
    return true;
}

function makeMove(moveObj) {
    // Рекомендация для позиции до хода — база для оценки качества.
    const rec = state.analysis && state.analysis.bestUci ? { ...state.analysis } : null;
    const move = state.game.move(moveObj);
    if (!move) return;
    state.lastMove = move;
    state.selected = null;
    state.pendingPromotion = null;

    const playedUci = move.from + move.to + (move.promotion || "");
    const history = state.game.history();
    const moveNumber = Math.ceil(history.length / 2);
    const explained = explainMove(move, state.game, moveNumber);

    state.lastMoveReview = {
        move,
        san: move.san,
        color: move.color,
        moveNumber,
        fenAfter: state.game.fen(),
        opening: openingForLastMove(history),
        openingCtx: findOpening(history),
        notes: explained.notes,
        phase: explained.phase,
        matchedBest: rec ? rec.bestUci === playedUci : false,
        evalBeforeW: rec ? whiteCp(rec) : null,
        recommendedSan: rec ? rec.bestSan : null,
        quality: classifyQuality(rec ? rec.bestUci === playedUci : false, null),
        planSan: [],
        evalAfterText: null,
    };

    checkGameOver();
    if (!state.gameOver) requestAnalysis();
    if (isDrillMode()) drillOnMoved();
    // Обычная игра: бот отвечает сам, как только досчитает.
    if (state.mode === "casual" && !state.gameOver && state.game.turn() !== state.playerColor) {
        state.engineMoveRequested = true;
    }
    renderAll();
}

function applyEngineMove() {
    const a = state.analysis;
    if (!a || !a.bestUci) return;
    makeMove({ from: a.bestUci.slice(0, 2), to: a.bestUci.slice(2, 4), promotion: a.bestUci[4] || "q" });
}

function onEngineMoveClick() {
    if (state.gameOver) return;
    const a = state.analysis;
    if (a && (a.done || a.depth >= 12) && a.bestUci) {
        applyEngineMove();
    } else {
        state.engineMoveRequested = true;
        setEngineStatus("Движок думает…");
    }
}

function undoMove() {
    if (state.game.history().length === 0) return;
    state.game.undo();
    // Против бота откатываем пару «ответ бота + свой ход», чтобы очередь вернулась игроку.
    if (state.mode === "casual" && state.game.turn() !== state.playerColor && state.game.history().length > 0) {
        state.game.undo();
    }
    state.gameOver = false;
    state.lastMove = null;
    state.lastMoveReview = null;
    state.selected = null;
    state.engineMoveRequested = false;
    const h = state.game.history({ verbose: true });
    if (h.length) state.lastMove = h[h.length - 1];
    requestAnalysis();
    renderAll();
}

function checkGameOver() {
    const g = state.game;
    if (!g.game_over()) { state.gameOver = false; return; }
    state.gameOver = true;
    let text;
    if (g.in_checkmate()) {
        const winner = g.turn() === "w" ? "чёрные" : "белые";
        text = `Мат — победили ${winner}.`;
    } else if (g.in_stalemate()) text = "Пат — ничья.";
    else if (g.in_threefold_repetition()) text = "Ничья: троекратное повторение.";
    else if (g.insufficient_material()) text = "Ничья: недостаточно материала.";
    else text = "Ничья: правило 50 ходов.";
    // Рейтинг за обычную игру против бота: +2.5% эло бота за победу, −5% за поражение.
    if (state.mode === "casual") {
        const botElo = DIFFICULTY_LEVELS[state.difficulty].approx;
        if (g.in_checkmate()) {
            const playerWon = (g.turn() === "w" ? "b" : "w") === state.playerColor;
            const delta = playerWon
                ? ratingApply(botElo, RATING_PCT.win, +1)
                : ratingApply(botElo, RATING_PCT.lose, -1);
            text += ` Рейтинг ${delta > 0 ? "+" + delta : delta} → ${getRating()}.`;
        } else {
            text += " Рейтинг без изменений (ничья).";
        }
    }
    $("game-status").textContent = text;
    $("game-status").classList.remove("hidden");
}

// ---------------- Доска ----------------
function isFlipped() { return state.playerColor === "b"; }

/** square → {col,row} экранные координаты 0..7 (0,0 — левый верхний угол). */
function squareToXY(sq) {
    const file = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10) - 1;
    return isFlipped()
        ? { col: 7 - file, row: rank }
        : { col: file, row: 7 - rank };
}

function buildBoard() {
    const board = $("board");
    board.innerHTML = "";
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const file = isFlipped() ? 7 - col : col;
            const rank = isFlipped() ? row : 7 - row;
            const sq = FILES[file] + (rank + 1);
            const cell = document.createElement("div");
            cell.className = "square " + ((file + rank) % 2 === 0 ? "dark" : "light");
            cell.dataset.square = sq;
            cell.addEventListener("click", () => onSquareClick(sq));
            // имя клетки в углу каждой клетки — чтобы не высчитывать координаты в уме
            const lbl = document.createElement("span");
            lbl.className = "coord";
            lbl.textContent = sq;
            cell.appendChild(lbl);
            board.appendChild(cell);
        }
    }
}

function renderBoard() {
    const cells = $("board").children;
    const legalTargets = state.selected
        ? state.game.moves({ square: state.selected, verbose: true }).map((m) => m.to)
        : [];
    // Учебный режим: подсветка клеток нужного хода. Теория: подсветка иллюстрации.
    let teachFrom = null, teachTo = null;
    if (isDrillMode() && state.drill && state.drill.teach && state.drill.phase === "quiz" && !drillShouldAuto()) {
        const exp = drillExpectedVerbose();
        if (exp) { teachFrom = exp.from; teachTo = exp.to; }
    }
    if (state.mode === "theory" && state.theory) {
        const page = THEORY_SECTIONS[state.theory.s].pages[state.theory.p];
        if (page.hl) { teachFrom = page.hl[0]; teachTo = page.hl[1]; }
    }
    for (const cell of cells) {
        const sq = cell.dataset.square;
        const piece = state.game.get(sq);
        // фигура
        let glyph = cell.querySelector(".piece");
        if (!glyph) {
            glyph = document.createElement("span");
            glyph.className = "piece";
            cell.appendChild(glyph);
        }
        glyph.textContent = piece ? UNICODE_PIECES[piece.color][piece.type] : "";
        glyph.classList.toggle("white-piece", !!piece && piece.color === "w");
        glyph.classList.toggle("black-piece", !!piece && piece.color === "b");
        // подсветки
        cell.classList.toggle("sel", state.selected === sq);
        cell.classList.toggle("last-from", !!state.lastMove && state.lastMove.from === sq);
        cell.classList.toggle("last-to", !!state.lastMove && state.lastMove.to === sq);
        cell.classList.toggle("legal", legalTargets.includes(sq));
        cell.classList.toggle("legal-capture", legalTargets.includes(sq) && !!state.game.get(sq));
        cell.classList.toggle("in-check",
            !!piece && piece.type === "k" && piece.color === state.game.turn() && state.game.in_check());
        cell.classList.toggle("teach-from", sq === teachFrom);
        cell.classList.toggle("teach-to", sq === teachTo);
    }
    renderArrow();
}

function renderArrow() {
    const svg = $("arrow-layer");
    svg.innerHTML = `<defs><marker id="arrowhead" markerWidth="3" markerHeight="3" refX="1.6" refY="1.5" orient="auto">
        <polygon points="0 0.4, 2.2 1.5, 0 2.6" class="arrow-head"/></marker></defs>`;
    const a = state.analysis;
    // В загадке стрелка запрещена (спойлер), в просмотре партий — показываем лучший ход.
    if (isDrillMode() && (!state.drill || state.drill.phase !== "replay")) return;
    if (state.mode === "casual" || state.mode === "puzzles" || state.mode === "theory") return; // без подсказок
    if (state.gameOver || !a || !a.bestUci || a.fen !== state.game.fen()) return;
    const from = squareToXY(a.bestUci.slice(0, 2));
    const to = squareToXY(a.bestUci.slice(2, 4));
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", from.col + 0.5);
    line.setAttribute("y1", from.row + 0.5);
    line.setAttribute("x2", to.col + 0.5);
    line.setAttribute("y2", to.row + 0.5);
    line.setAttribute("marker-end", "url(#arrowhead)");
    line.classList.add("arrow-line");
    svg.appendChild(line);
}

function onSquareClick(sq) {
    if (state.gameOver || state.pendingPromotion) return;
    // Тренировка дебютов: клики только в фазе загадки и только в свой ход.
    if (isDrillMode() && (!state.drill || state.drill.phase !== "quiz" || drillShouldAuto())) return;
    // Обычная игра: за бота ходить нельзя.
    if (state.mode === "casual" && state.game.turn() !== state.playerColor) return;
    // Теория — доска-иллюстрация; в задаче ходит только решающий.
    if (state.mode === "theory") return;
    if (state.mode === "puzzles" && (!state.puzzle || state.puzzle.solved || state.game.turn() !== state.playerColor)) return;
    const piece = state.game.get(sq);
    if (state.selected) {
        if (sq === state.selected) { state.selected = null; renderBoard(); return; }
        if (tryMove(state.selected, sq)) return;
    }
    // пользователь ходит за ОБЕ стороны: выбрать можно фигуру стороны, чей ход
    if (piece && piece.color === state.game.turn()) {
        state.selected = sq;
    } else {
        state.selected = null;
    }
    renderBoard();
}

function renderPromotionDialog() {
    const overlay = $("promotion-overlay");
    overlay.classList.remove("hidden");
    overlay.innerHTML = "";
    const box = document.createElement("div");
    box.className = "promotion-box";
    const color = state.game.turn();
    for (const pt of ["q", "r", "b", "n"]) {
        const btn = document.createElement("button");
        btn.className = "promo-btn " + (color === "w" ? "white-piece" : "black-piece");
        btn.textContent = UNICODE_PIECES[color][pt];
        btn.addEventListener("click", () => {
            const p = state.pendingPromotion;
            overlay.classList.add("hidden");
            makeMove({ from: p.from, to: p.to, promotion: pt });
        });
        box.appendChild(btn);
    }
    overlay.appendChild(box);
}

// ---------------- Задачи (рейтинг) ----------------
const PUZZLE_OPP_DELAY_MS = 550; // пауза перед ответом соперника в задаче

function startPuzzle(excludeId) {
    const p = pickPuzzle(excludeId || (state.puzzle ? state.puzzle.p.id : null));
    state.puzzle = { p, idx: 0, solved: false, fails: 0, lastDelta: null };
    state.game = new Chess(p.fen);
    state.playerColor = state.game.turn(); // решающий всегда снизу
    state.selected = null;
    state.lastMove = null;
    state.lastMoveReview = null;
    state.gameOver = false;
    state.engineMoveRequested = false;
    buildBoard();
    renderAll();
}

/** Попытка хода в задаче: применяется только ход решения. */
function puzzleTryMove(legal) {
    const z = state.puzzle;
    if (!z || z.solved) return false;
    const expected = z.p.solution[z.idx];
    if (drillNorm(legal.san) === drillNorm(expected)) {
        state.game.move({ from: legal.from, to: legal.to, promotion: legal.promotion });
        state.lastMove = state.game.history({ verbose: true }).slice(-1)[0];
        state.selected = null;
        z.idx++;
        if (z.idx >= z.p.solution.length) {
            z.solved = true;
            puzzleMarkSolved(z.p.id);
            z.lastDelta = ratingApply(z.p.rating, RATING_PCT.puzzleSolve, +1);
        } else {
            // Единственный ответ соперника из решения — с паузой.
            setTimeout(() => {
                if (!state.puzzle || state.puzzle !== z || z.solved) return;
                state.game.move(z.p.solution[z.idx]);
                state.lastMove = state.game.history({ verbose: true }).slice(-1)[0];
                z.idx++;
                renderAll();
            }, PUZZLE_OPP_DELAY_MS);
        }
        renderAll();
        return true;
    }
    z.fails++;
    z.lastDelta = ratingApply(z.p.rating, RATING_PCT.puzzleFail, -1);
    state.selected = null;
    renderAll();
    return true;
}

function renderPuzzlePanel(box) {
    const z = state.puzzle;
    if (!z) { box.innerHTML = ""; return; }
    const sideName = state.playerColor === "w" ? "белых" : "чёрных";
    let html = `<h3>🧩 ${z.p.title} <span class="muted">(сложность ${z.p.rating})</span></h3>
        <p class="muted">${z.p.source}</p>`;
    if (z.solved) {
        html += `<div class="drill-correct">✅ Решено! Рейтинг +${z.lastDelta} → <b>${getRating()}</b></div>
            <div class="drill-actions"><button id="puzzle-next" class="btn-primary">🧩 Следующая задача</button></div>`;
    } else {
        html += `<p class="drill-your-turn">Ход ${sideName} — найди сильнейшее продолжение.</p>`;
        if (z.fails > 0 && z.lastDelta !== null && z.lastDelta < 0) {
            html += `<div class="drill-wrong">❌ Неверно (−${-z.lastDelta} рейтинга). Пробуй ещё — решение на доске есть.</div>`;
        }
        html += `<div class="drill-actions"><button id="puzzle-skip" class="btn-secondary">Пропустить →</button></div>`;
    }
    html += `<p class="stats-caption">Решено задач: ${puzzlesSolvedIds().length} / ${PUZZLES.length} · 🏅 рейтинг ${getRating()}</p>`;
    box.innerHTML = html;
    if ($("puzzle-next")) $("puzzle-next").addEventListener("click", () => startPuzzle());
    if ($("puzzle-skip")) $("puzzle-skip").addEventListener("click", () => startPuzzle());
}

// ---------------- Теория ----------------
function startTheory() {
    const pos = theoryLoadPos();
    state.theory = { s: Math.min(pos.s, THEORY_SECTIONS.length - 1), p: pos.p };
    theoryShowPage();
}

function theoryShowPage() {
    const t = state.theory;
    const section = THEORY_SECTIONS[t.s];
    t.p = Math.max(0, Math.min(t.p, section.pages.length - 1));
    const page = section.pages[t.p];
    state.game = new Chess();
    if (page.fen && page.fen !== "start") state.game.load(page.fen);
    state.playerColor = "w";
    state.lastMove = null;
    state.selected = null;
    state.gameOver = false;
    theorySavePos(t.s, t.p);
    buildBoard();
    renderAll();
}

function renderTheoryPanel(box) {
    const t = state.theory;
    if (!t) { box.innerHTML = ""; return; }
    const section = THEORY_SECTIONS[t.s];
    const page = section.pages[t.p];
    const options = THEORY_SECTIONS.map((s, i) =>
        `<option value="${i}" ${i === t.s ? "selected" : ""}>Ур. ${s.level} — ${s.title}</option>`).join("");
    let html = `<h3>🎓 Теория</h3>
        <select id="theory-section" class="theory-select">${options}</select>
        <div class="drill-note theory-page-text">${page.text}</div>
        <div class="drill-actions">
            <button id="theory-prev" class="btn-secondary" ${t.p === 0 && t.s === 0 ? "disabled" : ""}>◀ Назад</button>
            <span class="drill-replay-pos">стр. ${t.p + 1}/${section.pages.length}</span>
            <button id="theory-next" class="btn-primary">Дальше ▶</button>
        </div>`;
    box.innerHTML = html;
    $("theory-section").addEventListener("change", (e) => {
        t.s = parseInt(e.target.value, 10); t.p = 0; theoryShowPage();
    });
    $("theory-prev").addEventListener("click", () => {
        if (t.p > 0) { t.p--; }
        else if (t.s > 0) { t.s--; t.p = THEORY_SECTIONS[t.s].pages.length - 1; }
        theoryShowPage();
    });
    $("theory-next").addEventListener("click", () => {
        if (t.p < section.pages.length - 1) { t.p++; }
        else if (t.s < THEORY_SECTIONS.length - 1) { t.s++; t.p = 0; }
        theoryShowPage();
    });
}

// ---------------- Тренировка дебютов ----------------
/** Режимы на механике тренировки: drill (загадка) и learn (обучение с указаниями). */
function isDrillMode() { return state.mode === "drill" || state.mode === "learn"; }

/** SAN без пометок шаха/мата — для сравнения хода игрока с линией. */
function drillNorm(san) { return san.replace(/[+#]/g, ""); }

const DRILL_PIECE_RU = { p: "пешка", n: "конь", b: "слон", r: "ладья", q: "ферзь", k: "король" };

/**
 * Партии тренировки, отсортированные по глубине совпадения с линией дебюта
 * (самая похожая — первой). match — число совпавших полуходов.
 */
function drillGamesSorted(d) {
    const line = d.drill.line;
    return (d.drill.info.famousGames || [])
        .map((g, gi) => {
            let k = 0;
            while (k < line.length && k < g.moves.length && drillNorm(g.moves[k]) === drillNorm(line[k])) k++;
            return { g, gi, match: k };
        })
        .sort((a, b) => b.match - a.match);
}

/** Ожидаемый ход линии в verbose-виде (для эскалации подсказок). */
function drillExpectedVerbose() {
    const expected = drillLine()[state.game.history().length];
    if (!expected) return null;
    return state.game.moves({ verbose: true }).find((m) => drillNorm(m.san) === drillNorm(expected)) || null;
}

function drillLine() { return state.drill.drill.line; }

/** Сейчас должен ходить тренажёр? (соперник; за белого игрока — и первый ход белых) */
function drillShouldAuto() {
    const d = state.drill;
    if (!d || d.phase !== "quiz") return false;
    const idx = state.game.history().length;
    if (idx >= drillLine().length) return false;
    if (state.game.turn() !== state.playerColor) return true;
    // Первый ход белых — часть загадки; в learn-режиме загадки нет, ходит игрок.
    return !d.teach && idx === 0 && state.playerColor === "w";
}

function startDrill(drillObj, opts) {
    state.drill = {
        drill: drillObj, phase: "quiz", feedback: null, wrongTries: 0,
        wrongAtPly: 0, lastCorrect: null, replayPly: 0, replayGame: 0,
        sfContinue: false, sfLastSan: null, sfLastEval: null,
        teach: !!(opts && opts.teach), // learn-режим: прямые указания вместо загадки
    };
    state.playerColor = (opts && opts.color) || drillObj.player;
    state.game = new Chess();
    state.selected = null;
    state.lastMove = null;
    state.lastMoveReview = null;
    state.gameOver = false;
    state.engineMoveRequested = false;
    $("drill-modal").classList.add("hidden");
    $("eval-bar").classList.add("hidden"); // в загадке оценка — спойлер
    buildBoard();
    renderAll();
    drillScheduleAuto();
}

function drillScheduleAuto() {
    if (!drillShouldAuto()) return;
    setTimeout(() => {
        if (!drillShouldAuto()) return;
        makeMove(drillLine()[state.game.history().length]);
    }, DRILL_OPP_MOVE_DELAY_MS);
}

/** Вызывается из makeMove после каждого хода в режиме drill. */
function drillOnMoved() {
    const d = state.drill;
    if (!d || d.phase !== "quiz") return;
    d.feedback = null;
    d.wrongAtPly = 0; // новая позиция — эскалация подсказок с нуля
    if (state.game.history().length >= drillLine().length) {
        d.phase = "done";
        setTimeout(() => { openDrillModal(); renderAll(); }, DRILL_MODAL_DELAY_MS);
    } else {
        drillScheduleAuto();
    }
}

/** Попытка хода игрока: применяется только точный ход загаданной линии. */
function drillTryMove(legal) {
    const d = state.drill;
    if (!d || d.phase !== "quiz") return false;
    const idx = state.game.history().length;
    const expected = drillLine()[idx];
    if (drillNorm(legal.san) === drillNorm(expected)) {
        const hint = (d.drill.hints || [])[idx] || "";
        makeMove({ from: legal.from, to: legal.to, promotion: legal.promotion });
        // Обоснование правильного хода: мысль линии + теория из дебютной базы.
        const op = openingForLastMove(state.game.history().slice(0, idx + 1));
        d.lastCorrect = { san: legal.san, hint, op: op ? { name: op.name, idea: op.idea } : null };
        renderAll();
        return true;
    }
    d.wrongTries++;
    d.wrongAtPly++;
    if (d.teach) {
        // Учебный режим: указываем нужный ход прямо.
        const exp = drillExpectedVerbose();
        d.feedback = exp
            ? `Нужный ход: ${DRILL_PIECE_RU[exp.piece]} ${exp.from} → ${exp.to} (подсвечен на доске).`
            : "Попробуй ещё раз.";
    } else {
        // Загадка: ход НЕ применяем; говорим, какому дебюту принадлежит попытка,
        // но загаданный не раскрываем.
        const attempt = state.game.history().concat([legal.san]);
        const exact = openingForLastMove(attempt);
        const ctx = findOpening(attempt);
        const name = exact ? exact.name : (ctx ? ctx.entry.name : null);
        d.feedback = name
            ? `Твой ход ${sanToRu(legal.san)} — это «${name}». Загадан другой дебют — пробуй ещё.`
            : `Ход ${sanToRu(legal.san)} не входит в дебютные линии базы. Пробуй ещё.`;
    }
    state.selected = null;
    renderAll();
    return true;
}

/** Обоснование хода линии из дебютной базы (для learn-режима, когда нет hint). */
function drillTheoryWhy(idx) {
    const line = drillLine();
    if (idx >= line.length) return "";
    const op = openingForLastMove(state.game.history().concat([line[idx]]));
    return op ? `${op.name}. ${op.idea}` : "";
}

/** Панель тренировки (занимает место рекомендаций движка). */
function renderDrillPanel(box) {
    const d = state.drill;
    if (!d) { box.innerHTML = ""; return; }
    const info = d.drill.info;

    if (d.phase === "quiz" && d.teach) {
        // Учебный режим: прямые указания — какую фигуру куда двигать и почему.
        const yourTurn = state.game.turn() === state.playerColor && !drillShouldAuto();
        let html = `<h3>📖 Учим: ${info.name}</h3>
            <p class="muted">Вы за ${state.playerColor === "w" ? "белых" : "чёрных"}; соперник отвечает сам. Делай ход — фигура и клетка подсвечены.</p>`;
        if (d.lastCorrect) {
            html += `<div class="drill-correct">✅ <b>${sanToRu(d.lastCorrect.san)}</b> — сделано. ${d.lastCorrect.hint}`;
            if (d.lastCorrect.op) html += `<div class="drill-correct-op"><b>${d.lastCorrect.op.name}.</b> ${d.lastCorrect.op.idea}</div>`;
            html += `</div>`;
        }
        if (yourTurn) {
            const idx = state.game.history().length;
            const exp = drillExpectedVerbose();
            const why = (d.drill.hints || [])[idx] || drillTheoryWhy(idx);
            if (exp) {
                const castle = exp.san.startsWith("O-O") ? " — рокировка" : "";
                html += `<div class="drill-teach">👉 Двигай: <b>${DRILL_PIECE_RU[exp.piece]} ${exp.from} → ${exp.to}</b>${castle}
                    ${why ? `<div class="drill-teach-why">Почему: ${why}</div>` : ""}</div>`;
            }
            if (d.feedback) html += `<div class="drill-wrong">❌ Не то. ${d.feedback}</div>`;
        } else {
            html += `<p class="muted">Тренажёр отвечает…</p>`;
        }
        box.innerHTML = html;
        return;
    }

    if (d.phase === "quiz") {
        const yourTurn = state.game.turn() === state.playerColor && !drillShouldAuto();
        let html = `<h3>🎯 Тренировка дебютов</h3>
            <p>Загадан дебют за <b>${state.playerColor === "w" ? "белых" : "чёрных"}</b> — сильнейший против дебюта соперника.
            Определи его по ходам и каждый раз делай единственный правильный ход линии.</p>`;
        // Обоснование последнего правильного хода — чтобы учиться, а не гадать.
        if (d.lastCorrect) {
            html += `<div class="drill-correct">✅ <b>${sanToRu(d.lastCorrect.san)}</b> — правильно! ${d.lastCorrect.hint}`;
            if (d.lastCorrect.op) {
                html += `<div class="drill-correct-op"><b>${d.lastCorrect.op.name}.</b> ${d.lastCorrect.op.idea}</div>`;
            }
            html += `</div>`;
        }
        html += `<p class="${yourTurn ? "drill-your-turn" : "muted"}">${yourTurn ? "Твой ход!" : "Тренажёр ходит…"}</p>`;
        if (yourTurn) {
            // Мысль «на подумать» — всегда; конкретика добирается с ошибками.
            const idx = state.game.history().length;
            const think = (d.drill.hints || [])[idx];
            if (think) html += `<div class="drill-think">🤔 На подумать: ${think}</div>`;
            if (d.feedback) html += `<div class="drill-wrong">❌ Неправильно. ${d.feedback}</div>`;
            if (d.wrongAtPly > 0) {
                const exp = drillExpectedVerbose();
                const clues = [];
                if (exp) {
                    if (d.wrongAtPly >= 1) clues.push(exp.san.startsWith("O-O") ? "это рокировка" : `ходит ${DRILL_PIECE_RU[exp.piece]}`);
                    if (d.wrongAtPly >= 2) clues.push(`фигура стоит на ${exp.from}`);
                    if (d.wrongAtPly >= 3) clues.push(`целевое поле — ${exp.to}`);
                }
                if (clues.length) {
                    html += `<div class="drill-clues"><b>Подсказки:</b><ul>`
                        + clues.map((c) => `<li>${c}</li>`).join("") + `</ul></div>`;
                }
            }
        } else if (d.feedback) {
            html += `<div class="drill-wrong">❌ Неправильно. ${d.feedback}</div>`;
        }
        box.innerHTML = html;
        return;
    }

    if (d.phase === "done") {
        const stats = FAMILY_STATS[info.statsFamily];
        const score = stats ? expectedScoreForColor(stats, state.playerColor).toFixed(0) : null;
        const games = info.famousGames || [];
        let html = `<h3>✅ Дебют пройден${d.wrongTries ? ` (ошибок: ${d.wrongTries})` : " без ошибок!"}</h3>
            <div class="strat-opening">${info.name}</div>`;
        if (score) html += `<p>Шанс на победу за твой цвет (ожидаемый счёт): <b>${score}%</b></p>`;
        html += `<div class="drill-actions"><button id="drill-btn-info" class="btn-primary">ℹ Информация о дебюте</button>`;
        drillGamesSorted(d).forEach(({ g, gi, match }) => {
            const m = match > 1 ? ` <span class="drill-match">(${Math.ceil(match / 2)} ход. как в линии)</span>` : "";
            html += `<button class="btn-secondary drill-btn-game" data-game="${gi}">▶ ${g.title}${m}</button>`;
        });
        html += `<button id="drill-btn-new" class="btn-secondary">🎲 Новый дебют</button></div>`;
        box.innerHTML = html;
        $("drill-btn-info").addEventListener("click", openDrillModal);
        box.querySelectorAll(".drill-btn-game").forEach((btn) =>
            btn.addEventListener("click", () => drillEnterReplay(parseInt(btn.dataset.game, 10))));
        $("drill-btn-new").addEventListener("click", () => startDrill(pickDrill(d.drill.id), d.teach ? { teach: true, color: state.playerColor } : undefined));
        return;
    }

    // phase === "replay": просмотр знаменитой партии, ходить нельзя — только мотать.
    const f = (info.famousGames || [])[d.replayGame];
    if (!f) { box.innerHTML = ""; return; }
    const i = d.replayPly;
    const sfExtra = state.game.history().length - Math.min(i, f.moves.length);
    const atEnd = i >= f.moves.length;
    let html = `<h3>▶ ${f.title}</h3><p class="muted">${f.result}</p>
        <div class="drill-actions">
            <button id="drill-btn-prev" class="btn-secondary" ${i === 0 && sfExtra === 0 ? "disabled" : ""}>◀ Назад</button>
            <button id="drill-btn-next" class="btn-primary" ${atEnd || sfExtra > 0 ? "disabled" : ""}>Вперёд ▶</button>
            <span class="drill-replay-pos">${i} / ${f.moves.length}${sfExtra > 0 ? ` +🤖${sfExtra}` : ""}</span>
        </div>`;
    if (sfExtra > 0 && d.sfLastSan) {
        const total = state.game.history().length;
        html += `<div class="drill-note drill-note-sf"><b>🤖 ${Math.ceil(total / 2)}.${total % 2 ? "" : "…"} ${sanToRu(d.sfLastSan)}</b> — ход Stockfish (оценка до хода: ${d.sfLastEval || "…"}). Так партия игралась бы дальше при лучшей игре обеих сторон.</div>`;
    } else if (i > 0) {
        const moveNo = Math.ceil(i / 2);
        const side = i % 2 === 1 ? "" : "…";
        html += `<div class="drill-note"><b>${moveNo}.${side} ${sanToRu(f.moves[i - 1])}</b> — ${f.notes[i - 1]}</div>`;
    } else {
        html += `<p class="muted">Жми «Вперёд» — каждый ход с объяснением идеи.</p>`;
    }
    // Доигрывание движком: доступно с конца записи (и после остановки — продолжить).
    if (atEnd && !state.game.game_over()) {
        html += `<div class="drill-actions">
            <button id="drill-btn-sf" class="${d.sfContinue ? "btn-secondary" : "btn-primary"}">${d.sfContinue ? "⏸ Остановить движок" : "🤖 Продолжить Stockfish'ом"}</button>
            ${d.sfContinue ? `<span class="muted">движок доигрывает…</span>` : ""}
        </div>`;
    } else if (atEnd && state.game.game_over()) {
        html += `<p class="muted">Партия дошла до конца — дальше ходов нет.</p>`;
    }
    // Оценка Stockfish текущей позиции: видно, где мастера отклонялись от лучшей игры.
    const a = state.analysis;
    if (a && a.fen === state.game.fen() && a.bestSan) {
        const histNext = i < f.moves.length ? f.moves[i] : null;
        const differs = histNext && drillNorm(histNext) !== drillNorm(a.bestSan);
        html += `<div class="drill-engine">🤖 Stockfish: лучший ход — <b>${sanToRu(a.bestSan)}</b>
            (${formatEval(a)}, глубина ${a.depth}${a.done ? "" : "…"})`;
        if (histNext) {
            html += differs
                ? `<div class="drill-engine-diff">В партии было сыграно ${sanToRu(histNext)} — движок предпочёл бы ${sanToRu(a.bestSan)}.</div>`
                : `<div class="drill-engine-same">Следующий ход партии совпадает с выбором движка.</div>`;
        }
        html += `</div>`;
    }
    html += `<div class="drill-actions">
        <button id="drill-btn-back" class="btn-secondary">ℹ К информации</button>
        <button id="drill-btn-new2" class="btn-secondary">🎲 Новый дебют</button></div>`;
    box.innerHTML = html;
    $("drill-btn-prev").addEventListener("click", drillReplayPrev);
    $("drill-btn-next").addEventListener("click", drillReplayNext);
    $("drill-btn-back").addEventListener("click", openDrillModal);
    $("drill-btn-new2").addEventListener("click", () => startDrill(pickDrill(d.drill.id), d.teach ? { teach: true, color: state.playerColor } : undefined));
    if ($("drill-btn-sf")) $("drill-btn-sf").addEventListener("click", drillSfToggle);
}

/** Информационное окно после прохождения: план, идея, шансы, вариации, история. */
function openDrillModal() {
    const d = state.drill;
    if (!d) return;
    const info = d.drill.info;
    const stats = FAMILY_STATS[info.statsFamily] || null;
    const overlay = $("drill-modal");
    const games = info.famousGames || [];
    // Диаграмма: к какой позиции ведёт линия дебюта (снизу — цвет игрока).
    const tmpG = new Chess();
    d.drill.line.forEach((m) => tmpG.move(m));
    let left = `<div class="modal-diagram">${miniBoardHtml(tmpG.fen(), state.playerColor === "b", "mini-lg")}
        <div class="stats-caption">Позиция линии после ${Math.ceil(d.drill.line.length / 2)}-го хода; вы — снизу</div></div>`;
    if (stats) {
        const score = expectedScoreForColor(stats, state.playerColor).toFixed(0);
        left += `<h4>📊 Шансы</h4>
            <div class="stats-bar">
                <div class="seg seg-w" style="width:${stats.w}%">${stats.w}%</div>
                <div class="seg seg-d" style="width:${stats.d}%">${stats.d}%</div>
                <div class="seg seg-b" style="width:${stats.b}%">${stats.b}%</div>
            </div>
            <div class="stats-caption">победы белых · ничьи · победы чёрных <span class="muted">(мастерские базы, округлённо)</span></div>
            <div class="stats-mine">Ожидаемый счёт за твой цвет (${state.playerColor === "w" ? "белые" : "чёрные"}): <b>${score}%</b></div>`;
    }
    left += `<h4>💡 Основная идея</h4><p>${info.idea}</p>
        <h4>📋 План</h4>
        <p><b>Дебют:</b> ${info.plan.opening}</p>
        <p><b>Миттельшпиль:</b> ${info.plan.middlegame}</p>
        <p><b>Эндшпиль:</b> ${info.plan.endgame}</p>`;

    let right = `<h4>🔀 Вариации</h4><ul class="modal-list">`
        + info.variations.map((v) => `<li>${v}</li>`).join("")
        + `</ul><h4>📜 История</h4><p>${info.story}</p>`;
    right += `<h4>🎬 Знаменитые партии</h4>`;
    if (games.length) {
        right += `<div class="modal-games">`
            + drillGamesSorted(d).map(({ g, gi, match }) => {
                const m = match > 1 ? ` <span class="drill-match">(${Math.ceil(match / 2)} ход. как в линии)</span>` : "";
                return `<button class="btn-primary drill-modal-game" data-game="${gi}">▶ ${g.title}${m}</button>`;
            }).join("")
            + `</div>`;
    } else {
        right += `<p class="muted">Проверенных знаменитых партий для этого дебюта пока нет — дебют оставлен, потому что он сильнейший по статистике.</p>`;
    }

    overlay.innerHTML = `<div class="modal-card">
        <button id="drill-modal-close" class="modal-close" title="Закрыть">✕</button>
        <h2>${info.name}</h2>
        <div class="modal-columns"><div class="modal-col">${left}</div><div class="modal-col">${right}</div></div>
        <div class="drill-actions">
            <button id="drill-modal-new" class="btn-secondary">🎲 Учить новый дебют</button>
            <button id="drill-modal-close2" class="btn-secondary">Закрыть</button>
        </div></div>`;
    overlay.classList.remove("hidden");
    const close = () => overlay.classList.add("hidden");
    $("drill-modal-close").addEventListener("click", close);
    $("drill-modal-close2").addEventListener("click", close);
    overlay.querySelectorAll(".drill-modal-game").forEach((btn) =>
        btn.addEventListener("click", () => drillEnterReplay(parseInt(btn.dataset.game, 10))));
    $("drill-modal-new").addEventListener("click", () => { close(); startDrill(pickDrill(d.drill.id), d.teach ? { teach: true, color: state.playerColor } : undefined); });
}

/** Просмотр знаменитой партии: доска сбрасывается, ходы мотаются кнопками. */
function drillEnterReplay(gameIndex) {
    const d = state.drill;
    const games = d ? (d.drill.info.famousGames || []) : [];
    const gi = typeof gameIndex === "number" && games[gameIndex] ? gameIndex : 0;
    if (!games.length) return;
    d.phase = "replay";
    d.replayGame = gi;
    d.replayPly = 0;
    d.sfContinue = false;
    d.sfLastSan = null;
    d.sfLastEval = null;
    state.game = new Chess();
    state.lastMove = null;
    state.selected = null;
    $("drill-modal").classList.add("hidden");
    // В просмотре движок работает: оценка позиций исторической партии.
    $("eval-bar").classList.remove("hidden");
    requestAnalysis();
    renderAll();
}

/** Запустить/остановить доигрывание позиции движком (за обе стороны). */
function drillSfToggle() {
    const d = state.drill;
    if (!d || d.phase !== "replay") return;
    d.sfContinue = !d.sfContinue;
    if (d.sfContinue) {
        const a = state.analysis;
        if (a && a.done && a.fen === state.game.fen()) drillSfTick();
        else requestAnalysis();
    }
    renderAll();
}

/** Один ход движка в доигрывании: применить лучший ход и заказать следующий анализ. */
function drillSfTick() {
    const d = state.drill;
    const a = state.analysis;
    if (!d || !d.sfContinue || !a || !a.bestUci || a.fen !== state.game.fen()) return;
    const f = d.drill.info.famousGames[d.replayGame];
    const sfExtra = state.game.history().length - Math.min(d.replayPly, f.moves.length);
    if (state.game.game_over() || sfExtra >= DRILL_SF_MAX_PLIES) { d.sfContinue = false; return; }
    d.sfLastEval = formatEval(a);
    const mv = state.game.move({ from: a.bestUci.slice(0, 2), to: a.bestUci.slice(2, 4), promotion: a.bestUci[4] || "q" });
    if (!mv) { d.sfContinue = false; return; }
    state.lastMove = mv;
    d.sfLastSan = mv.san;
    if (state.game.game_over()) d.sfContinue = false;
    else requestAnalysis();
}

function drillReplayNext() {
    const d = state.drill;
    const f = d.drill.info.famousGames[d.replayGame];
    if (d.replayPly >= f.moves.length) return;
    const mv = state.game.move(f.moves[d.replayPly]);
    if (!mv) return;
    d.replayPly++;
    state.lastMove = mv;
    requestAnalysis();
    renderAll();
}

function drillReplayPrev() {
    const d = state.drill;
    const f = d.drill.info.famousGames[d.replayGame];
    const sfExtra = state.game.history().length - Math.min(d.replayPly, f.moves.length);
    if (sfExtra > 0) {
        // Сначала откатываются ходы доигрывания движка.
        d.sfContinue = false;
        state.game.undo();
    } else if (d.replayPly > 0) {
        state.game.undo();
        d.replayPly--;
    } else {
        return;
    }
    const h = state.game.history({ verbose: true });
    state.lastMove = h.length ? h[h.length - 1] : null;
    requestAnalysis();
    renderAll();
}

// ---------------- Панель анализа ----------------
function setEngineStatus(text) { $("engine-status").textContent = text; }

function renderEvalBar() {
    const a = state.analysis;
    const w = whiteCp(a);
    const fill = $("eval-fill");
    let pct = 50;
    if (w !== null) {
        // сигмоида: ±600 сп ≈ 90%
        pct = 100 / (1 + Math.exp(-w / 250));
        pct = Math.max(3, Math.min(97, pct));
    }
    // белые всегда снизу полоски, если игрок белый; иначе сверху
    fill.style.height = pct + "%";
    $("eval-label").textContent = a ? formatEval(a) : "…";
    const bar = $("eval-bar");
    bar.classList.toggle("flipped", isFlipped());
}

function renderRecommendation() {
    const box = $("recommend-box");
    if (state.mode === "puzzles") { renderPuzzlePanel(box); return; }
    if (state.mode === "theory") { renderTheoryPanel(box); return; }
    if (isDrillMode()) { renderDrillPanel(box); return; }
    if (state.mode === "casual") {
        // Честная игра: никаких подсказок — только статус бота.
        const level = DIFFICULTY_LEVELS[state.difficulty];
        const botTurn = !state.gameOver && state.game.turn() !== state.playerColor;
        box.innerHTML = `<h3>⚔️ Игра против Stockfish</h3>
            <p>Уровень: <b>${level.name}</b></p>
            <p class="${botTurn ? "muted" : "drill-your-turn"}">${state.gameOver ? "Партия окончена." : (botTurn ? "Бот думает…" : "Твой ход!")}</p>`;
        return;
    }
    const a = state.analysis;
    if (state.gameOver) { box.innerHTML = "<h3>Партия окончена</h3>"; return; }
    if (!a || !a.bestSan) {
        box.innerHTML = "<h3>Рекомендация Stockfish</h3><p class='muted'>Анализ позиции…</p>";
        return;
    }
    const turnName = a.turn === "w" ? "белых" : "чёрных";
    const pv = a.pvSan.slice(0, 6).map(sanToRu).join(" ");
    let html = `<h3>Рекомендация Stockfish <span class="muted">(ход ${turnName})</span></h3>
        <div class="rec-move">${sanToRu(a.bestSan)}</div>
        <div class="rec-meta">Оценка: <b>${formatEval(a)}</b> · глубина ${a.depth}${a.done ? "" : " · думает…"}</div>
        <div class="rec-pv">Главная линия: ${pv || "…"}</div>`;
    if (state.mode === "training") {
        const recVerbose = uciToVerbose(a.fen, a.bestUci);
        if (recVerbose) {
            const historyIfPlayed = state.game.history().concat([recVerbose.san]);
            const op = openingForLastMove(historyIfPlayed);
            if (op) {
                html += `<div class="rec-theory"><b>${op.name}.</b> ${op.idea}<div class="book-ref">📖 ${op.book}</div></div>`;
            }
        }
    }
    box.innerHTML = html;
}

function renderReview() {
    const box = $("review-box");
    const r = state.lastMoveReview;
    if (!r) {
        box.innerHTML = state.mode === "training"
            ? "<h3>Разбор хода</h3><p class='muted'>Сделайте ход — здесь появится разбор с теорией.</p>"
            : "";
        return;
    }
    if (state.mode !== "training") { box.innerHTML = ""; return; }

    const colorName = r.color === "w" ? "белых" : "чёрных";
    const isOpponent = r.color !== state.playerColor;
    const who = isOpponent ? `Ход противника (${colorName})` : `Ваш ход (${colorName})`;
    let html = `<h3>Разбор: ${r.moveNumber}. ${sanToRu(r.san)} <span class="muted">— ${who}</span></h3>`;

    // Качество
    html += `<div class="quality ${r.quality.cls}"><b>${r.quality.label}.</b> ${r.quality.detail}`;
    if (!r.matchedBest && r.recommendedSan) {
        html += ` Рекомендовался ${sanToRu(r.recommendedSan)}.`;
    }
    html += `</div>`;

    // Дебютная теория
    if (r.opening) {
        html += `<div class="theory"><div class="theory-name">${r.opening.name}</div>
            <p><b>Зачем этот ход:</b> ${r.opening.idea}</p>
            <p><b>Перспектива:</b> ${r.opening.plan}</p>
            <div class="book-ref">📖 ${r.opening.book}</div></div>`;
    } else if (r.openingCtx) {
        html += `<div class="theory theory-ctx">Партия развивается из: <b>${r.openingCtx.entry.name}</b> (теоретические ходы закончились на ${r.openingCtx.depth}-м полуходу).</div>`;
    }

    // Эвристические наблюдения
    html += `<div class="notes"><div class="phase">Стадия: ${PHASE_NAMES_RU[r.phase]}</div><ul>`;
    r.notes.forEach((n, ni) => {
        html += `<li>${n.text}`;
        if (n.principle) {
            // Сноска ротируется по номеру хода — цитаты не повторяются подряд.
            html += `<div class="principle">${n.principle.text}<div class="book-ref">📖 ${principleBook(n.principle, r.moveNumber + ni)}</div></div>`;
        }
        html += `</li>`;
    });
    html += `</ul></div>`;

    // Перспектива по движку
    if (r.planSan && r.planSan.length) {
        html += `<div class="engine-plan"><b>Дальнейшая перспектива (линия движка):</b> ${r.planSan.map(sanToRu).join(" ")}`;
        if (r.evalAfterText) html += ` <span class="muted">(оценка ${r.evalAfterText})</span>`;
        html += `</div>`;
    }
    box.innerHTML = html;
}

/** Русская форма множественного числа: ruPlural(3, PIECE_RU_FORMS.p) → «пешки». */
function ruPlural(n, forms) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
}

/**
 * Панели съеденных фигур (сверху — соперник, снизу — игрок) и материального
 * преимущества: у кого перевес по типу фигур — у того и подпись («+1 пешка»).
 */
function renderCaptured() {
    // Кто что съел — из истории партии.
    const capturedBy = { w: [], b: [] };
    for (const mv of state.game.history({ verbose: true })) {
        if (mv.captured) capturedBy[mv.color].push(mv.captured);
    }
    // Остаток материала — с живой доски (промоции учитываются сами собой).
    const remaining = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const row of state.game.board()) {
        for (const cell of row) {
            if (cell && cell.type !== "k") remaining[cell.color][cell.type]++;
        }
    }
    const order = ["q", "r", "b", "n", "p"];
    const advantage = { w: [], b: [] };
    for (const t of order) {
        const d = remaining.w[t] - remaining.b[t];
        if (d > 0) advantage.w.push({ t, n: d });
        else if (d < 0) advantage.b.push({ t, n: -d });
    }
    const equal = advantage.w.length === 0 && advantage.b.length === 0;
    const topColor = state.playerColor === "w" ? "b" : "w";
    renderCapturedBar($("captured-top"), topColor, capturedBy, advantage, equal);
    renderCapturedBar($("captured-bottom"), state.playerColor, capturedBy, advantage, equal);
}

function renderCapturedBar(el, color, capturedBy, advantage, equal) {
    const enemy = color === "w" ? "b" : "w";
    const glyphs = capturedBy[color]
        .slice()
        .sort((a, b) => PIECE_VALUES[b] - PIECE_VALUES[a])
        .map((t) => UNICODE_PIECES[enemy][t])
        .join("");
    const sideName = color === "w" ? "Белые" : "Чёрные";
    let advHtml = "";
    if (equal) {
        advHtml = `<span class="cap-equal">${EQUAL_MATERIAL_TEXT}</span>`;
    } else if (advantage[color].length) {
        const parts = advantage[color].map((a) => `+${a.n} ${ruPlural(a.n, PIECE_RU_FORMS[a.t])}`);
        advHtml = `<span class="cap-adv">${parts.join(", ")}</span>`;
    }
    // Плашка-лоток видна всегда, даже пустая — у обеих сторон.
    const glyphHtml = `<span class="cap-glyphs ${enemy === "w" ? "white-piece" : "black-piece"}">${glyphs}</span>`;
    el.innerHTML = `<span class="cap-side">${sideName}:</span>` + glyphHtml + advHtml;
}

/**
 * Дебюты из базы openings.js, в которые можно выйти СЛЕДУЮЩИМ ходом.
 * Пустая история исключена — иначе это был бы список всех первых ходов.
 */
function nextMoveOpenings(history) {
    if (history.length === 0) return [];
    const res = [];
    for (const key in OPENINGS) {
        const toks = key.split(" ");
        if (toks.length !== history.length + 1) continue;
        if (history.every((m, i) => toks[i] === m)) {
            res.push({ move: toks[toks.length - 1], name: OPENINGS[key].name });
        }
    }
    return res;
}

/**
 * Виджет под доской (все режимы): проценты побед в текущем дебюте
 * (по семейству позиции) + ожидаемый счёт за цвет игрока.
 * В фазе загадки тренировки имя дебюта скрыто — только цифры.
 */
function renderPosStats() {
    const box = $("pos-stats");
    const fam = findStrategy(state.game.history());
    const stats = statsForFamily(fam);
    if (!stats) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    // Имя дебюта скрывается только в ЗАГАДКЕ (drill); в learn-режиме секрета нет.
    const hideName = state.mode === "drill" && state.drill && !state.drill.teach && state.drill.phase === "quiz";
    const myScore = expectedScoreForColor(stats, state.playerColor).toFixed(0);
    box.innerHTML = `<span class="ps-name">${hideName ? "Позиция (дебют скрыт)" : fam.name}</span>
        <span class="ps-bar">
            <span class="seg seg-w" style="width:${stats.w}%"></span>
            <span class="seg seg-d" style="width:${stats.d}%"></span>
            <span class="seg seg-b" style="width:${stats.b}%"></span>
        </span>
        <span class="ps-nums">${stats.w}·${stats.d}·${stats.b}</span>
        <span class="ps-score">за вас: <b>${myScore}%</b></span>`;
}

/**
 * Статичная мини-доска позиции fen (диаграмма). flipped=true — снизу чёрные.
 * sizeClass: "mini-lg" (модалка) | "mini-sm" (списки).
 */
function miniBoardHtml(fen, flipped, sizeClass) {
    const tmp = new Chess(fen);
    const rows = tmp.board(); // rows[0] — 8-я горизонталь
    let cells = "";
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const rr = flipped ? 7 - r : r;
            const cc = flipped ? 7 - c : c;
            const piece = rows[rr][cc];
            const dark = (rr + cc) % 2 === 1;
            const glyph = piece ? UNICODE_PIECES[piece.color][piece.type] : "";
            const colorCls = piece ? (piece.color === "w" ? "mw" : "mb") : "";
            cells += `<span class="mc ${dark ? "md" : "ml"} ${colorCls}">${glyph}</span>`;
        }
    }
    return `<span class="mini-board ${sizeClass || ""}">${cells}</span>`;
}

/** Панель самоучителя: дебют партии, глобальная стратегия за игрока и план соперника. */
function renderTutor() {
    const box = $("tutor-box");
    if (state.mode !== "tutor") { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");

    const history = state.game.history();
    const fam = findStrategy(history);
    let html = "<h3>🧭 Самоучитель дебютов</h3>";

    if (!fam) {
        html += "<p class='muted'>Дебют определится после первых ходов. Сделайте ход или нажмите «Ходи».</p>";
        box.innerHTML = html;
        return;
    }

    html += `<div class="strat-opening">${fam.name}</div>`;
    const variation = findOpening(history);
    if (variation && variation.entry.name !== fam.name) {
        html += `<div class="strat-variation">Текущий вариант: ${variation.entry.name}</div>`;
    }
    html += `<p class="strat-summary">${fam.summary}</p>`;

    // Статистика текущего дебюта: белые/ничьи/чёрные + ожидаемый счёт игрока.
    const stats = statsForFamily(fam);
    if (stats) {
        const myScore = expectedScoreForColor(stats, state.playerColor).toFixed(0);
        html += `<div class="stats-block">
            <div class="stats-bar">
                <div class="seg seg-w" style="width:${stats.w}%">${stats.w}%</div>
                <div class="seg seg-d" style="width:${stats.d}%">${stats.d}%</div>
                <div class="seg seg-b" style="width:${stats.b}%">${stats.b}%</div>
            </div>
            <div class="stats-caption">победы белых · ничьи · победы чёрных <span class="muted">(мастерские базы, округлённо)</span></div>
            <div class="stats-mine">Ожидаемый счёт за вас (${state.playerColor === "w" ? "белые" : "чёрные"}): <b>${myScore}%</b></div>
        </div>`;
    }

    const iAmWhite = state.playerColor === "w";
    const mine = iAmWhite ? fam.white : fam.black;
    const theirs = iAmWhite ? fam.black : fam.white;
    html += `<div class="strat-side strat-mine"><b>Ваш план (${iAmWhite ? "белые" : "чёрные"}):</b> ${mine}</div>`;
    html += `<div class="strat-side strat-theirs"><b>План соперника (${iAmWhite ? "чёрные" : "белые"}):</b> ${theirs}</div>`;

    if (fam.keys && fam.keys.length) {
        html += `<div class="strat-keys"><b>Ориентиры:</b><ul>`
            + fam.keys.map((k) => `<li>${k}</li>`).join("")
            + `</ul></div>`;
    }
    const nexts = nextMoveOpenings(history);
    if (nexts.length) {
        // Каждому выходу — ожидаемый счёт за того, чей ход; сортировка от лучшего.
        const moverColor = state.game.turn();
        const turnName = moverColor === "w" ? "белых" : "чёрных";
        const scored = nexts.map((n) => {
            const nextFam = findStrategy(history.concat([n.move]));
            const st = statsForFamily(nextFam);
            return { ...n, score: st ? expectedScoreForColor(st, moverColor) : null };
        });
        scored.sort((a, b) => (b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score));
        const items = scored.map((n, i) => {
            const crown = i === 0 && n.score !== null && scored.length > 1 ? "🏆 " : "";
            const scoreHtml = n.score !== null
                ? ` <span class="next-score">· счёт ${turnName} ${n.score.toFixed(0)}%</span>` : "";
            return `<li>${crown}<span class="next-move">${sanToRu(n.move)}</span> — ${n.name}${scoreHtml}</li>`;
        });
        html += `<div class="strat-next"><b>Выходы следующим ходом (${turnName}), от лучшего по статистике:</b><ul>`
            + items.join("") + `</ul></div>`;
    }
    box.innerHTML = html;
}

function renderHistory() {
    const box = $("history-box");
    const hist = state.game.history();
    let html = "";
    for (let i = 0; i < hist.length; i += 2) {
        const n = i / 2 + 1;
        html += `<span class="mv-num">${n}.</span> <span class="mv">${sanToRu(hist[i])}</span> `;
        if (hist[i + 1]) html += `<span class="mv">${sanToRu(hist[i + 1])}</span> `;
    }
    box.innerHTML = html || "<span class='muted'>Ходов пока нет.</span>";
    box.scrollTop = box.scrollHeight;
}

function renderTurnIndicator() {
    if (state.mode === "theory") { $("turn-indicator").textContent = "Учебник — доска-иллюстрация"; return; }
    if (state.mode === "puzzles") {
        $("turn-indicator").textContent = state.puzzle && state.puzzle.solved ? "Решено!" : "Найди лучший ход";
        return;
    }
    if (state.gameOver) { $("turn-indicator").textContent = ""; return; }
    const turn = state.game.turn();
    const name = turn === "w" ? "белых" : "чёрных";
    if (isDrillMode()) {
        const d = state.drill;
        if (!d || d.phase !== "quiz") { $("turn-indicator").textContent = ""; return; }
        $("turn-indicator").textContent = drillShouldAuto() ? "Ходит тренажёр…" : `Ход ${name} — вы`;
        return;
    }
    const yours = turn === state.playerColor
        ? " (вы)"
        : (state.mode === "casual" ? " (бот думает…)" : " (противник — жми «Ход Stockfish»)");
    $("turn-indicator").textContent = `Ход ${name}${yours}`;
}

function renderAll() {
    renderBoard();
    renderCaptured();
    renderPosStats();
    renderEvalBar();
    renderRecommendation();
    renderReview();
    renderTutor();
    renderHistory();
    renderTurnIndicator();
}

// ---------------- Настройка партии ----------------
function startGame() {
    state.playerColor = document.querySelector("input[name='color']:checked").value;
    // «Дебюты» — зонтичный пункт: реальный режим выбирается на шаге 3.
    const topMode = document.querySelector("input[name='mode']:checked").value;
    state.openingsFlow = topMode === "openings";
    state.mode = state.openingsFlow
        ? document.querySelector("input[name='openings-submode']:checked").value
        : topMode;
    state.game = new Chess();
    state.selected = null;
    state.lastMove = null;
    state.lastMoveReview = null;
    state.gameOver = false;
    state.engineMoveRequested = false;
    $("setup-screen").classList.add("hidden");
    $("game-screen").classList.remove("hidden");
    $("game-status").classList.add("hidden");
    $("mode-badge").textContent = MODE_BADGES[state.mode];
    // Кнопки движка и полоса оценки: в тренировке дебютов раскрыли бы ответ,
    // в обычной игре — подсказки запрещены, бот ходит сам.
    const noEngineUi = isDrillMode() || state.mode === "casual" || state.mode === "puzzles" || state.mode === "theory";
    $("btn-engine-move").classList.toggle("hidden", noEngineUi);
    $("btn-undo").classList.toggle("hidden", isDrillMode() || state.mode === "puzzles" || state.mode === "theory");
    $("eval-bar").classList.toggle("hidden", noEngineUi);
    // Сила движка: в обычной игре — по выбранной сложности, иначе полная (для анализа).
    if (state.mode === "casual") {
        const diffRadio = document.querySelector("input[name='difficulty']:checked");
        state.difficulty = diffRadio ? diffRadio.value : "club";
        engine.configureStrength(state.difficulty);
        if (state.playerColor === "b") state.engineMoveRequested = true; // бот-белые начинают
    } else {
        engine.configureStrength(null);
    }
    if (state.mode === "puzzles") { startPuzzle(); return; }
    if (state.mode === "theory") { startTheory(); return; }
    if (state.mode === "learn") {
        // Учим выбранный дебют выбранным цветом.
        const chosen = DRILLS.find((x) => x.id === $("learn-opening").value) || DRILLS[0];
        startDrill(chosen, { teach: true, color: state.playerColor });
        return;
    }
    if (state.mode === "drill") {
        const forced = state.drillForceId ? DRILLS.find((x) => x.id === state.drillForceId) : null;
        state.drillForceId = null;
        if (state.openingsFlow) {
            // Тренируем ВЫБРАННЫЙ дебют выбранным цветом (по памяти).
            const chosen = DRILLS.find((x) => x.id === $("learn-opening").value) || DRILLS[0];
            startDrill(chosen, { color: state.playerColor });
        } else {
            startDrill(forced || pickDrill(null));
        }
        return;
    }
    state.drill = null;
    buildBoard();
    // «ucinewgame»/«stop» не шлём: обёртка SF18 не переносит команды во время
    // поиска, а хеш-таблица от прошлой партии анализу только помогает.
    requestAnalysis();
    renderAll();
}

function backToSetup() {
    $("game-screen").classList.add("hidden");
    $("setup-screen").classList.remove("hidden");
    // Всегда возвращаемся на шаг 1 (выбор режима).
    $("setup-step1").classList.remove("hidden");
    $("setup-step2").classList.add("hidden");
    $("setup-step3").classList.add("hidden");
}

/** Шаг 1 → шаг 2: параметры режима (для «Дебютов» — сначала дебют+цвет, потом шаг 3). */
function setupContinue() {
    const mode = document.querySelector("input[name='mode']:checked").value;
    if (mode === "puzzles" || mode === "theory") { startGame(); return; } // параметров нет
    $("learn-picker").classList.toggle("hidden", mode !== "openings");
    $("difficulty-fieldset").classList.toggle("hidden", mode !== "casual");
    $("btn-start").classList.toggle("hidden", mode === "openings");
    $("btn-continue2").classList.toggle("hidden", mode !== "openings");
    $("setup-hint").textContent = MODE_HINTS[mode] || "";
    $("setup-step1").classList.add("hidden");
    $("setup-step2").classList.remove("hidden");
    if (mode === "openings") renderLearnPreview();
}

/** Превью выбранного дебюта: диаграмма финальной позиции линии + шансы за оба цвета. */
function renderLearnPreview() {
    const box = $("learn-preview");
    const drillObj = DRILLS.find((x) => x.id === $("learn-opening").value) || DRILLS[0];
    const color = document.querySelector("input[name='color']:checked").value;
    const tmp = new Chess();
    drillObj.line.forEach((m) => tmp.move(m));
    let html = miniBoardHtml(tmp.fen(), color === "b", "mini-lg")
        + `<div class="stats-caption">К этой позиции ведёт линия (после ${Math.ceil(drillObj.line.length / 2)}-го хода); вы — снизу</div>`;
    // Шансы дебюта: помогают осознанно выбрать цвет.
    const stats = FAMILY_STATS[drillObj.info.statsFamily];
    if (stats) {
        const wScore = expectedScoreForColor(stats, "w").toFixed(0);
        const bScore = expectedScoreForColor(stats, "b").toFixed(0);
        html += `<div class="stats-bar learn-stats-bar">
                <div class="seg seg-w" style="width:${stats.w}%">${stats.w}%</div>
                <div class="seg seg-d" style="width:${stats.d}%">${stats.d}%</div>
                <div class="seg seg-b" style="width:${stats.b}%">${stats.b}%</div>
            </div>
            <div class="stats-caption">победы белых · ничьи · победы чёрных <span class="muted">(мастерские базы)</span></div>
            <div class="stats-mine">Ожидаемый счёт: за белых <b class="${color === "w" ? "learn-my-color" : ""}">${wScore}%</b> · за чёрных <b class="${color === "b" ? "learn-my-color" : ""}">${bScore}%</b></div>`;
    }
    box.innerHTML = html;
}

// ---------------- Инициализация ----------------
document.addEventListener("DOMContentLoaded", () => {
    $("btn-start").addEventListener("click", startGame);
    $("btn-start3").addEventListener("click", startGame);
    $("btn-continue").addEventListener("click", setupContinue);
    $("btn-continue2").addEventListener("click", () => {
        $("setup-step2").classList.add("hidden");
        $("setup-step3").classList.remove("hidden");
    });
    $("btn-back-step").addEventListener("click", () => {
        $("setup-step2").classList.add("hidden");
        $("setup-step1").classList.remove("hidden");
    });
    $("btn-back-step3").addEventListener("click", () => {
        $("setup-step3").classList.add("hidden");
        $("setup-step2").classList.remove("hidden");
    });
    // Табы панели: Анализ / Ходы.
    document.querySelectorAll(".ptab").forEach((t) => t.addEventListener("click", () => {
        document.querySelectorAll(".ptab").forEach((x) => x.classList.toggle("active", x === t));
        $("tab-analysis").classList.toggle("hidden", t.dataset.tab !== "analysis");
        $("tab-moves").classList.toggle("hidden", t.dataset.tab !== "moves");
    }));
    $("btn-engine-move").addEventListener("click", onEngineMoveClick);
    $("btn-undo").addEventListener("click", undoMove);
    $("btn-new-game").addEventListener("click", backToSetup);
    // Список дебютов для режима обучения + живое превью позиции.
    $("learn-opening").innerHTML = DRILLS.map((x) => `<option value="${x.id}">${x.info.name}</option>`).join("");
    $("learn-opening").addEventListener("change", renderLearnPreview);
    document.querySelectorAll("input[name='color']").forEach((r) =>
        r.addEventListener("change", () => {
            if (!$("learn-picker").classList.contains("hidden")) renderLearnPreview();
        }));
    renderRatingBadge();
    $("btn-cloud-save").addEventListener("click", cloudSave);
    $("btn-cloud-load").addEventListener("click", cloudLoad);
    setEngineStatus("Загрузка движка…");
    engine.init();

    // Доступ из консоли браузера — отладка и автотесты.
    window.WebChess = { state, engine };

    // Быстрый старт по URL: ?autostart=1&color=b&mode=training
    const params = new URLSearchParams(location.search);
    if (params.get("autostart") === "1") {
        const color = params.get("color") === "b" ? "b" : "w";
        const modeParam = params.get("mode");
        const mode = (modeParam === "casual" || modeParam === "tutor" || modeParam === "drill" || modeParam === "learn") ? modeParam : "training";
        if (params.get("drill")) {
            state.drillForceId = params.get("drill");
            $("learn-opening").value = params.get("drill");
        }
        const diffParam = params.get("difficulty");
        if (diffParam && DIFFICULTY_LEVELS[diffParam]) {
            document.querySelector(`input[name='difficulty'][value='${diffParam}']`).checked = true;
        }
        document.querySelector(`input[name='color'][value='${color}']`).checked = true;
        // Дебютные режимы в UI живут под зонтиком «Дебюты» — радио выставляются парой.
        if (mode === "learn" || mode === "drill" || mode === "tutor") {
            document.querySelector("input[name='mode'][value='openings']").checked = true;
            document.querySelector(`input[name='openings-submode'][value='${mode}']`).checked = true;
        } else {
            document.querySelector(`input[name='mode'][value='${mode}']`).checked = true;
        }
        startGame();
    }
});
