/**
 * Объяснитель ходов WebChess.
 * Строит человеческое объяснение хода из:
 *  - эвристик (что ход делает на доске),
 *  - книжных принципов (сноски на классику),
 *  - данных движка (оценка, главная линия) — подмешиваются в app.js.
 */
"use strict";

// Пороги качества хода в сантипешках (потеря относительно лучшего хода).
const QUALITY_THRESHOLDS = {
    BEST_MATCH: 0,     // совпал с первой линией движка
    EXCELLENT: 25,     // потеря до 0.25 пешки
    GOOD: 60,
    INACCURACY: 120,
    MISTAKE: 250,      // дальше — зевок
};

// Принципы из книг, привязанные к типам ходов.
// У каждого принципа НЕСКОЛЬКО цитат разных авторов (books) — какая показать,
// выбирается по номеру хода (principleBook), чтобы сноски не повторялись подряд.
const PRINCIPLES = {
    development: {
        text: "В дебюте каждый ход должен способствовать развитию: фигура выходит на рабочую позицию и приближает рокировку.",
        books: [
            "Зигберт Тарраш — «Современная шахматная партия»: «Кто не развивается — погибает».",
            "Пол Морфи (по партиям): каждый дебютный ход — новая фигура в игре, с угрозой если возможно.",
            "Эмануил Ласкер — «Здравый смысл в шахматах»: до рокировки не начинайте операций.",
        ],
    },
    knightsBeforeBishops: {
        text: "Коней принято развивать раньше слонов: лучшее поле коня почти всегда известно (f3/c3), а слону выгодно подождать.",
        books: [
            "Эмануил Ласкер — «Здравый смысл в шахматах».",
            "Пауль Керес — «Теория шахматных дебютов»: определяйте слонов после того, как противник раскрыл план.",
        ],
    },
    castling: {
        text: "Рокировка решает две задачи сразу: король уходит из центра до вскрытия линий, а ладья входит в игру.",
        books: [
            "Хосе Рауль Капабланка — «Учебник шахматной игры»: сначала безопасность короля, потом активные операции.",
            "Вильгельм Стейниц (правила Стейница): король в центре — цель атаки; не откладывайте рокировку без причины.",
        ],
    },
    centerPawn: {
        text: "Пешки в центре дают фигурам пространство и отнимают поля у фигур противника.",
        books: [
            "Филидор (в пересказе Тарраша): «Пешки — душа шахмат»; центр — их главная работа.",
            "Зигберт Тарраш — «Современная шахматная партия»: сильный пешечный центр даёт фигурам дороги.",
        ],
    },
    centerControl: {
        text: "Контролировать центр можно и фигурами издалека — не обязательно занимать его пешками.",
        books: [
            "Арон Нимцович — «Моя система»: гипермодернистская трактовка центра.",
            "Рихард Рети — «Новые идеи в шахматах»: центр атакуют с фланга, когда он перерастянут.",
            "Джон Уотсон — «Секреты современной шахматной стратегии»: правила о центре — лишь ориентиры.",
        ],
    },
    openFile: {
        text: "Ладья реализует силу только на открытой или полуоткрытой вертикали — там она давит на пешки и тылы противника.",
        books: [
            "Зигберт Тарраш — «Современная шахматная партия»: ладьи принадлежат открытым линиям.",
            "Арон Нимцович — «Моя система»: открытая линия — плацдарм для вторжения на 7-ю горизонталь.",
        ],
    },
    seventhRank: {
        text: "Ладья на предпоследней горизонтали атакует пешки противника «сбоку» и запирает короля — часто это решает партию.",
        books: [
            "Арон Нимцович — «Моя система»: глава о 7-й и 8-й горизонталях.",
            "Хосе Рауль Капабланка (по партиям): сдвоенные ладьи на 7-й — «свиньи» — почти всегда выигрывают.",
        ],
    },
    earlyQueen: {
        text: "Ранний вывод ферзя рискован: лёгкие фигуры противника будут развиваться с темпом, нападая на него.",
        books: [
            "Эмануил Ласкер — «Здравый смысл в шахматах»: не выводите ферзя слишком рано.",
            "Пол Морфи (уроки его партий): гонитель ферзя развивается бесплатно.",
        ],
    },
    capture: {
        text: "Каждый размен должен иметь цель: выигрыш материала, устранение защитника, упрощение при перевесе или порча структуры противника.",
        books: [
            "Хосе Рауль Капабланка — «Учебник шахматной игры»: разменивайтесь, когда это ведёт к ясному эндшпилю в вашу пользу.",
            "Макс Эйве — «Стратегия и тактика»: размен — не ничейный жест, а инструмент плана.",
            "Тигран Петросян (по партиям): лишний размен обесценивает атаку противника.",
        ],
    },
    check: {
        text: "Шах ценен не сам по себе, а тем, что вынуждает: выигрывает темп, гонит короля или готовит комбинацию.",
        books: [
            "Александр Котов — «Как стать гроссмейстером»: форсирующие ходы считаются первыми.",
            "Савелий Тартаковер (афоризм): «Шах — не цель, а средство».",
        ],
    },
    pawnBreak: {
        text: "Пешечный подрыв — главный способ вскрыть игру: он бьёт по базе пешечной цепи или расчищает линии для фигур.",
        books: [
            "Арон Нимцович — «Моя система»: атакуйте пешечную цепь в её основании.",
            "Ханс Кмох — «Пешечная сила в шахматах»: рычаг (подрыв) — единственный способ пешек спорить с пешками.",
        ],
    },
    passedPawn: {
        text: "Проходную пешку необходимо продвигать — её надо блокировать, а стоимость блокады растёт с каждым шагом пешки.",
        books: [
            "Арон Нимцович — «Моя система»: «Проходную пешку следует держать под замком» — а свою двигать.",
            "Савелий Тартаковер (афоризм): «У проходной пешки — душа ферзя».",
        ],
    },
    endgameKing: {
        text: "В эндшпиле король — боевая фигура: его активность часто стоит целой пешки.",
        books: [
            "Хосе Рауль Капабланка — «Учебник шахматной игры»: в окончании король обязан идти в центр.",
            "Рубен Файн — «Основные шахматные окончания»: активность короля — первый принцип эндшпиля.",
        ],
    },
    promotion: {
        text: "Превращение — кульминация игры проходной пешки; почти всегда правильно превращать в ферзя.",
        books: [
            "Рубен Файн — «Основные шахматные окончания».",
            "Марк Дворецкий — «Учебник эндшпиля»: слабое превращение — только против пата и вилок.",
        ],
    },
    prophylaxis: {
        text: "Сильный ход не всегда нападает: часто он заранее отнимает у противника его лучшую возможность.",
        books: [
            "Арон Нимцович — «Моя система»: профилактика — основа позиционной игры.",
            "Тигран Петросян (по партиям): сначала отними чужой план — свой подождёт.",
            "Марк Дворецкий — «Позиционная игра»: вопрос «что хочет противник?» — перед каждым ходом.",
        ],
    },
    luft: {
        text: "«Форточка» для короля исключает мат по последней горизонтали — типовую катастрофу даже в выигранных позициях.",
        books: [
            "Зигберт Тарраш — «Современная шахматная партия».",
            "Савелий Тартаковер (афоризм): «Все партии проигрываются из-за последней горизонтали… кроме остальных».",
        ],
    },
};

/** Цитата принципа с ротацией: одна и та же сноска не повторяется ход за ходом. */
function principleBook(principle, seed) {
    if (!principle || !principle.books) return "";
    return principle.books[Math.abs(seed) % principle.books.length];
}

/** Начальные поля лёгких и тяжёлых фигур для детекции «развития». */
const HOME_SQUARES = {
    w: { n: ["b1", "g1"], b: ["c1", "f1"], q: ["d1"], r: ["a1", "h1"] },
    b: { n: ["b8", "g8"], b: ["c8", "f8"], q: ["d8"], r: ["a8", "h8"] },
};

const CENTER_SQUARES = ["d4", "e4", "d5", "e5"];
const PIECE_NAMES_RU = { p: "пешка", n: "конь", b: "слон", r: "ладья", q: "ферзь", k: "король" };
const ENDGAME_PIECE_LIMIT = 12; // фигур на доске (не пешек+короли) меньше — считаем эндшпилем
const OPENING_MOVE_LIMIT = 10;  // полных ходов — до этого считаем дебютом

/** Фаза партии по позиции. */
function gamePhase(chess, moveNumber) {
    const board = chess.board().flat().filter(Boolean);
    const heavy = board.filter((p) => p.type !== "p" && p.type !== "k").length;
    if (heavy <= 6) return "endgame";
    if (moveNumber <= OPENING_MOVE_LIMIT && heavy >= 10) return "opening";
    return "middlegame";
}

/** Есть ли пешки цвета color на вертикали file. chessAfter — позиция после хода. */
function pawnsOnFile(chess, file, color) {
    for (let rank = 1; rank <= 8; rank++) {
        const piece = chess.get(file + rank);
        if (piece && piece.type === "p" && piece.color === color) return true;
    }
    return false;
}

/** Проходная ли пешка на square цвета color (упрощённо: нет чужих пешек впереди на своей и соседних вертикалях). */
function isPassedPawn(chess, square, color) {
    const file = square.charCodeAt(0);
    const rank = parseInt(square[1], 10);
    const dir = color === "w" ? 1 : -1;
    for (let f = file - 1; f <= file + 1; f++) {
        if (f < 97 || f > 104) continue;
        for (let r = rank + dir; r >= 1 && r <= 8; r += dir) {
            const piece = chess.get(String.fromCharCode(f) + r);
            if (piece && piece.type === "p" && piece.color !== color) return false;
        }
    }
    return true;
}

/**
 * Главная функция: собирает список наблюдений об уже сделанном ходе.
 * move — verbose-объект chess.js; chessAfter — позиция после хода.
 * Возвращает { notes: [{text, principle}], phase }.
 */
function explainMove(move, chessAfter, moveNumber) {
    const notes = [];
    const phase = gamePhase(chessAfter, moveNumber);
    const color = move.color;
    const pieceName = PIECE_NAMES_RU[move.piece];

    // --- Мат/шах ---
    if (chessAfter.in_checkmate()) {
        notes.push({ text: "Мат! Партия окончена.", principle: null });
        return { notes, phase };
    }
    if (chessAfter.in_check()) {
        notes.push({
            text: "Шах: король обязан реагировать — ход выигрывает темп и ограничивает выбор противника.",
            principle: PRINCIPLES.check,
        });
    }

    // --- Рокировка ---
    if (move.san === "O-O" || move.san === "O-O-O") {
        const side = move.san === "O-O" ? "короткая" : "длинная";
        notes.push({
            text: `Рокировка (${side}): король уходит из центра до вскрытия линий, ладья мгновенно попадает в игру.`,
            principle: PRINCIPLES.castling,
        });
        return { notes, phase };
    }

    // --- Взятие ---
    if (move.captured) {
        notes.push({
            text: `Взятие: ${pieceName} забирает ${PIECE_NAMES_RU[move.captured]} на ${move.to}.`,
            principle: PRINCIPLES.capture,
        });
    }

    // --- Превращение ---
    if (move.promotion) {
        notes.push({
            text: `Превращение пешки в ${PIECE_NAMES_RU[move.promotion]} — материальная кульминация проходной.`,
            principle: PRINCIPLES.promotion,
        });
    }

    // --- Пешечные ходы ---
    if (move.piece === "p" && !move.captured && !move.promotion) {
        if (CENTER_SQUARES.includes(move.to)) {
            notes.push({
                text: `Пешка занимает центр (${move.to}): открывает диагонали своим фигурам и отнимает поля у чужих.`,
                principle: PRINCIPLES.centerPawn,
            });
        } else if (phase !== "endgame") {
            notes.push({
                text: `Пешечный ход ${move.san}: меняет структуру — либо готовит подрыв, либо берёт под контроль ключевые поля.`,
                principle: PRINCIPLES.pawnBreak,
            });
        }
        if (isPassedPawn(chessAfter, move.to, color)) {
            notes.push({
                text: `Пешка ${move.to} — проходная: впереди нет чужих пешек, каждый её шаг повышает цену блокады.`,
                principle: PRINCIPLES.passedPawn,
            });
        }
        // «Форточка» — ход крайней пешкой около короля вне дебюта.
        const luftFiles = ["g", "h", "a", "b"];
        if (phase === "middlegame" && luftFiles.includes(move.from[0]) &&
            (move.from[1] === "2" || move.from[1] === "7")) {
            notes.push({
                text: "Заодно у короля появляется «форточка» — страховка от мата по последней горизонтали.",
                principle: PRINCIPLES.luft,
            });
        }
    }

    // --- Развитие лёгкой фигуры с начальной клетки ---
    if ((move.piece === "n" || move.piece === "b") &&
        HOME_SQUARES[color][move.piece].includes(move.from)) {
        const principle = move.piece === "n" ? PRINCIPLES.knightsBeforeBishops : PRINCIPLES.development;
        notes.push({
            text: `Развитие: ${pieceName} покидает начальную клетку и входит в игру — на один шаг ближе к рокировке.`,
            principle,
        });
    }

    // --- Контроль центра фигурой ---
    if (move.piece === "n" || move.piece === "b") {
        const attacked = CENTER_SQUARES.filter((sq) => {
            const moves = chessAfter.moves({ square: move.to, verbose: true });
            return moves.some((m) => m.to === sq);
        });
        if (attacked.length >= 2 && phase === "opening") {
            notes.push({
                text: `Фигура с ${move.to} держит под прицелом центральные поля (${attacked.join(", ")}).`,
                principle: PRINCIPLES.centerControl,
            });
        }
    }

    // --- Ладья на открытой/полуоткрытой линии ---
    if (move.piece === "r" || move.piece === "q") {
        const file = move.to[0];
        const own = pawnsOnFile(chessAfter, file, color);
        const enemy = pawnsOnFile(chessAfter, file, color === "w" ? "b" : "w");
        if (move.piece === "r" && !own) {
            const kind = enemy ? "полуоткрытую" : "открытую";
            notes.push({
                text: `Ладья становится на ${kind} вертикаль «${file}» — отсюда она давит вглубь позиции противника.`,
                principle: PRINCIPLES.openFile,
            });
        }
        const seventhRank = color === "w" ? "7" : "2";
        if (move.piece === "r" && move.to[1] === seventhRank) {
            notes.push({
                text: "Ладья вторгается на предпоследнюю горизонталь — классический решающий ресурс.",
                principle: PRINCIPLES.seventhRank,
            });
        }
    }

    // --- Ранний ферзь ---
    if (move.piece === "q" && phase === "opening" && HOME_SQUARES[color].q.includes(move.from)) {
        notes.push({
            text: "Ферзь выходит рано — это обязывает: противник может развиваться с темпом, нападая на него.",
            principle: PRINCIPLES.earlyQueen,
        });
    }

    // --- Король в эндшпиле ---
    if (move.piece === "k" && phase === "endgame") {
        notes.push({
            text: "Король активизируется — в эндшпиле это полноценная боевая фигура.",
            principle: PRINCIPLES.endgameKing,
        });
    }

    // --- Ничего специфичного не нашли ---
    if (notes.length === 0) {
        notes.push({
            text: `Манёвр: ${pieceName} переходит на ${move.to} — перегруппировка ради лучшей стоянки или профилактика планов противника.`,
            principle: PRINCIPLES.prophylaxis,
        });
    }

    return { notes, phase };
}

/** Классификация качества сыгранного хода по потере оценки (сп) и совпадению с лучшим. */
function classifyQuality(matchedBest, cpLoss) {
    if (matchedBest) {
        return { label: "Лучший ход", cls: "q-best", detail: "Совпадает с первой линией Stockfish." };
    }
    if (cpLoss === null || cpLoss === undefined) {
        return { label: "Ход сделан", cls: "q-none", detail: "Оценка уточняется…" };
    }
    if (cpLoss <= QUALITY_THRESHOLDS.EXCELLENT) {
        return { label: "Отличный ход", cls: "q-best", detail: "Практически не уступает лучшему." };
    }
    if (cpLoss <= QUALITY_THRESHOLDS.GOOD) {
        return { label: "Хороший ход", cls: "q-good", detail: `Потеря ≈ ${(cpLoss / 100).toFixed(2)} пешки относительно лучшего.` };
    }
    if (cpLoss <= QUALITY_THRESHOLDS.INACCURACY) {
        return { label: "Неточность", cls: "q-inacc", detail: `Уступает лучшему ходу ≈ ${(cpLoss / 100).toFixed(2)} пешки.` };
    }
    if (cpLoss <= QUALITY_THRESHOLDS.MISTAKE) {
        return { label: "Ошибка", cls: "q-mistake", detail: `Серьёзная потеря: ≈ ${(cpLoss / 100).toFixed(2)} пешки.` };
    }
    return { label: "Зевок", cls: "q-blunder", detail: `Потеря ≈ ${(cpLoss / 100).toFixed(2)} пешки — позиция резко ухудшилась.` };
}

const PHASE_NAMES_RU = { opening: "дебют", middlegame: "миттельшпиль", endgame: "эндшпиль" };
