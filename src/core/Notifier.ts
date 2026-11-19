import { setTimeout as sleep } from 'node:timers/promises';
import { BaseBotController, Bot } from 'umbot';
import { participantLabel } from '../texts';
import { A, addButtons, btn, IButton } from '../ui';
import { Store } from './Store';
import { IRoom, IUserRef, TDelivery } from './types';

/** Сообщение человеку, который сейчас не пишет боту. Готово к отправке. */
export interface IOutgoing {
    roomId: string;
    to: IUserRef;
    /** participants.id получателя — для учёта доставки */
    participantId?: string;
    text: string;
    buttons: IButton[];
    /** Записать результат в participants.delivery и прислать организатору отчёт */
    track: boolean;
}

/** Запись статуса доставки: выполняется ядром под блокировкой комнаты. */
export type TMarkDelivery = (
    roomId: string,
    participantId: string,
    delivery: TDelivery,
) => Promise<void>;

/**
 * Рассылка: тонкая обёртка над bot.send(). Бот пишет первым только тому, кто
 * сейчас не пишет ему: уведомления, результаты главного действия режима,
 * сообщения по расписанию и анонимные сообщения.
 *
 * @example
 * ```ts
 * const notifier = new Notifier(bot, store, { delayMs: 100 });
 * await notifier.send({ platform: 'telegram', userId: '42' }, 'Привет!');
 * ```
 */
export class Notifier {
    readonly #bot: Bot;
    readonly #store: Store;
    readonly #delayMs: number;
    readonly #pending = new Set<Promise<void>>();

    /**
     * @param bot Бот, через который уходят сообщения
     * @param store Хранилище — для отчёта о доставке
     * @param options delayMs — пауза между сообщениями рассылки, чтобы не упереться в лимиты платформ
     */
    constructor(bot: Bot, store: Store, options: { delayMs: number }) {
        this.#bot = bot;
        this.#store = store;
        this.#delayMs = options.delayMs;
    }

    /**
     * Отправляет сообщение человеку в его мессенджер.
     * bot.send() возвращает false, если платформа не приняла сообщение (ошибка API,
     * человек заблокировал бота) или не может написать первым (Алиса).
     *
     * @param to Получатель
     * @param text Текст без разметки
     * @param buttons Кнопки
     * @returns false, если отправить не удалось
     */
    async send(to: IUserRef, text: string, buttons: readonly IButton[] = []): Promise<boolean> {
        const appContext = this.#bot.getAppContext();
        try {
            const controller = new BaseBotController(appContext);
            controller.text = text;
            addButtons(controller.buttons, buttons);
            return (await this.#bot.send(to.userId, controller, to.platform)) !== false;
        } catch (e) {
            appContext.logError('Notifier.send(): сообщение не отправлено', {
                platform: to.platform,
                error: e instanceof Error ? e.message : String(e),
            });
            return false;
        }
    }

    /**
     * Отправляет сообщения по одному с паузой. Сбой одного не останавливает остальные.
     * Для отслеживаемых сообщений записывает статус доставки и после рассылки
     * присылает организатору отчёт.
     *
     * @param room Комната
     * @param outgoing Сообщения
     * @param markDelivery Запись статуса доставки
     */
    async deliver(
        room: IRoom,
        outgoing: readonly IOutgoing[],
        markDelivery: TMarkDelivery,
    ): Promise<void> {
        for (const [i, message] of outgoing.entries()) {
            if (i > 0 && this.#delayMs > 0) {
                await sleep(this.#delayMs);
            }
            const sent = await this.send(message.to, message.text, message.buttons);
            if (message.track && message.participantId) {
                await markDelivery(message.roomId, message.participantId, sent ? 'sent' : 'failed');
            }
        }
        if (outgoing.some((m) => m.track)) {
            await this.#report(room);
        }
    }

    async #report(room: IRoom): Promise<void> {
        const participants = (await this.#store.participantsOf(room.id)).filter(
            (p) => p.userId && p.delivery,
        );
        const failed = participants.filter((p) => p.delivery === 'failed');
        const lines = [
            `«${room.title}»: результаты отправлены ${participants.length - failed.length} из ${participants.length}.`,
        ];
        if (failed.length) {
            lines.push(`Не доставлено: ${failed.map(participantLabel).join(', ')}.`);
            const pushable = failed.filter((p) => p.platform !== 'alisa');
            if (pushable.length) {
                lines.push('Попросите их написать боту, затем нажмите «Повторить отправку».');
            }
            if (failed.some((p) => p.platform === 'alisa')) {
                lines.push(
                    'Участникам Алисы повторная отправка не нужна: они увидят результаты в карточке игры.',
                );
            }
        }
        await this.send(
            { platform: room.ownerPlatform, userId: room.ownerUserId },
            lines.join('\n'),
            [btn('К игре', A.room, { r: room.id })],
        );
    }

    /**
     * Запускает задачу после ответа на вебхук: платформы недолго ждут ответа и при
     * задержке повторяют запрос. Ошибка задачи пишется в лог и не роняет процесс.
     *
     * @param task Задача
     */
    background(task: () => Promise<void>): void {
        const run: Promise<void> = task()
            .catch((e: unknown) => {
                this.#bot.getAppContext().logError('Notifier: фоновая рассылка упала', {
                    error: e instanceof Error ? e.message : String(e),
                });
            })
            .finally(() => this.#pending.delete(run));
        this.#pending.add(run);
    }

    /** Ждёт завершения всех фоновых рассылок — для тестов и остановки процесса. */
    async whenIdle(): Promise<void> {
        while (this.#pending.size) {
            await Promise.all([...this.#pending]);
        }
    }
}
