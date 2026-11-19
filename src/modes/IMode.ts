import { IQuestion } from '../core/Wizard';
import { IMark, IParticipant, IRoom, TDelivery, TRoomStatus } from '../core/types';

/** Кто кому может писать анонимно. */
export type TRelayMode = 'none' | 'giver-to-recipient' | 'any-to-any';

/** Состояние комнаты, которое ядро передаёт режиму. Режим не читает БД сам. */
export interface IModeContext {
    room: IRoom;
    /** Участники в порядке входа */
    participants: IParticipant[];
    marks: IMark[];
    /** Запись того, кто нажал кнопку; null — не участник или вызов по расписанию */
    me: IParticipant | null;
    isOwner: boolean;
    now: Date;
}

/** Кнопка в сообщении режима: нажатие вызывает handle(action) этого режима. */
export interface IModeButton {
    /** Для relay-кнопки имя действия не нужно */
    action?: string;
    title: string;
    /** Выбранный вариант для handle (input.option) */
    value?: string;
    /**
     * Кнопка анонимного сообщения: вместо handle ведёт в пересылку ядра,
     * получателя определяет IMode.relay по роли нажавшего.
     */
    relay?: boolean;
}

/** Персональное сообщение участнику: его отправляет ядро. */
export interface IPersonalMessage {
    /** participants.id получателя */
    to: string;
    text: string;
    buttons?: IModeButton[];
    /** Ключ журнала рассылки: сообщение с таким ключом уходит не больше одного раза */
    key?: string;
    /** Записать результат в participants.delivery и прислать организатору отчёт о доставке */
    track?: boolean;
}

/** Вариант выбора перед действием: получатель, вариант голосования. */
export interface IActionOption {
    value: string;
    title: string;
}

/** Кнопка действия режима в карточке комнаты. */
export interface IModeAction {
    /** Идентификатор: не длиннее 6 символов — payload кнопки ограничен 64 байтами в Telegram */
    id: string;
    title: string;
    /** Переспросить перед действием */
    confirm?: { text: string; yes: string };
    /** Сначала выбрать вариант кнопкой */
    options?: IActionOption[];
    /** Сначала ответить на вопрос */
    input?: IQuestion;
}

/** Что пользователь выбрал и ответил перед действием. */
export interface IActionInput {
    option?: string;
    answer?: string;
}

/** Изменения комнаты. settings сливаются с текущими. */
export interface IRoomPatch {
    status?: TRoomStatus;
    settings?: Record<string, string>;
}

/** Изменения участника. profile сливается с текущим. */
export interface IParticipantPatch {
    id: string;
    recipientId?: string | null;
    profile?: Record<string, string>;
    delivery?: TDelivery | null;
}

/** Поставить (value) или снять (null) отметку участника. */
export interface IMarkChange {
    participantId: string;
    key: string;
    value: string | null;
}

/** Сообщение организатору: он может и не быть участником комнаты. */
export interface IOwnerMessage {
    text: string;
    buttons?: IModeButton[];
    /** Ключ журнала рассылки: сообщение с таким ключом уходит не больше одного раза */
    key?: string;
}

/**
 * Результат действия режима. Режим не пишет в БД и не отправляет сообщения:
 * ядро проверяет права, сохраняет изменения и делает рассылку.
 */
export interface IModeResult {
    /** Ответ тому, кто нажал */
    reply?: string;
    /** Показать после ответа карточку комнаты (иначе — кнопка «К игре») */
    showRoom?: boolean;
    messages?: IPersonalMessage[];
    /** Сообщение организатору комнаты — по расписанию или событию режима */
    ownerMessage?: IOwnerMessage;
    room?: IRoomPatch;
    participants?: IParticipantPatch[];
    marks?: IMarkChange[];
}

/**
 * Режим игры. Ядро знает о комнатах и участниках, режим — о правилах игры.
 * Новый режим — папка в modes/ и строка в modes/registry.ts.
 */
export interface IMode {
    /** rooms.mode */
    id: string;
    title: string;
    /** Одна строка о режиме для главного меню */
    pitch: string;
    /** Разовое событие со сроком жизни или бессрочная комната */
    lifetime: 'event' | 'permanent';
    minParticipants: number;
    maxParticipants: number;
    /** Когда режим поднимается в меню первым: { from: '11-15', to: '12-31' } */
    season?: { from: string; to: string };
    /** Вопросы организатору при создании → rooms.settings */
    createQuestions: IQuestion[];
    /** Вопросы участнику при входе → participants.profile (имя спрашивает ядро) */
    joinQuestions: IQuestion[];
    /** Кто кому может писать анонимно */
    relay: TRelayMode;
    /** Сколько анонимных сообщений может отправить один участник в комнате */
    relayLimit?: number;
    /** Когда доставлять анонимные сообщения; null — сразу */
    relayDeliverAt?(room: IRoom): string | null;
    /** После этого момента новые сообщения не принимаются, независимо от cron. */
    relayDeadline?(room: IRoom): string;
    /** Можно ли отвечать на анонимные сообщения; по умолчанию можно */
    relayReplies?(room: IRoom): boolean;
    /** Фразы ядра, которые у каждой игры свои */
    texts: {
        /** Почему состав больше не изменить: «Жеребьёвка уже проведена» */
        closed: string;
        /** Ответ после входа в игру: «Вы в игре, ждём жеребьёвку» */
        joined: string;
        /** Кнопка анонимного сообщения; по умолчанию «Написать анонимно» */
        relay?: string;
    };
    /** Карточка комнаты и текст приглашения */
    describe(room: IRoom): string;
    /** Кнопки режима для этого человека в текущем состоянии комнаты */
    actions(ctx: IModeContext): IModeAction[];
    /** Нажатие кнопки режима */
    handle(action: string, ctx: IModeContext, input: IActionInput): Promise<IModeResult>;
    /**
     * Когда вызвать onSchedule (ISO); null — не нужно. Ядро пересчитывает
     * rooms.nextRunAt этой функцией после каждого изменения комнаты.
     */
    schedule?(ctx: IModeContext): string | null;
    /** Вызов из jobs/tick.ts, когда наступил rooms.nextRunAt */
    onSchedule?(ctx: IModeContext): Promise<IModeResult>;
    /** Когда удалить разовую комнату (lifetime: 'event') */
    expiresAt?(room: IRoom): string;
    /**
     * Настройки новой игры с теми же правилами («Сыграть ещё раз»): режим убирает
     * свои фазовые флаги — напоминания в новой комнате должны сработать заново.
     */
    cloneSettings?(settings: Record<string, string>): Record<string, string>;
    /**
     * Участник ушёл после фиксации состава: удалил свои данные (forget) или исключён
     * по жалобе (expel). gone — его запись до стирания имени.
     */
    onLeave?(ctx: IModeContext, gone: IParticipant, reason: 'forget' | 'expel'): IModeResult;
}
