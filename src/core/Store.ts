import { AppContext } from 'umbot';
import { TABLES } from './db';
import { Table, TRow } from './models';
import { DEFAULT_TIMEZONE } from './time';
import {
    IMark,
    IParticipant,
    IRelay,
    IRoom,
    IUserRef,
    TDelivery,
    TRelayStatus,
    TRoomStatus,
} from './types';

const ROOM_STATUSES: readonly TRoomStatus[] = ['open', 'closed', 'finished'];
const DELIVERIES: readonly TDelivery[] = ['pending', 'sent', 'failed'];
const RELAY_STATUSES: readonly TRelayStatus[] = ['pending', 'sent', 'reported', 'cancelled'];

function str(value: string | null | undefined): string {
    return value ?? '';
}

function orNull(value: string | null | undefined): string | null {
    return value ? value : null;
}

function oneOf<T extends string>(
    value: string | null | undefined,
    list: readonly T[],
    fallback: T,
): T {
    return list.find((item) => item === value) ?? fallback;
}

/** JSON-объект строк из поля таблицы; повреждённое значение — пустой объект. */
function parseRecord(value: string | null | undefined): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(value || '{}');
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
        );
    } catch {
        return {};
    }
}

function toRoom(row: TRow): IRoom {
    return {
        id: str(row.id),
        code: str(row.code),
        mode: str(row.mode),
        title: str(row.title),
        settings: parseRecord(row.settings),
        ownerPlatform: str(row.ownerPlatform),
        ownerUserId: str(row.ownerUserId),
        status: oneOf(row.status, ROOM_STATUSES, 'finished'),
        timezone: row.timezone || DEFAULT_TIMEZONE,
        createdAt: str(row.createdAt),
        closedAt: orNull(row.closedAt),
        expiresAt: orNull(row.expiresAt),
        nextRunAt: orNull(row.nextRunAt),
    };
}

function fromRoom(room: IRoom): TRow {
    return { ...room, settings: JSON.stringify(room.settings) };
}

function toParticipant(row: TRow): IParticipant {
    return {
        id: str(row.id),
        roomId: str(row.roomId),
        platform: str(row.platform),
        userId: str(row.userId),
        name: str(row.name),
        profile: parseRecord(row.profile),
        recipientId: orNull(row.recipientId),
        delivery: row.delivery ? oneOf(row.delivery, DELIVERIES, 'pending') : null,
        joinedAt: str(row.joinedAt),
    };
}

function fromParticipant(participant: IParticipant): TRow {
    return { ...participant, profile: JSON.stringify(participant.profile) };
}

function toMark(row: TRow): IMark {
    return {
        id: str(row.id),
        roomId: str(row.roomId),
        participantId: str(row.participantId),
        key: str(row.key),
        value: str(row.value),
        createdAt: str(row.createdAt),
    };
}

function toRelay(row: TRow): IRelay {
    return {
        id: str(row.id),
        roomId: str(row.roomId),
        fromId: str(row.fromId),
        toId: str(row.toId),
        text: str(row.text),
        deliverAt: str(row.deliverAt),
        status: oneOf(row.status, RELAY_STATUSES, 'sent'),
        createdAt: str(row.createdAt),
    };
}

function byJoined(a: IParticipant, b: IParticipant): number {
    return a.joinedAt.localeCompare(b.joinedAt);
}

/**
 * Доступ к таблицам бота. Условия — только точное равенство полей: так работают
 * и файловая БД umbot, и SQL. Изменения одной комнаты выполняются внутри RoomLock.
 *
 * @example
 * ```ts
 * const store = new Store(bot.getAppContext());
 * const room = await store.findRoomByCode('K7M2QX');
 * ```
 */
export class Store {
    readonly #rooms: Table;
    readonly #participants: Table;
    readonly #marks: Table;
    readonly #relays: Table;
    readonly #blocks: Table;
    readonly #sendLog: Table;

    constructor(appContext: AppContext) {
        this.#rooms = new Table(appContext, TABLES.rooms);
        this.#participants = new Table(appContext, TABLES.participants);
        this.#marks = new Table(appContext, TABLES.marks);
        this.#relays = new Table(appContext, TABLES.relays);
        this.#blocks = new Table(appContext, TABLES.blocks);
        this.#sendLog = new Table(appContext, TABLES.sendLog);
    }

    // --- комнаты ---

    async findRoom(id: string): Promise<IRoom | null> {
        const [row] = await this.#rooms.select({ id });
        return row ? toRoom(row) : null;
    }

    /** Комната по коду. Код уникален среди незавершённых комнат, у завершённых может повторяться. */
    async findRoomByCode(code: string): Promise<IRoom | null> {
        const rooms = (await this.#rooms.select({ code })).map(toRoom);
        return rooms.find((room) => room.status !== 'finished') ?? rooms[0] ?? null;
    }

    async roomsByOwner(user: IUserRef): Promise<IRoom[]> {
        const rows = await this.#rooms.select({
            ownerPlatform: user.platform,
            ownerUserId: user.userId,
        });
        return rows.map(toRoom);
    }

    async roomsByStatus(status: TRoomStatus): Promise<IRoom[]> {
        return (await this.#rooms.select({ status })).map(toRoom);
    }

    async insertRoom(room: IRoom): Promise<void> {
        if (!(await this.#rooms.insert(fromRoom(room)))) {
            throw new Error('Не удалось создать комнату');
        }
    }

    saveRoom(room: IRoom): Promise<void> {
        return this.#rooms.update(fromRoom(room));
    }

    /** Стирает комнату со всеми участниками, отметками, сообщениями и журналом рассылки. */
    async eraseRoom(room: IRoom): Promise<void> {
        const roomId = room.id;
        for (const table of [
            this.#participants,
            this.#marks,
            this.#relays,
            this.#blocks,
            this.#sendLog,
        ]) {
            for (const row of await table.select({ roomId })) {
                await table.remove(row);
            }
        }
        await this.#rooms.remove(fromRoom(room));
    }

    // --- участники ---

    async findParticipant(id: string): Promise<IParticipant | null> {
        const [row] = await this.#participants.select({ id });
        return row ? toParticipant(row) : null;
    }

    /** Участники комнаты в порядке входа. */
    async participantsOf(roomId: string): Promise<IParticipant[]> {
        return (await this.#participants.select({ roomId })).map(toParticipant).sort(byJoined);
    }

    async participationsOf(user: IUserRef): Promise<IParticipant[]> {
        const rows = await this.#participants.select({
            platform: user.platform,
            userId: user.userId,
        });
        return rows.map(toParticipant);
    }

    async insertParticipant(participant: IParticipant): Promise<void> {
        if (!(await this.#participants.insert(fromParticipant(participant)))) {
            throw new Error('Не удалось добавить участника');
        }
    }

    saveParticipant(participant: IParticipant): Promise<void> {
        return this.#participants.update(fromParticipant(participant));
    }

    /** Удаляет участника вместе с его отметками, блокировками и анонимными сообщениями. */
    async deleteParticipant(participant: IParticipant): Promise<void> {
        for (const row of await this.#marks.select({ participantId: participant.id })) {
            await this.#marks.remove(row);
        }
        await this.deleteRelaysOf(participant);
        for (const field of ['blockerId', 'blockedId']) {
            for (const row of await this.#blocks.select({
                roomId: participant.roomId,
                [field]: participant.id,
            })) {
                await this.#blocks.remove(row);
            }
        }
        await this.#participants.remove(fromParticipant(participant));
    }

    // --- отметки ---

    async marksOf(roomId: string): Promise<IMark[]> {
        return (await this.#marks.select({ roomId })).map(toMark);
    }

    /**
     * Ставит отметку участника (value) или снимает её (null).
     *
     * @param mark Комната, участник, ключ и значение
     * @param now Время отметки
     */
    async setMark(
        mark: Pick<IMark, 'roomId' | 'participantId' | 'key'> & { value: string | null },
        now: string,
    ): Promise<void> {
        const [existing] = await this.#marks.select({
            roomId: mark.roomId,
            participantId: mark.participantId,
            key: mark.key,
        });
        if (mark.value === null) {
            if (existing) {
                await this.#marks.remove(existing);
            }
            return;
        }
        if (existing) {
            await this.#marks.update({ ...existing, value: mark.value });
        } else if (
            !(await this.#marks.insert({
                ...mark,
                id: `${mark.participantId}:${mark.key}`,
                createdAt: now,
            }))
        ) {
            throw new Error('Не удалось сохранить отметку');
        }
    }

    // --- анонимные сообщения ---

    async findRelay(id: string): Promise<IRelay | null> {
        const [row] = await this.#relays.select({ id });
        return row ? toRelay(row) : null;
    }

    async relaysOf(roomId: string): Promise<IRelay[]> {
        return (await this.#relays.select({ roomId })).map(toRelay);
    }

    async pendingRelays(): Promise<IRelay[]> {
        return (await this.#relays.select({ status: 'pending' })).map(toRelay);
    }

    async insertRelay(relay: IRelay): Promise<void> {
        if (!(await this.#relays.insert({ ...relay }))) {
            throw new Error('Не удалось сохранить сообщение');
        }
    }

    saveRelay(relay: IRelay): Promise<void> {
        return this.#relays.update({ ...relay });
    }

    deleteRelay(relay: IRelay): Promise<void> {
        return this.#relays.remove({ ...relay });
    }

    /**
     * Удаляет анонимные сообщения, которые участник написал или получил:
     * тексты хранятся до удаления комнаты и уходят вместе с данными участника.
     *
     * @param participant Участник
     * @param keepDelivered true — уже доставленные сообщения получателей остаются:
     *   исключение хулигана не должно молча стирать переписку его адресатов
     */
    async deleteRelaysOf(participant: IParticipant, keepDelivered = false): Promise<void> {
        for (const field of ['fromId', 'toId']) {
            for (const row of await this.#relays.select({
                roomId: participant.roomId,
                [field]: participant.id,
            })) {
                if (keepDelivered && (row.status === 'sent' || row.status === 'reported')) {
                    continue;
                }
                await this.#relays.remove(row);
            }
        }
    }

    // --- блокировки в пересылке ---

    async isBlocked(roomId: string, blockerId: string, blockedId: string): Promise<boolean> {
        return (await this.#blocks.select({ id: `${blockerId}:${blockedId}`, roomId })).length > 0;
    }

    async block(roomId: string, blockerId: string, blockedId: string): Promise<void> {
        if (!(await this.isBlocked(roomId, blockerId, blockedId))) {
            await this.#blocks.insert({
                id: `${blockerId}:${blockedId}`,
                roomId,
                blockerId,
                blockedId,
            });
        }
    }

    // --- журнал рассылки ---

    /**
     * Записывает ключ сообщения в журнал. Ключ пишется до отправки: сообщение
     * с уже записанным ключом не отправляется второй раз даже после сбоя.
     *
     * @param key Ключ сообщения
     * @param roomId Комната
     * @param now Время
     * @returns false, если ключ уже был в журнале
     */
    async claimSend(key: string, roomId: string, now: string): Promise<boolean> {
        if ((await this.#sendLog.select({ key })).length) {
            return false;
        }
        return this.#sendLog.insert({ key, roomId, sentAt: now });
    }
}
