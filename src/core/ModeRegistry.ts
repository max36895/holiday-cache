import { IMode } from '../modes/IMode';
import { RoomError } from './RoomError';
import { localDate } from './time';

/** Попадает ли дата MM-DD в сезон режима; сезон может переходить через Новый год. */
function inSeason(mode: IMode, monthDay: string): boolean {
    if (!mode.season) {
        return false;
    }
    const { from, to } = mode.season;
    return from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
}

/**
 * Реестр режимов: поиск по rooms.mode и порядок в меню.
 *
 * @example
 * ```ts
 * const registry = new ModeRegistry(MODES); // MODES — из modes/registry.ts
 * const mode = registry.get(room.mode);
 * ```
 */
export class ModeRegistry {
    readonly #modes: readonly IMode[];

    /**
     * @param modes Включённые режимы
     * @throws Error, если список пуст или id повторяются
     */
    constructor(modes: readonly IMode[]) {
        if (!modes.length || new Set(modes.map((m) => m.id)).size !== modes.length) {
            throw new Error('Нужен хотя бы один режим, id режимов не должны повторяться');
        }
        this.#modes = modes;
    }

    /** Все включённые режимы. */
    get all(): readonly IMode[] {
        return this.#modes;
    }

    /**
     * Режим комнаты.
     *
     * @param id rooms.mode
     * @returns Режим
     * @throws RoomError, если режим выключен: комнату без режима обработать нельзя
     */
    get(id: string): IMode {
        const mode = this.#modes.find((m) => m.id === id);
        if (!mode) {
            // RoomError, а не Error: пользователь видит понятный текст, а не
            // «Что-то пошло не так», а Scheduler логирует комнату без стека
            throw new RoomError('Эта игра временно недоступна.');
        }
        return mode;
    }

    /**
     * Режимы в порядке меню: в свой сезон режим идёт первым.
     *
     * @param now Текущее время
     * @param timezone Часовой пояс, в котором определяется сезон
     * @returns Режимы
     */
    menu(now: Date, timezone: string): IMode[] {
        const monthDay = localDate(now, timezone).slice(5);
        const seasonal = this.#modes.filter((m) => inSeason(m, monthDay));
        return [...seasonal, ...this.#modes.filter((m) => !seasonal.includes(m))];
    }
}
