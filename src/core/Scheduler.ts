import { Notifier } from './Notifier';
import { Relay } from './Relay';
import { RoomService } from './RoomService';

/** Запись ошибки в лог: appContext.logError. */
export type TLogError = (message: string, meta?: Record<string, unknown>) => void;

/**
 * Расписание: комнаты с наступившим rooms.nextRunAt → onSchedule режима,
 * плюс отложенные анонимные сообщения. Запускается из jobs/tick.ts по cron.
 * Сбой одной комнаты пишется в лог и не останавливает остальные.
 *
 * @example
 * ```ts
 * const { rooms, messages } = await scheduler.tick();
 * ```
 */
export class Scheduler {
    readonly #service: RoomService;
    readonly #relay: Relay;
    readonly #notifier: Notifier;
    readonly #logError: TLogError;

    constructor(service: RoomService, relay: Relay, notifier: Notifier, logError: TLogError) {
        this.#service = service;
        this.#relay = relay;
        this.#notifier = notifier;
        this.#logError = logError;
    }

    /**
     * Один проход расписания.
     *
     * @returns Сколько комнат обработано и сколько сообщений отправлено
     */
    async tick(): Promise<{ rooms: number; messages: number }> {
        const markDelivery = this.#service.markDelivery.bind(this.#service);
        let rooms = 0;
        let messages = 0;
        for (const roomId of await this.#service.dueRooms()) {
            try {
                const due = await this.#service.runSchedule(roomId);
                if (due) {
                    await this.#notifier.deliver(due.room, due.outgoing, markDelivery);
                    rooms++;
                    messages += due.outgoing.length;
                }
            } catch (e) {
                this.#logError('Scheduler: комната не обработана', {
                    roomId,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        for (const batch of await this.#relay.deliverDue()) {
            try {
                await this.#notifier.deliver(batch.room, batch.outgoing, markDelivery);
                messages += batch.outgoing.length;
            } catch (e) {
                // Сбой одной комнаты не отменяет доставку остальных до следующего тика
                this.#logError('Scheduler: отложенные сообщения не доставлены', {
                    roomId: batch.room.id,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return { rooms, messages };
    }
}
