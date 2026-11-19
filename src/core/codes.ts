import { randomBytes, randomInt } from 'node:crypto';

/**
 * Алфавит кода комнаты: цифры 2–9 и латиница без I, L, O — 31 символ,
 * которые трудно перепутать при наборе. 31^6 ≈ 887 млн комбинаций.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Длина кода комнаты. */
export const CODE_LENGTH = 6;

/**
 * Генерирует код комнаты на криптостойком генераторе.
 *
 * @returns Код из CODE_LENGTH символов CODE_ALPHABET
 */
export function generateCode(): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

/**
 * Достаёт код комнаты из текста пользователя: регистр, пробелы и дефисы не важны
 * («k7m2qx», «K7M2-QX», «/start K7M2QX»; Алиса может прислать «k 7 m 2 q x»).
 *
 * @param text Текст пользователя
 * @returns Код в верхнем регистре или null, если текст не похож на код
 */
export function parseCode(text: string | null | undefined): string | null {
    if (!text) {
        return null;
    }
    // Код выделяем из любого мусора вокруг: «💚K7M2QX», «k7m2-qx», «/start K7M2QX»
    const compact = text
        .replace(/^\/start\b/i, '')
        .replace(/[^0-9A-Za-z]/g, '')
        .toUpperCase();
    if (compact.length !== CODE_LENGTH) {
        return null;
    }
    for (const char of compact) {
        if (!CODE_ALPHABET.includes(char)) {
            return null;
        }
    }
    return compact;
}

/**
 * Похож ли текст на код комнаты: 6 латинских букв и цифр после уборки пробелов
 * и дефисов. Разбирается ли он как настоящий код — проверяет parseCode; здесь
 * ловим «похоже на код, но не код»: 0, 1 и буквы I, L, O в алфавите запрещены.
 *
 * @param text Текст пользователя
 * @returns true, если текст стоит показать пользователю подсказку про код
 */
export function isCodeLike(text: string | null | undefined): boolean {
    if (!text) {
        return false;
    }
    const compact = text
        .replace(/^\/start\b/i, '')
        .replace(/[^0-9A-Za-z]/g, '')
        .toUpperCase();
    return compact.length === CODE_LENGTH && /^[0-9A-Z]+$/.test(compact);
}

/**
 * Внутренний id записи: 10 символов base64url (56 бит случайности).
 * Короче UUID, чтобы payload кнопки с двумя id помещался в 64 байта callback_data Telegram.
 *
 * @returns Новый id
 */
export function newId(): string {
    return randomBytes(7).toString('base64url');
}
