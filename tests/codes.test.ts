import { CodeGuard, WRONG_CODES_PER_HOUR } from '../src/core/CodeGuard';
import { CODE_ALPHABET, CODE_LENGTH, generateCode, newId, parseCode } from '../src/core/codes';
import { A } from '../src/ui';

describe('коды комнат', () => {
    it('алфавит — 31 символ без I, L, O, 0 и 1', () => {
        expect(CODE_ALPHABET).toHaveLength(31);
        for (const char of 'ILO01') {
            expect(CODE_ALPHABET).not.toContain(char);
        }
    });

    it('generateCode выдаёт код из алфавита', () => {
        for (let i = 0; i < 1000; i++) {
            const code = generateCode();
            expect(code).toHaveLength(CODE_LENGTH);
            expect(parseCode(code)).toBe(code);
        }
    });

    it.each([
        ['k7m2qx', 'K7M2QX'],
        [' K7M2-QX ', 'K7M2QX'],
        ['/start K7M2QX', 'K7M2QX'],
        ['k 7 m 2 q x', 'K7M2QX'],
        ['💚K7M2QX', 'K7M2QX'], // регрессия: мусор вокруг кода вычищается
    ])('parseCode(%j) → %s', (text, code) => {
        expect(parseCode(text)).toBe(code);
    });

    it.each(['', 'K7M2Q', 'K7M2QXA', 'K7M2QO', 'привет', '/start'])(
        'parseCode(%j) → null',
        (text) => {
            expect(parseCode(text)).toBeNull();
        },
    );
});

describe('payload кнопок', () => {
    it('самая длинная кнопка укладывается в 64 байта callback_data Telegram', () => {
        const id = newId();
        expect(id).toHaveLength(10);
        // Действие режима с выбором варианта-участника: комната, id действия (до 6 символов), id участника
        for (const action of [A.act, A.actOk]) {
            const payload = JSON.stringify({ action, r: id, m: 'abcdef', x: newId() });
            expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(64);
        }
        const page = JSON.stringify({ action: A.members, r: id, pg: 16 });
        expect(Buffer.byteLength(page)).toBeLessThanOrEqual(64);
    });

    it('ни одно имя действия не входит в другое: addAction ищет имя и подстрокой', () => {
        const names = Object.values(A);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) {
            expect(names.filter((other) => other !== name && other.includes(name))).toEqual([]);
        }
    });
});

describe('CodeGuard', () => {
    it('блокирует после лимита неверных кодов на час', () => {
        let now = 0;
        const guard = new CodeGuard(() => now);
        const user = { platform: 'telegram', userId: '1' };
        for (let i = 0; i < WRONG_CODES_PER_HOUR; i++) {
            expect(guard.isBlocked(user)).toBe(false);
            guard.registerWrong(user);
        }
        expect(guard.isBlocked(user)).toBe(true);
        expect(guard.isBlocked({ platform: 'vk', userId: '1' })).toBe(false);
        now += 60 * 60 * 1000;
        expect(guard.isBlocked(user)).toBe(false);
    });
});
