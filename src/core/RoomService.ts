import {
    IActionInput,
    IMode,
    IModeAction,
    IModeButton,
    IModeContext,
    IModeResult,
    IOwnerMessage,
    IPersonalMessage,
    IRoomPatch,
} from '../modes/IMode';
import { A, btn, clipChars, IButton } from '../ui';
import { generateCode, newId } from './codes';
import { ModeRegistry } from './ModeRegistry';
import { IOutgoing } from './Notifier';
import { RoomError } from './RoomError';
import { RoomLock } from './RoomLock';
import { Store } from './Store';
import { DEFAULT_TIMEZONE, isValidTimezone } from './time';
import { T, titleCaseName } from '../texts';
import { IParticipant, IRoom, IUserRef, TDelivery, TRoomStatus } from './types';

/** Сколько незавершённых комнат может быть у одного организатора. */
export const MAX_ACTIVE_ROOMS = 10;

const STATUS_ORDER: readonly TRoomStatus[] = ['open', 'closed', 'finished'];

/** Комната глазами пользователя: состояние для режима и сам режим. */
export interface IRoomView extends IModeContext {
    mode: IMode;
}

/** Итог действия: обновлённая комната, ответ режима и сообщения для рассылки. */
export interface IActionOutcome {
    room: IRoom;
    result: IModeResult;
    outgoing: IOutgoing[];
}

function sameUser(user: IUserRef, platform: string, userId: string): boolean {
    return user.platform === platform && user.userId === userId;
}

/** Организатор ли пользователь этой комнаты. */
export function isOwner(room: IRoom, user: IUserRef): boolean {
    return sameUser(user, room.ownerPlatform, room.ownerUserId);
}

/**
 * Комнаты и участники: создание, вход, выход, исключение, удаление и действия режимов.
 * Права и статус проверяются в каждом методе: payload кнопки приходит от пользователя,
 * скрытая кнопка ничего не гарантирует. Каждое изменение комнаты выполняется под
 * RoomLock и начинается с чтения свежих данных.
 *
 * Режим только возвращает IModeResult; применяет его — сохраняет изменения,
 * пересчитывает срок жизни и расписание, готовит рассылку — этот сервис.
 *
 * @example
 * ```ts
 * const service = new RoomService(store, new RoomLock(appContext), new ModeRegistry(MODES));
 * const outcome = await service.runAction(user, roomId, 'draw', {});
 * ```
 */
export class RoomService {
    readonly #store: Store;
    readonly #lock: RoomLock;
    readonly #modes: ModeRegistry;
    readonly #now: () => Date;

    constructor(
        store: Store,
        lock: RoomLock,
        modes: ModeRegistry,
        now: () => Date = () => new Date(),
    ) {
        this.#store = store;
        this.#lock = lock;
        this.#modes = modes;
        this.#now = now;
    }

    get store(): Store {
        return this.#store;
    }

    get modes(): ModeRegistry {
        return this.#modes;
    }

    /** Текущее время: подменяется в тестах расписания. */
    now(): Date {
        return this.#now();
    }

    async #room(roomId: string): Promise<IRoom> {
        const room = await this.#store.findRoom(roomId);
        if (!room) {
            throw new RoomError('Игра не найдена: её удалили или срок хранения истёк.');
        }
        return room;
    }

    async #context(room: IRoom, user: IUserRef | null): Promise<IRoomView> {
        const participants = await this.#store.participantsOf(room.id);
        return {
            room,
            mode: this.#modes.get(room.mode),
            participants,
            marks: await this.#store.marksOf(room.id),
            me: user
                ? (participants.find((p) => sameUser(user, p.platform, p.userId)) ?? null)
                : null,
            isOwner: user ? isOwner(room, user) : false,
            now: this.#now(),
        };
    }

    /**
     * Состояние комнаты без пользователя — для задач по расписанию.
     * Вызывается под блокировкой комнаты.
     *
     * @param roomId id комнаты
     * @returns Состояние или null, если комнату уже удалили
     */
    async context(roomId: string): Promise<IRoomView | null> {
        const room = await this.#store.findRoom(roomId);
        return room ? this.#context(room, null) : null;
    }

    /**
     * Комната глазами пользователя: только для организатора и участников.
     *
     * @param user Пользователь
     * @param roomId id комнаты
     * @returns Состояние комнаты, режим и роль пользователя
     */
    async view(user: IUserRef, roomId: string): Promise<IRoomView> {
        const view = await this.#context(await this.#room(roomId), user);
        if (!view.isOwner && !view.me) {
            throw new RoomError('Вы не участвуете в этой игре.');
        }
        return view;
    }

    /**
     * Комната по коду — для входа. Завершённые комнаты по коду не находятся.
     *
     * @param code Код комнаты
     * @returns Комната или null
     */
    async findByCode(code: string): Promise<IRoom | null> {
        const room = await this.#store.findRoomByCode(code);
        return room && room.status !== 'finished' ? room : null;
    }

    /**
     * Проверяет лимит незавершённых комнат организатора — до начала мастера создания.
     *
     * @param owner Организатор
     * @throws RoomError, если лимит исчерпан
     */
    async assertCanCreate(owner: IUserRef): Promise<void> {
        const active = (await this.#store.roomsByOwner(owner)).filter(
            (r) => r.status !== 'finished',
        );
        if (active.length >= MAX_ACTIVE_ROOMS) {
            throw new RoomError(
                `У вас уже ${MAX_ACTIVE_ROOMS} незавершённых игр. Завершите или удалите одну из них.`,
            );
        }
    }

    /**
     * Создаёт комнату со свободным кодом. Ответ на вопрос с ключом timezone
     * становится часовым поясом комнаты.
     *
     * @param owner Организатор
     * @param mode Режим игры
     * @param title Название
     * @param settings Ответы мастера создания
     * @returns Созданная комната
     */
    async createRoom(
        owner: IUserRef,
        mode: IMode,
        title: string,
        settings: Record<string, string>,
    ): Promise<IRoom> {
        await this.assertCanCreate(owner);
        const timezone =
            settings.timezone && isValidTimezone(settings.timezone)
                ? settings.timezone
                : DEFAULT_TIMEZONE;
        const draft: IRoom = {
            id: newId(),
            code: await this.#freeCode(),
            mode: mode.id,
            title,
            settings,
            ownerPlatform: owner.platform,
            ownerUserId: owner.userId,
            status: 'open',
            timezone,
            createdAt: this.#now().toISOString(),
            closedAt: null,
            expiresAt: null,
            nextRunAt: null,
        };
        const room = this.#derived(await this.#context(draft, null));
        await this.#store.insertRoom(room);
        return room;
    }

    async #freeCode(): Promise<string> {
        for (let attempt = 0; attempt < 10; attempt++) {
            const code = generateCode();
            // Код занят любой комнатой, включая завершённую: старые приглашения
            // с этим кодом не должны открывать чужую новую игру
            const taken = await this.#store.findRoomByCode(code);
            if (!taken) {
                return code;
            }
        }
        throw new Error('Не удалось подобрать свободный код комнаты');
    }

    /** Срок жизни и время следующего запуска по расписанию — по правилам режима. */
    #derived(view: IRoomView): IRoom {
        const { room, mode } = view;
        return {
            ...room,
            expiresAt: mode.lifetime === 'permanent' ? null : (mode.expiresAt?.(room) ?? null),
            nextRunAt: room.status === 'finished' ? null : (mode.schedule?.(view) ?? null),
        };
    }

    /**
     * Добавляет пользователя в комнату.
     *
     * @param user Пользователь
     * @param roomId id комнаты
     * @param name Имя участника
     * @param profile Ответы на вопросы режима при входе
     * @returns Комната, новый участник и число участников
     */
    async join(
        user: IUserRef,
        roomId: string,
        name: string,
        profile: Record<string, string>,
    ): Promise<{ room: IRoom; participant: IParticipant; count: number }> {
        return this.#lock.run(roomId, async () => {
            const view = await this.#context(await this.#room(roomId), user);
            if (view.room.status !== 'open') {
                // Не текст #requireOpen: человек входит, а не меняет состав, —
                // формулировка про вход, а не про жеребьёвку
                throw new RoomError(T.closedForJoin);
            }
            if (view.me) {
                throw new RoomError('Вы уже в этой игре.');
            }
            if (this.isBanned(view.room, user)) {
                // Причина не называется: иначе по факту отказа видно, что речь про жалобу
                throw new RoomError(T.closedForJoin);
            }
            if (view.participants.length >= view.mode.maxParticipants) {
                throw new RoomError('В игре уже максимальное число участников.');
            }
            const participant: IParticipant = {
                id: newId(),
                roomId,
                platform: user.platform,
                userId: user.userId,
                // «пётр» сохраняется как «Пётр»: имя увидят все участники;
                // обрезаем по кодовым точкам, чтобы не разрезать эмодзи
                name: clipChars(titleCaseName(name), 40),
                profile,
                recipientId: null,
                delivery: null,
                joinedAt: this.#now().toISOString(),
            };
            await this.#store.insertParticipant(participant);
            const room = await this.#saveDerived(view.room);
            return { room, participant, count: view.participants.length + 1 };
        });
    }

    /** Исключённые по жалобе не возвращаются, пока набор открыт: исключение — не «кнопка перезахода». */
    isBanned(room: IRoom, user: IUserRef): boolean {
        return (room.settings.banned ?? '').split(',').includes(user.userId);
    }

    /**
     * Игровое имя организатора-участника: он задаёт его после создания комнаты, и в
     * карточках «Организатор: …» должно быть то же имя. Под блокировкой: запись строки
     * целиком по снимку из join() затёрла бы чужие изменения, случившиеся в этом окне.
     *
     * @param roomId id комнаты
     * @param name Имя участника-организатора
     */
    async renameOwner(roomId: string, name: string): Promise<void> {
        await this.#lock.run(roomId, async () => {
            const room = await this.#store.findRoom(roomId);
            if (room && room.settings.ownerName !== name) {
                await this.#saveDerived({
                    ...room,
                    settings: { ...room.settings, ownerName: name },
                });
            }
        });
    }

    #requireOpen(view: IRoomView): void {
        if (view.room.status !== 'open') {
            throw new RoomError(`${view.mode.texts.closed} — состав игры не изменить.`);
        }
    }

    /** Сохраняет комнату с пересчитанными сроком жизни и расписанием: они не зависят от того, кто действует. */
    async #saveDerived(room: IRoom): Promise<IRoom> {
        const derived = this.#derived(await this.#context(room, null));
        await this.#store.saveRoom(derived);
        return derived;
    }

    /**
     * Выход участника, пока состав не зафиксирован.
     *
     * @param user Участник
     * @param roomId id комнаты
     * @returns Комната, из которой вышел участник
     */
    async leave(user: IUserRef, roomId: string): Promise<IRoom> {
        return this.#lock.run(roomId, async () => {
            const view = await this.#context(await this.#room(roomId), user);
            this.#requireOpen(view);
            if (!view.me) {
                throw new RoomError('Вы не участвуете в этой игре.');
            }
            await this.#store.deleteParticipant(view.me);
            return this.#saveDerived(view.room);
        });
    }

    /**
     * Исключение участника организатором, пока состав не зафиксирован.
     *
     * @param owner Организатор
     * @param participantId id участника
     * @returns Комната и исключённый участник
     */
    async kick(
        owner: IUserRef,
        participantId: string,
    ): Promise<{ room: IRoom; participant: IParticipant }> {
        const found = await this.#store.findParticipant(participantId);
        if (!found) {
            throw new RoomError('Участник уже вышел из игры.');
        }
        return this.#lock.run(found.roomId, async () => {
            const view = await this.#ownerView(owner, found.roomId);
            this.#requireOpen(view);
            const participant = view.participants.find((p) => p.id === participantId);
            if (!participant) {
                throw new RoomError('Участник уже вышел из игры.');
            }
            await this.#store.deleteParticipant(participant);
            return { room: await this.#saveDerived(view.room), participant };
        });
    }

    async #ownerView(owner: IUserRef, roomId: string): Promise<IRoomView> {
        const view = await this.#context(await this.#room(roomId), owner);
        if (!view.isOwner) {
            throw new RoomError('Это может сделать только организатор игры.');
        }
        return view;
    }

    /**
     * Убирает участника: пока состав открыт — удаляет запись, после фиксации — стирает
     * имя, id, профиль и анонимные сообщения, а запись оставляет: на неё ссылаются
     * пары и отметки других.
     * Режим узнаёт об уходе через onLeave и может кого-то уведомить.
     * Вызывается под блокировкой комнаты.
     */
    async #removeParticipant(
        view: IRoomView,
        gone: IParticipant,
        reason: 'forget' | 'expel',
    ): Promise<IOutgoing[]> {
        if (view.room.status === 'open') {
            await this.#store.deleteParticipant(gone);
            if (reason === 'expel') {
                await this.#saveDerived(this.#banUser(view.room, gone));
            } else {
                await this.#saveDerived(view.room);
            }
            return [];
        }
        await this.#store.saveParticipant({ ...gone, userId: '', name: '', profile: {} });
        // «Удалить мои данные» стирает и доставленные сообщения; исключение по жалобе —
        // только недоставленные: получатели не должны молча терять переписку
        await this.#store.deleteRelaysOf(gone, reason === 'expel');
        const result = view.mode.onLeave?.(view, gone, reason) ?? {};
        return (await this.#apply(await this.#context(view.room, null), result)).outgoing;
    }

    /** Добавляет userId в список исключённых по жалобе: вернуться по коду он больше не сможет. */
    #banUser(room: IRoom, gone: IParticipant): IRoom {
        const banned = (room.settings.banned ?? '').split(',').filter(Boolean);
        if (!banned.includes(gone.userId)) {
            banned.push(gone.userId);
        }
        return { ...room, settings: { ...room.settings, banned: banned.join(',') } };
    }

    /**
     * Исключение участника организатором в любом статусе — по жалобе на анонимное
     * сообщение. Имя исключённого организатор не узнаёт. Сам исключённый узнаёт,
     * что больше не участвует, но не причину: иначе по факту исключения он вычислит
     * жалобщика.
     *
     * @param owner Организатор
     * @param roomId id комнаты
     * @param participantId id участника
     * @returns Сообщения, которые нужно разослать (уведомления режима)
     */
    async expel(owner: IUserRef, roomId: string, participantId: string): Promise<IOutgoing[]> {
        return this.#lock.run(roomId, async () => {
            const view = await this.#ownerView(owner, roomId);
            const gone = view.participants.find((p) => p.id === participantId && p.userId);
            if (!gone) {
                throw new RoomError('Автор уже не участвует в игре.');
            }
            if (
                gone.platform === view.room.ownerPlatform &&
                gone.userId === view.room.ownerUserId
            ) {
                // Без организатора комната никому не управляема: жалобу на его
                // сообщение оставляем как сигнал, но исключить его нельзя
                throw new RoomError('Организатора нельзя исключить из игры.');
            }
            const outgoing = await this.#removeParticipant(view, gone, 'expel');
            outgoing.push({
                roomId: view.room.id,
                to: { platform: gone.platform, userId: gone.userId },
                text: T.removed(view.room.title),
                buttons: [],
                track: false,
            });
            return outgoing;
        });
    }

    /**
     * Удаление комнаты организатором: стирает комнату и всё, что с ней связано.
     * Участники получают уведомление: для них игра исчезает без следа, и молчать нельзя.
     *
     * @param owner Организатор
     * @param roomId id комнаты
     * @returns Удалённая комната и уведомления участникам
     */
    async deleteRoom(
        owner: IUserRef,
        roomId: string,
    ): Promise<{ room: IRoom; outgoing: IOutgoing[] }> {
        return this.#lock.run(roomId, async () => {
            const { room } = await this.#ownerView(owner, roomId);
            const participants = await this.#store.participantsOf(roomId);
            await this.#store.eraseRoom(room);
            const outgoing = participants
                .filter((p) => p.userId)
                .map((p) => ({
                    roomId: room.id,
                    to: { platform: p.platform, userId: p.userId },
                    participantId: p.id,
                    text: `Игра «${room.title}» удалена организатором.`,
                    buttons: [],
                    track: false,
                }));
            return { room, outgoing };
        });
    }

    /**
     * «Удалить мои данные»: комнаты организатора удаляются целиком, из остальных
     * пользователь уходит (см. #removeParticipant).
     *
     * @param user Пользователь
     * @returns Счётчики и сообщения режимов тем, кого касается уход
     */
    async forgetUser(
        user: IUserRef,
    ): Promise<{ deletedRooms: number; leftRooms: number; outgoing: IOutgoing[] }> {
        let deletedRooms = 0;
        for (const room of await this.#store.roomsByOwner(user)) {
            await this.#lock.run(room.id, async () => {
                const fresh = await this.#store.findRoom(room.id);
                if (fresh) {
                    await this.#store.eraseRoom(fresh);
                    deletedRooms++;
                }
            });
        }
        let leftRooms = 0;
        const outgoing: IOutgoing[] = [];
        for (const found of await this.#store.participationsOf(user)) {
            await this.#lock.run(found.roomId, async () => {
                const room = await this.#store.findRoom(found.roomId);
                const view = room ? await this.#context(room, user) : null;
                if (view?.me) {
                    leftRooms++;
                    outgoing.push(...(await this.#removeParticipant(view, view.me, 'forget')));
                }
            });
        }
        return { deletedRooms, leftRooms, outgoing };
    }

    #findAction(view: IRoomView, actionId: string): IModeAction {
        const action = view.mode.actions(view).find((a) => a.id === actionId);
        if (action) {
            return action;
        }
        const ownerOnly =
            !view.isOwner &&
            view.mode.actions({ ...view, isOwner: true }).some((a) => a.id === actionId);
        throw new RoomError(
            ownerOnly
                ? 'Это может сделать только организатор игры.'
                : 'Это действие сейчас недоступно.',
        );
    }

    /**
     * Действие режима, доступное пользователю: перед выбором варианта, подтверждением
     * или вопросом. Права проверяет режим: доступно только то, что вернул actions().
     *
     * @param user Пользователь
     * @param roomId id комнаты
     * @param actionId id действия
     * @returns Описание действия
     * @throws RoomError, если действие недоступно этому пользователю сейчас
     */
    async action(user: IUserRef, roomId: string, actionId: string): Promise<IModeAction> {
        return this.#findAction(await this.view(user, roomId), actionId);
    }

    /**
     * Выполняет действие режима и применяет результат.
     *
     * @param user Пользователь
     * @param roomId id комнаты
     * @param actionId id действия
     * @param input Выбранный вариант и ответ на вопрос действия
     * @returns Обновлённая комната, ответ режима и сообщения для рассылки
     */
    async runAction(
        user: IUserRef,
        roomId: string,
        actionId: string,
        input: IActionInput,
    ): Promise<IActionOutcome> {
        return this.#lock.run(roomId, async () => {
            const view = await this.view(user, roomId);
            const action = this.#findAction(view, actionId);
            if (action.options && !action.options.some((o) => o.value === input.option)) {
                throw new RoomError('Такого варианта уже нет.');
            }
            const result = await view.mode.handle(actionId, view, input);
            const applied = await this.#apply(view, result);
            return { room: applied.room, result, outgoing: applied.outgoing };
        });
    }

    /**
     * Запуск по расписанию: вызывает onSchedule режима, если наступил rooms.nextRunAt.
     *
     * @param roomId id комнаты
     * @returns Сообщения для рассылки
     */
    async runSchedule(roomId: string): Promise<{ room: IRoom; outgoing: IOutgoing[] } | null> {
        return this.#lock.run(roomId, async () => {
            const room = await this.#store.findRoom(roomId);
            if (!room?.nextRunAt || room.nextRunAt > this.#now().toISOString()) {
                return null;
            }
            const view = await this.#context(room, null);
            const result = (await view.mode.onSchedule?.(view)) ?? {};
            return this.#apply(view, result);
        });
    }

    #patchRoom(room: IRoom, patch: IRoomPatch | undefined): IRoom {
        if (!patch) {
            return room;
        }
        const status = patch.status ?? room.status;
        if (STATUS_ORDER.indexOf(status) < STATUS_ORDER.indexOf(room.status)) {
            throw new Error(
                `Режим вернул статус ${status} после ${room.status}: статус меняется только вперёд`,
            );
        }
        return {
            ...room,
            status,
            settings: { ...room.settings, ...patch.settings },
            closedAt:
                status !== 'open' && !room.closedAt ? this.#now().toISOString() : room.closedAt,
        };
    }

    /** Сохраняет результат режима и готовит рассылку. Вызывается под блокировкой комнаты. */
    async #apply(
        view: IRoomView,
        result: IModeResult,
    ): Promise<{ room: IRoom; outgoing: IOutgoing[] }> {
        const now = this.#now().toISOString();
        const room = this.#patchRoom(view.room, result.room);
        for (const patch of result.participants ?? []) {
            const participant = view.participants.find((p) => p.id === patch.id);
            if (participant) {
                await this.#store.saveParticipant({
                    ...participant,
                    ...(patch.recipientId !== undefined ? { recipientId: patch.recipientId } : {}),
                    ...(patch.delivery !== undefined ? { delivery: patch.delivery } : {}),
                    profile: { ...participant.profile, ...patch.profile },
                });
            }
        }
        for (const change of result.marks ?? []) {
            await this.#store.setMark({ roomId: room.id, ...change }, now);
        }
        const saved = await this.#saveDerived(room);
        const participants = await this.#store.participantsOf(room.id);
        return {
            room: saved,
            outgoing: await this.#resolve(
                saved,
                participants,
                result.messages ?? [],
                result.ownerMessage,
            ),
        };
    }

    /**
     * Готовит сообщения режима к отправке: адресат, кнопки, журнал рассылки.
     * Ключ журнала занимается здесь, под блокировкой: два запуска расписания
     * не отправят одно сообщение дважды.
     */
    async #resolve(
        room: IRoom,
        participants: IParticipant[],
        messages: readonly IPersonalMessage[],
        ownerMessage?: IOwnerMessage,
    ): Promise<IOutgoing[]> {
        const now = this.#now().toISOString();
        const outgoing: IOutgoing[] = [];
        for (const message of messages) {
            const to = participants.find((p) => p.id === message.to);
            if (
                !to?.userId ||
                (message.key && !(await this.#store.claimSend(message.key, room.id, now)))
            ) {
                continue;
            }
            if (message.track) {
                await this.#store.saveParticipant({ ...to, delivery: 'pending' });
            }
            outgoing.push({
                roomId: room.id,
                to: { platform: to.platform, userId: to.userId },
                participantId: to.id,
                text: message.text,
                buttons: this.#modeButtons(room.id, message.buttons ?? []),
                track: !!message.track,
            });
        }
        if (
            ownerMessage &&
            (!ownerMessage.key || (await this.#store.claimSend(ownerMessage.key, room.id, now)))
        ) {
            outgoing.push({
                roomId: room.id,
                to: { platform: room.ownerPlatform, userId: room.ownerUserId },
                text: ownerMessage.text,
                buttons: this.#modeButtons(room.id, ownerMessage.buttons ?? []),
                track: false,
            });
        }
        return outgoing;
    }

    /** Кнопки режима в исходящем сообщении: действия режима и пересылка ядра. */
    #modeButtons(roomId: string, buttons: readonly IModeButton[]): IButton[] {
        return buttons.map((b) =>
            b.relay
                ? // Пересылка — действие ядра, а не режима: цель подскажет relay.targets()
                  btn(b.title, A.write, { r: roomId })
                : btn(b.title, A.act, {
                      r: roomId,
                      m: b.action ?? '',
                      ...(b.value ? { x: b.value } : {}),
                  }),
        );
    }

    /**
     * Записывает результат отправки участнику.
     *
     * @param roomId id комнаты
     * @param participantId id участника
     * @param delivery Статус доставки
     */
    async markDelivery(roomId: string, participantId: string, delivery: TDelivery): Promise<void> {
        await this.#lock.run(roomId, async () => {
            const participant = await this.#store.findParticipant(participantId);
            // Участник мог удалить свои данные, пока шла рассылка
            if (participant?.userId) {
                await this.#store.saveParticipant({ ...participant, delivery });
            }
        });
    }

    /**
     * Новая игра с теми же правилами и названием («Сыграть ещё раз»): настройки
     * очищает режим (cloneSettings), пары, отметки и сообщения не переносятся.
     *
     * @param owner Организатор исходной комнаты
     * @param roomId id исходной комнаты
     * @param extra Ответы мастера клона (например, новая дата события поверх очищенных настроек)
     * @returns Новая комната
     */
    async cloneRoom(
        owner: IUserRef,
        roomId: string,
        extra: Record<string, string> = {},
    ): Promise<IRoom> {
        return this.#lock.run(roomId, async () => {
            const view = await this.#ownerView(owner, roomId);
            // Кнопка «Сыграть ещё раз» живёт в карточке завершённой игры; угаданный
            // payload не должен клонировать игру, которая ещё идёт
            if (view.room.status !== 'finished') {
                throw new RoomError('Сыграть ещё раз можно, когда игра завершена.');
            }
            const settings = {
                ...(view.mode.cloneSettings
                    ? view.mode.cloneSettings(view.room.settings)
                    : { ...view.room.settings }),
                ...extra,
            };
            return this.createRoom(owner, view.mode, view.room.title, settings);
        });
    }

    /**
     * Удаляет комнаты с истёкшим сроком хранения. Бессрочные комнаты (expiresAt = null)
     * не трогаются.
     *
     * @returns Сколько комнат удалено
     */
    async cleanupExpired(): Promise<number> {
        const now = this.#now().toISOString();
        let removed = 0;
        for (const status of STATUS_ORDER) {
            for (const candidate of await this.#store.roomsByStatus(status)) {
                if (!candidate.expiresAt || candidate.expiresAt >= now) {
                    continue;
                }
                // Срок перепроверяется под блокировкой: его могли продлить после выборки
                await this.#lock.run(candidate.id, async () => {
                    const room = await this.#store.findRoom(candidate.id);
                    if (room?.expiresAt && room.expiresAt < now) {
                        await this.#store.eraseRoom(room);
                        removed++;
                    }
                });
            }
        }
        return removed;
    }

    /**
     * Комнаты с наступившим временем запуска по расписанию.
     *
     * @returns id комнат
     */
    async dueRooms(): Promise<string[]> {
        const now = this.#now().toISOString();
        const rooms = [
            ...(await this.#store.roomsByStatus('open')),
            ...(await this.#store.roomsByStatus('closed')),
        ];
        return rooms.filter((r) => r.nextRunAt && r.nextRunAt <= now).map((r) => r.id);
    }

    /**
     * Игры пользователя: где он организатор и где участник, новые сверху.
     *
     * @param user Пользователь
     * @returns Комнаты с ролью пользователя
     */
    async myRooms(user: IUserRef): Promise<{ room: IRoom; isOwner: boolean }[]> {
        const result = new Map<string, { room: IRoom; isOwner: boolean }>();
        for (const room of await this.#store.roomsByOwner(user)) {
            result.set(room.id, { room, isOwner: true });
        }
        for (const participant of await this.#store.participationsOf(user)) {
            if (!result.has(participant.roomId)) {
                const room = await this.#store.findRoom(participant.roomId);
                if (room) {
                    result.set(room.id, { room, isOwner: false });
                }
            }
        }
        return [...result.values()].sort((a, b) =>
            b.room.createdAt.localeCompare(a.room.createdAt),
        );
    }
}
