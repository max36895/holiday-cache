import { setTimeout as sleep } from 'node:timers/promises';
import { AppContext } from 'umbot';
import { newId } from './codes';
import { TABLES } from './db';
import { Table } from './models';
import { RoomError } from './RoomError';

/** Сколько живёт аренда: столько процесс может держать комнату, если упал посреди операции. */
const LEASE_MS = 30_000;
/** Сколько ждать занятую комнату, прежде чем ответить пользователю «попробуйте ещё раз». */
const WAIT_MS = 5_000;
const RETRY_MS = 50;

/**
 * Блокировка комнаты: все изменения одной комнаты идут по очереди — и внутри процесса
 * бота, и между ботом и задачами cron (jobs/tick.ts). Внутри процесса — очередь промисов,
 * между процессами — аренда в таблице locks: строка с ключом комнаты, владельцем
 * и сроком. Занятый первичный ключ не даёт второму процессу вставить свою строку,
 * а снимается аренда только своим владельцем, поэтому чужую блокировку не удалить.
 *
 * Файловая БД umbot рассчитана на один процесс: с ней задачи cron запускают
 * при остановленном боте.
 *
 * @example
 * ```ts
 * await lock.run(room.id, async () => {
 *     const fresh = await repo.findRoom(room.id); // читать — уже внутри блокировки
 * });
 * ```
 */
export class RoomLock {
    readonly #queues = new Map<string, Promise<void>>();
    readonly #table: Table;
    readonly #owner = `${process.pid}-${newId()}`;
    readonly #appContext: AppContext;

    constructor(appContext: AppContext) {
        this.#appContext = appContext;
        this.#table = new Table(appContext, TABLES.locks, ['owner']);
    }

    /**
     * Выполняет fn, пока комната заблокирована этим процессом.
     *
     * @param roomId id комнаты
     * @param fn Операция с комнатой; читать данные комнаты нужно внутри неё
     * @returns Результат fn
     * @throws RoomError, если комната занята дольше WAIT_MS
     */
    run<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
        return this.#queue(roomId, async () => {
            const key = `room:${roomId}`;
            await this.#acquire(key);
            try {
                return await fn();
            } finally {
                await this.#release(key);
            }
        });
    }

    /**
     * Снимает аренду. Сбой записывается в лог, а не бросается: иначе он подменил бы
     * результат или ошибку самой операции. Не снятая аренда истечёт через LEASE_MS.
     */
    async #release(key: string): Promise<void> {
        try {
            await this.#table.remove({ key, owner: this.#owner, expiresAt: null });
        } catch (e) {
            this.#appContext.logError('RoomLock: не удалось снять блокировку комнаты', {
                key,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Очередь внутри процесса. Хвост очереди проглатывает ошибку: её уже получил
     * вызывающий fn, а следующая операция должна выполниться независимо от неё.
     */
    async #queue<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
        const run = (this.#queues.get(roomId) ?? Promise.resolve()).then(fn);
        const tail = run.then(
            () => undefined,
            () => undefined,
        );
        this.#queues.set(roomId, tail);
        try {
            return await run;
        } finally {
            if (this.#queues.get(roomId) === tail) {
                this.#queues.delete(roomId);
            }
        }
    }

    async #acquire(key: string): Promise<void> {
        const deadline = Date.now() + WAIT_MS;
        for (;;) {
            const now = new Date();
            const [held] = await this.#table.select({ key });
            if (!held) {
                const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
                if (await this.#table.insert({ key, owner: this.#owner, expiresAt })) {
                    return;
                }
            } else if ((held.expiresAt ?? '') < now.toISOString()) {
                // Аренда упавшего процесса: удаление с условием на владельца не тронет
                // строку, которую другой процесс успел занять после проверки
                try {
                    await this.#table.remove(held);
                } catch {
                    // Строку уже забрал другой процесс — попробуем занять в следующем проходе
                }
                continue;
            }
            if (Date.now() > deadline) {
                throw new RoomError('Игра сейчас занята другим действием. Попробуйте ещё раз.');
            }
            await sleep(RETRY_MS);
        }
    }
}
