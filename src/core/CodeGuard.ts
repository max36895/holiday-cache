import { IUserRef } from './types';

/** Неверных кодов в час на пользователя. */
export const WRONG_CODES_PER_HOUR = 10;
const WINDOW = 60 * 60 * 1000;
/**
 * Предел записей: на Алисе id задаёт отправитель запроса, и поток новых id
 * не должен бесконечно раздувать память. Сверх предела вытесняется самая старая запись.
 */
const MAX_USERS = 10_000;

interface IAttempts {
    count: number;
    windowStart: number;
}

/**
 * Ограничение подбора кодов комнат: не больше WRONG_CODES_PER_HOUR неверных кодов
 * в час на пользователя. Счётчики живут в памяти процесса бота: код вводят только в нём.
 *
 * @example
 * ```ts
 * if (guard.isBlocked(user)) return 'Слишком много попыток';
 * if (!room) guard.registerWrong(user);
 * ```
 */
export class CodeGuard {
    readonly #attempts = new Map<string, IAttempts>();
    readonly #now: () => number;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    #key(user: IUserRef): string {
        return `${user.platform}\u0000${user.userId}`;
    }

    #current(user: IUserRef): IAttempts | null {
        const attempts = this.#attempts.get(this.#key(user));
        if (!attempts || this.#now() - attempts.windowStart >= WINDOW) {
            return null;
        }
        return attempts;
    }

    /** Исчерпан ли лимит неверных кодов. */
    isBlocked(user: IUserRef): boolean {
        return (this.#current(user)?.count ?? 0) >= WRONG_CODES_PER_HOUR;
    }

    /** Сколько неверных кодов пользователь присылал за текущее окно. */
    attempts(user: IUserRef): number {
        return this.#current(user)?.count ?? 0;
    }

    /** Учитывает неверный код. */
    registerWrong(user: IUserRef): void {
        const key = this.#key(user);
        const current = this.#current(user);
        // Пересоздание записи переносит её в конец порядка вставки Map:
        // первой в Map всегда остаётся самая давняя.
        this.#attempts.delete(key);
        this.#attempts.set(key, {
            count: (current?.count ?? 0) + 1,
            windowStart: current?.windowStart ?? this.#now(),
        });
        if (this.#attempts.size > MAX_USERS) {
            const oldest = this.#attempts.keys().next().value;
            if (oldest !== undefined) {
                this.#attempts.delete(oldest);
            }
        }
    }
}
