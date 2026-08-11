/**
 * База задач WebChess (режим «Задачи», рейтинг игрока).
 *
 * Каждая задача:
 *   id, fen      — позиция (ход стороны решающего),
 *   solution     — ПОЛНАЯ форсированная линия в SAN: ходы решающего и
 *                  единственные ответы соперника вперемешку,
 *   rating       — сложность (эло задачи), source — тема/учебник.
 * Все маты проверяются валидатором через chess.js (легальность + мат в конце).
 */
"use strict";

const PUZZLES = [
    // ---------- Мат в 1 (классические паттерны из учебников) ----------
    {
        id: "m1-backrank-r", fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
        solution: ["Ra8#"], rating: 800,
        title: "Мат в 1 ход", source: "Мат по последней горизонтали — азбука тактики (Тарраш: «форточка или беда»)",
    },
    {
        id: "m1-backrank-q", fen: "6k1/5ppp/8/8/8/8/5PPP/4Q1K1 w - - 0 1",
        solution: ["Qe8#"], rating: 800,
        title: "Мат в 1 ход", source: "Ферзь на последней горизонтали — король заперт своими пешками",
    },
    {
        id: "m1-smothered", fen: "6rk/6pp/7N/8/8/8/8/6K1 w - - 0 1",
        solution: ["Nf7#"], rating: 1000,
        title: "Мат в 1 ход", source: "Спёртый мат: король задушен собственными фигурами (паттерн Филидора)",
    },
    {
        id: "m1-q-rank", fen: "7k/6pp/8/8/8/8/8/K2Q4 w - - 0 1",
        solution: ["Qd8#"], rating: 850,
        title: "Мат в 1 ход", source: "Ферзь бьёт по открытой последней горизонтали",
    },
    {
        id: "m1-kr-edge", fen: "k7/8/1K6/8/8/8/8/7R w - - 0 1",
        solution: ["Rh8#"], rating: 900,
        title: "Мат в 1 ход", source: "Линейный мат ладьёй при поддержке короля — базовый эндшпиль",
    },
    {
        id: "m1-capture-mate", fen: "3q2k1/5ppp/8/8/8/8/8/3R2K1 w - - 0 1",
        solution: ["Rxd8#"], rating: 950,
        title: "Мат в 1 ход", source: "Взятие с матом: ферзь защищал последнюю горизонталь один",
    },
    {
        id: "m1-backrank-b", fen: "r5k1/5ppp/8/8/8/8/5PPP/Q5K1 w - - 0 1",
        solution: ["Qxa8#"], rating: 900,
        title: "Мат в 1 ход", source: "Незащищённая ладья на последней — взятие оказывается матом",
    },

    // ---------- Мат в 2 (форсированные, все ответы единственные) ----------
    {
        id: "m3-legal", fen: "rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1",
        solution: ["Nxe5", "Bxd1", "Bxf7+", "Ke7", "Nd5#"], rating: 1500,
        title: "Мат в 3 хода", source: "Мат Легаля (Париж, 1750): «жертва» ферзя, которую нельзя принимать",
    },
    {
        id: "m2-deflect", fen: "2r3k1/5ppp/8/8/Q7/8/5PPP/4R1K1 w - - 0 1",
        solution: ["Re8+", "Rxe8", "Qxe8#"], rating: 1450,
        title: "Мат в 2 хода", source: "Отвлечение защитника: ладья жертвуется, ферзь добивает",
    },
    {
        id: "m2-smothered", fen: "r5rk/6pp/7N/8/2Q5/8/8/6K1 w - - 0 1",
        solution: ["Qxg8+", "Rxg8", "Nf7#"], rating: 1600,
        title: "Мат в 2 хода", source: "Полный спёртый мат: жертва ферзя на g8 и конь с f7 (Греко, 1620)",
    },

    // ---------- Тактика (один лучший ход) ----------
    {
        id: "t-fork-knight", fen: "3q3k/8/8/6N1/8/8/8/K7 w - - 0 1",
        solution: ["Nf7+"], rating: 1100,
        title: "Выиграй ферзя", source: "Королевская вилка конём: шах + нападение на ферзя",
    },
    {
        id: "t-hanging", fen: "6k1/6pp/8/3n4/8/8/6PP/3R2K1 w - - 0 1",
        solution: ["Rxd5"], rating: 900,
        title: "Найди зевок соперника", source: "Висячая фигура: конь остался без защиты",
    },
    {
        id: "t-double", fen: "r5k1/5ppp/8/8/8/8/5PPP/4Q1K1 w - - 0 1",
        solution: ["Qe4"], rating: 1250,
        title: "Двойной удар", source: "Ферзь нападает на две цели сразу — обе не защитить",
    },
];

const PUZZLE_STORAGE_KEY = "webchess_puzzles_solved";

/** Список решённых id из localStorage. */
function puzzlesSolvedIds() {
    try { return JSON.parse(localStorage.getItem(PUZZLE_STORAGE_KEY) || "[]"); }
    catch (e) { return []; }
}

function puzzleMarkSolved(id) {
    const ids = puzzlesSolvedIds();
    if (!ids.includes(id)) {
        ids.push(id);
        localStorage.setItem(PUZZLE_STORAGE_KEY, JSON.stringify(ids));
    }
}

/** Следующая задача: сначала нерешённые (случайно), потом любые. excludeId — не повторять подряд. */
function pickPuzzle(excludeId) {
    const solved = puzzlesSolvedIds();
    let pool = PUZZLES.filter((p) => !solved.includes(p.id) && p.id !== excludeId);
    if (!pool.length) pool = PUZZLES.filter((p) => p.id !== excludeId);
    if (!pool.length) pool = PUZZLES;
    return pool[Math.floor(Math.random() * pool.length)];
}
