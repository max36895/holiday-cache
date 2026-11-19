import { A, btn, IButton } from '../ui';
import { T } from '../texts';
import { newId } from './codes';
import { IOutgoing } from './Notifier';
import { RoomError } from './RoomError';
import { RoomLock } from './RoomLock';
import { IRoomView, RoomService } from './RoomService';
import { IParticipant, IRelay, IRoom, IUserRef } from './types';

/** Длина анонимного сообщения. */
export const RELAY_MAX = 500;

/** Итог отправки: что разослать сейчас и отложена ли доставка до времени режима. */
export interface IRelaySent {
    outgoing: IOutgoing[];
    scheduled: boolean;
}

/**
 * Анонимная пересылка между участниками комнаты. Направление задаёт режим
 * (IMode.relay): никому, дарителю → подопечному или любой → любому.
 * Получатель может ответить анонимно, пожаловаться организатору и заблокировать
 * автора. Отложенные сообщения (IMode.relayDeliverAt) доставляет jobs/tick.ts.
 * Текст хранится до удаления комнаты, чтобы организатор увидел его в жалобе;
 * «удалить мои данные» стирает сообщения автора и адресата.
 *
 * @example
 * ```ts
 * const { outgoing, scheduled } = await relay.send(user, roomId, toId, 'Что тебе подарить?');
 * ```
 */
export class Relay {
    readonly #service: RoomService;
    readonly #lock: RoomLock;

    constructor(service: RoomService, lock: RoomLock) {
        this.#service = service;
        this.#lock = lock;
    }

    /**
     * Кому пользователь может написать анонимно.
     *
     * @param view Комната глазами пользователя
     * @returns Получатели; пустой список — писать некому
     */
    targets(view: IRoomView): IParticipant[] {
        const { mode, room, me, participants } = view;
        const deadline = mode.relayDeadline?.(room);
        if (!me || room.status === 'finished' || (deadline && deadline <= view.now.toISOString())) {
            return [];
        }
        const active = participants.filter((p) => p.userId && p.id !== me.id);
        switch (mode.relay) {
            case 'giver-to-recipient':
                return room.status === 'closed'
                    ? active.filter((p) => p.id === me.recipientId)
                    : [];
            case 'any-to-any':
                return active;
            case 'none':
                return [];
        }
    }

    async #relay(relayId: string): Promise<IRelay> {
        const relay = await this.#service.store.findRelay(relayId);
        if (!relay) {
            throw new RoomError('Сообщение не найдено: игру удалили или срок хранения истёк.');
        }
        return relay;
    }

    /** Комната и сам пользователь — как адресат (toId) или автор (fromId) сообщения. */
    async #side(
        user: IUserRef,
        relay: IRelay,
        side: 'toId' | 'fromId',
    ): Promise<{ view: IRoomView; me: IParticipant }> {
        const view = await this.#service.view(user, relay.roomId);
        const me = view.me;
        if (!me || me.id !== relay[side]) {
            throw new RoomError('Это сообщение адресовано не вам.');
        }
        return { view, me };
    }

    /** Сообщение получателю; текст и кнопки — без единого признака автора. */
    #message(
        room: IRoom,
        relay: IRelay,
        to: IParticipant,
        replies: boolean,
        quote?: string,
    ): IOutgoing {
        const buttons: IButton[] = [
            ...(replies ? [btn('Ответить анонимно', A.reply, { x: relay.id })] : []),
            btn('Пожаловаться', A.report, { x: relay.id }),
            btn('Заблокировать', A.block, { x: relay.id }),
            btn('К игре', A.room, { r: room.id }),
        ];
        return {
            roomId: room.id,
            to: { platform: to.platform, userId: to.userId },
            participantId: to.id,
            text: `Анонимное сообщение в «${room.title}»:\n\n${relay.text}${
                quote ? `\n\nВ ответ на ваше сообщение:\n«${quote}»` : ''
            }`,
            buttons,
            track: false,
        };
    }

    /** Помечает сообщение доставленным и готовит его отправку. */
    async #deliver(view: IRoomView, relay: IRelay, quote?: string): Promise<IOutgoing[]> {
        const to = view.participants.find((p) => p.id === relay.toId && p.userId);
        await this.#service.store.saveRelay({ ...relay, status: 'sent' });
        if (!to) {
            return [];
        }
        return [
            this.#message(view.room, relay, to, view.mode.relayReplies?.(view.room) ?? true, quote),
        ];
    }

    async #create(
        view: IRoomView,
        from: IParticipant,
        toId: string,
        text: string,
        deliverAt: string,
        quote?: string,
    ): Promise<IRelaySent> {
        if (!text || text.length > RELAY_MAX) {
            throw new RoomError(`Сообщение — от 1 до ${RELAY_MAX} символов.`);
        }
        const now = this.#service.now().toISOString();
        const scheduled = deliverAt > now;
        // Заблокированный автор не узнаёт о блокировке: ответ тот же, но сообщения нет
        if (await this.#service.store.isBlocked(view.room.id, toId, from.id)) {
            return { outgoing: [], scheduled };
        }
        const relay: IRelay = {
            id: newId(),
            roomId: view.room.id,
            fromId: from.id,
            toId,
            text,
            deliverAt,
            status: 'pending',
            createdAt: now,
        };
        await this.#service.store.insertRelay(relay);
        return {
            outgoing: scheduled ? [] : await this.#deliver(view, relay, quote),
            scheduled,
        };
    }

    /**
     * Отправляет анонимное сообщение участнику.
     *
     * @param user Автор
     * @param roomId id комнаты
     * @param toId id получателя
     * @param text Текст
     * @returns Сообщения для рассылки и отложена ли доставка
     */
    async send(user: IUserRef, roomId: string, toId: string, text: string): Promise<IRelaySent> {
        return this.#lock.run(roomId, async () => {
            const view = await this.#service.view(user, roomId);
            const me = view.me;
            if (!me || !this.targets(view).some((p) => p.id === toId)) {
                throw new RoomError('Этому участнику сейчас нельзя написать.');
            }
            const limit = view.mode.relayLimit ?? Infinity;
            const mine = (await this.#service.store.relaysOf(roomId)).filter(
                (r) => r.fromId === me.id,
            );
            if (mine.length >= limit) {
                throw new RoomError(`Можно отправить не больше ${limit} сообщений в этой игре.`);
            }
            const now = this.#service.now().toISOString();
            return this.#create(view, me, toId, text, view.mode.relayDeliverAt?.(view.room) ?? now);
        });
    }

    /**
     * Проверяет до открытия мастера ответа, что сообщение существует, адресовано
     * пользователю и его автор ещё участвует: иначе человек пишет ответ и теряет
     * его с обманчивой ошибкой на финише.
     *
     * @param user Получатель исходного сообщения
     * @param relayId id исходного сообщения
     */
    async validateReply(user: IUserRef, relayId: string): Promise<void> {
        const relay = await this.#relay(relayId);
        const { view } = await this.#side(user, relay, 'toId');
        if (!(view.mode.relayReplies?.(view.room) ?? true) || view.room.status === 'finished') {
            throw new RoomError('Отвечать на анонимные сообщения в этой игре нельзя.');
        }
        this.#requireAuthor(view, relay);
    }

    /** Автор сообщения выбыл — отвечать некому, и ответ «успешно» улетел бы вникуда. */
    #requireAuthor(view: IRoomView, relay: IRelay): void {
        const author = view.participants.find((p) => p.id === relay.fromId);
        if (!author?.userId) {
            throw new RoomError(T.goneAuthor);
        }
    }

    /**
     * Анонимный ответ автору сообщения.
     *
     * @param user Получатель исходного сообщения
     * @param relayId id исходного сообщения
     * @param text Текст ответа
     * @returns Сообщения для рассылки
     */
    async reply(user: IUserRef, relayId: string, text: string): Promise<IOutgoing[]> {
        const relay = await this.#relay(relayId);
        return this.#lock.run(relay.roomId, async () => {
            const { view, me } = await this.#side(user, relay, 'toId');
            if (!(view.mode.relayReplies?.(view.room) ?? true) || view.room.status === 'finished') {
                throw new RoomError('Отвечать на анонимные сообщения в этой игре нельзя.');
            }
            this.#requireAuthor(view, relay);
            const now = this.#service.now().toISOString();
            // Автору показываем его исходный вопрос: ответов может быть несколько
            return (await this.#create(view, me, relay.fromId, text, now, relay.text)).outgoing;
        });
    }

    /**
     * Жалоба организатору: текст сообщения без автора, исключить автора
     * можно кнопкой в жалобе. Если автор — сам организатор, кнопки исключения
     * нет: жалоба остаётся сигналом, без ложного действия.
     *
     * @param user Получатель сообщения
     * @param relayId id сообщения
     * @returns Уведомление организатору
     */
    async report(user: IUserRef, relayId: string): Promise<IOutgoing[]> {
        const { roomId } = await this.#relay(relayId);
        return this.#lock.run(roomId, async () => {
            const relay = await this.#relay(relayId);
            const { view } = await this.#side(user, relay, 'toId');
            if (relay.status === 'reported') {
                throw new RoomError('Вы уже пожаловались на это сообщение.');
            }
            await this.#service.store.saveRelay({ ...relay, status: 'reported' });
            const author = view.participants.find((p) => p.id === relay.fromId);
            const isAuthorOwner =
                !!author &&
                author.platform === view.room.ownerPlatform &&
                author.userId === view.room.ownerUserId;
            return [
                {
                    roomId: view.room.id,
                    to: { platform: view.room.ownerPlatform, userId: view.room.ownerUserId },
                    text: [
                        `«${view.room.title}»: участник пожаловался на анонимное сообщение. Автора бот не раскрывает.`,
                        '',
                        'Текст сообщения:',
                        relay.text,
                        ...(isAuthorOwner ? ['Автор — организатор этой игры.'] : []),
                    ].join('\n'),
                    buttons: isAuthorOwner
                        ? []
                        : [btn('Исключить автора', A.expel, { x: relay.id })],
                    track: false,
                },
            ];
        });
    }

    /**
     * Блокировка автора: его следующие сообщения этому получателю не доставляются.
     *
     * @param user Получатель сообщения
     * @param relayId id сообщения
     */
    async block(user: IUserRef, relayId: string): Promise<void> {
        const relay = await this.#relay(relayId);
        await this.#lock.run(relay.roomId, async () => {
            await this.#side(user, relay, 'toId');
            await this.#service.store.block(relay.roomId, relay.toId, relay.fromId);
        });
    }

    /**
     * Игра жалобы — для текста подтверждения перед исключением автора.
     *
     * @param owner Организатор
     * @param relayId id сообщения, на которое пожаловались
     * @returns Комната
     */
    async reportedRoom(owner: IUserRef, relayId: string): Promise<IRoom> {
        const relay = await this.#relay(relayId);
        if (relay.status !== 'reported') {
            throw new RoomError('На это сообщение не жаловались.');
        }
        const view = await this.#service.view(owner, relay.roomId);
        if (!view.isOwner) {
            throw new RoomError('Это может сделать только организатор игры.');
        }
        return view.room;
    }

    /**
     * Исключение автора по жалобе.
     *
     * @param owner Организатор
     * @param relayId id сообщения, на которое пожаловались
     * @returns Уведомления режима об уходе участника
     */
    async expel(owner: IUserRef, relayId: string): Promise<IOutgoing[]> {
        const relay = await this.#relay(relayId);
        if (relay.status !== 'reported') {
            throw new RoomError('На это сообщение не жаловались.');
        }
        return this.#service.expel(owner, relay.roomId, relay.fromId);
    }

    /**
     * Недоставленные сообщения пользователя в комнате — чтобы отменить до доставки.
     *
     * @param user Автор
     * @param roomId id комнаты
     * @returns Сообщения в ожидании доставки
     */
    async outbox(user: IUserRef, roomId: string): Promise<IRelay[]> {
        const view = await this.#service.view(user, roomId);
        return (await this.#service.store.relaysOf(roomId)).filter(
            (r) => r.fromId === view.me?.id && r.status === 'pending',
        );
    }

    /**
     * Доставленные сообщения пользователя — их видно в карточке игры. Для Алисы это
     * единственный способ прочитать анонимные сообщения: она не умеет писать первой.
     *
     * @param user Получатель
     * @param roomId id комнаты
     * @returns Сообщения в порядке поступления
     */
    async inbox(user: IUserRef, roomId: string): Promise<IRelay[]> {
        const view = await this.#service.view(user, roomId);
        return (await this.#service.store.relaysOf(roomId)).filter(
            (r) => r.toId === view.me?.id && (r.status === 'sent' || r.status === 'reported'),
        );
    }

    /**
     * Отмена сообщения до доставки.
     *
     * @param user Автор
     * @param relayId id сообщения
     */
    async cancel(user: IUserRef, relayId: string): Promise<void> {
        const { roomId } = await this.#relay(relayId);
        await this.#lock.run(roomId, async () => {
            const relay = await this.#relay(relayId);
            await this.#side(user, relay, 'fromId');
            if (relay.status === 'cancelled') {
                throw new RoomError('Сообщение уже отменено.');
            }
            if (relay.status !== 'pending') {
                throw new RoomError('Сообщение уже доставлено.');
            }
            // Помечаем вместо удаления: повторная отмена должна объясниться,
            // а не пугать «игру удалили»
            await this.#service.store.saveRelay({ ...relay, status: 'cancelled' });
        });
    }

    /**
     * Доставляет отложенные сообщения, время которых наступило. Вызывается из jobs/tick.ts.
     *
     * @returns Комнаты и сообщения для рассылки
     */
    async deliverDue(): Promise<{ room: IRoom; outgoing: IOutgoing[] }[]> {
        const now = this.#service.now().toISOString();
        const due = (await this.#service.store.pendingRelays()).filter((r) => r.deliverAt <= now);
        const result: { room: IRoom; outgoing: IOutgoing[] }[] = [];
        for (const roomId of new Set(due.map((r) => r.roomId))) {
            const batch = await this.#lock.run(roomId, async () => {
                const view = await this.#service.context(roomId);
                if (!view) {
                    return null;
                }
                const outgoing: IOutgoing[] = [];
                for (const relay of await this.#service.store.relaysOf(roomId)) {
                    if (relay.status === 'pending' && relay.deliverAt <= now) {
                        outgoing.push(...(await this.#deliver(view, relay)));
                    }
                }
                return { room: view.room, outgoing };
            });
            if (batch) {
                result.push(batch);
            }
        }
        return result;
    }
}
