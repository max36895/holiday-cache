/**
 * Статус комнаты, меняется только вперёд:
 * open — набор участников, closed — состав зафиксирован (жеребьёвка, выбор даты),
 * finished — игра завершена. Свою фазу внутри статуса режим хранит в settings.
 */
export type TRoomStatus = 'open' | 'closed' | 'finished';

/** Статус доставки отслеживаемого сообщения участнику. */
export type TDelivery = 'pending' | 'sent' | 'failed';

/** Статус анонимного сообщения. */
export type TRelayStatus = 'pending' | 'sent' | 'reported' | 'cancelled';

/**
 * Человек в конкретном мессенджере. id уникален только внутри платформы,
 * поэтому один человек в двух мессенджерах — два разных пользователя.
 */
export interface IUserRef {
    platform: string;
    userId: string;
}

/** Комната (игра). Данные режима — в settings. */
export interface IRoom {
    id: string;
    /** Код для входа, 6 символов из CODE_ALPHABET */
    code: string;
    /** Идентификатор режима из реестра */
    mode: string;
    title: string;
    /** Настройки режима: ответы мастера создания и фаза игры */
    settings: Record<string, string>;
    ownerPlatform: string;
    ownerUserId: string;
    status: TRoomStatus;
    /** Часовой пояс IANA для расписания */
    timezone: string;
    /** Даты — ISO-строки: так их одинаково хранят файловая БД и SQL */
    createdAt: string;
    closedAt: string | null;
    /** Когда удалить комнату; null — бессрочная комната */
    expiresAt: string | null;
    /** Когда планировщик вызовет onSchedule режима; null — никогда */
    nextRunAt: string | null;
}

/** Участник комнаты. Данные режима — в profile. */
export interface IParticipant {
    id: string;
    roomId: string;
    platform: string;
    /** Пустая строка — участник удалил свои данные или исключён после фиксации состава */
    userId: string;
    name: string;
    /** Ответы на вопросы режима при входе */
    profile: Record<string, string>;
    /** Кому дарит (participants.id), если режим назначает пары */
    recipientId: string | null;
    delivery: TDelivery | null;
    joinedAt: string;
}

/** Отметка участника: голос, «скинулся», ответ в игре. */
export interface IMark {
    id: string;
    roomId: string;
    participantId: string;
    key: string;
    value: string;
    createdAt: string;
}

/** Анонимное сообщение между участниками комнаты. */
export interface IRelay {
    id: string;
    roomId: string;
    fromId: string;
    toId: string;
    /** Хранится до удаления комнаты: организатор видит его в жалобе */
    text: string;
    deliverAt: string;
    status: TRelayStatus;
    createdAt: string;
}
