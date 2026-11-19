import { addDays, formatDate, zonedTime } from '../../core/time';
import { platformLabel } from '../../texts';
import { IParticipant, IRoom } from '../../core/types';
import { IQuestion } from '../../core/Wizard';
import {
    IModeAction,
    IModeButton,
    IModeContext,
    IModeResult,
    IPersonalMessage,
    IMode,
} from '../IMode';
import { drawChain } from '../shared/draw';
import { clipText } from '../../ui';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Комната живёт 30 дней после даты обмена */
const KEEP_AFTER_EVENT = 30 * DAY_MS;
/** Без даты обмена — 90 дней после создания */
const KEEP_WITHOUT_EVENT = 90 * DAY_MS;
/** Напоминание об обмене — за 2 дня, в 10 утра по времени комнаты */
const REMIND_DAYS_BEFORE = 2;
const REMIND_TIME = '10:00';
/** Набор без даты обмена, который висит дольше этого срока, — пора напомнить организатору */
const NUDGE_AFTER_DAYS = 7;

const WISH: IQuestion = {
    key: 'wish',
    prompt: 'Напишите пожелание к подарку (до 300 символов) или нажмите «Без пожелания».',
    type: 'text',
    optional: true,
    skipLabel: 'Без пожелания',
    maxLength: 300,
    label: 'Пожелание',
};

const EVENT_DATE: IQuestion = {
    key: 'eventDate',
    prompt: 'Когда обмен подарками? Например: «27 декабря».',
    type: 'date',
    notPast: true,
};

const MIN_PARTICIPANTS = 3;

/** Отметки вручения подарка: их видит сводка организатора. */
const GIFT_GIVEN = 'gift-given';
const GIFT_RECEIVED = 'gift-received';

/** Кнопки дарителя после жеребьёвки: посмотреть пару и спросить подопечного анонимно. */
const giverButtons: IModeButton[] = [
    { title: 'Кому я дарю?', action: 'whom' },
    { title: 'Анонимный вопрос подопечному', relay: true },
];

function settingsLines(room: IRoom): string[] {
    const lines: string[] = [];
    if (room.settings.budget) {
        lines.push(`Бюджет: ${room.settings.budget}`);
    }
    if (room.settings.eventDate) {
        lines.push(`Обмен: ${formatDate(room.settings.eventDate)}`);
    }
    return lines;
}

/**
 * Имя участника с различителем, если в комнате есть тёзка:
 * в парах и уведомлениях человек должен понять, о ком речь.
 */
function displayName(participants: readonly IParticipant[], p: IParticipant): string {
    const same = participants.filter((o) => o.userId && o.name === p.name);
    return same.length > 1 ? `${p.name} (${platformLabel(p.platform)})` : p.name;
}

/** Этот участник — организатор комнаты? */
function isRoomOwner(room: IRoom, p: IParticipant): boolean {
    return p.platform === room.ownerPlatform && p.userId === room.ownerUserId;
}

/** Результат жеребьёвки для дарителя: имя и пожелание подопечного. */
function resultText(
    room: IRoom,
    participants: readonly IParticipant[],
    giver: IParticipant,
    recipient: IParticipant | undefined,
): string {
    if (!recipient?.userId) {
        // Организатору советовать «напишите организатору» — совет самому себе
        return isRoomOwner(room, giver)
            ? `«${room.title}»: ваш подопечный вышел из игры.`
            : `«${room.title}»: ваш подопечный вышел из игры. Напишите организатору.`;
    }
    return [
        `🎁 «${room.title}»: вы — Тайный Санта. Ваш подопечный: ${displayName(participants, recipient)}.`,
        `Пожелание: ${recipient.profile.wish || 'не указано'}`,
        ...settingsLines(room),
        // Следующий шаг проговаривается словами: пользователь без экрана не видит кнопки
        'Вы можете анонимно спросить подопечного, что он хочет.',
    ].join('\n');
}

function recipientOf(ctx: IModeContext, giver: IParticipant): IParticipant | undefined {
    return ctx.participants.find((p) => p.id === giver.recipientId);
}

/** Есть ли у участника отметка с этим ключом. */
function isMarked(ctx: IModeContext, participantId: string, key: string): boolean {
    return ctx.marks.some((m) => m.participantId === participantId && m.key === key);
}

/** Участник, нажавший кнопку: действия wish и whom режим показывает только участникам. */
function self(ctx: IModeContext): IParticipant {
    if (!ctx.me) {
        throw new Error('Действие участника вызвано не участником');
    }
    return ctx.me;
}

/** Персональное сообщение дарителю: результат, вопрос подопечному и учёт доставки. */
function resultMessage(ctx: IModeContext, giver: IParticipant): IPersonalMessage {
    return {
        to: giver.id,
        text: resultText(ctx.room, ctx.participants, giver, recipientOf(ctx, giver)),
        buttons: giverButtons,
        track: true,
    };
}

function draw(ctx: IModeContext): IModeResult {
    const active = ctx.participants.filter((p) => p.userId);
    if (active.length < MIN_PARTICIPANTS) {
        return {
            reply: `Для жеребьёвки нужно не меньше ${MIN_PARTICIPANTS} участников, сейчас ${active.length}.`,
        };
    }
    const pairs = drawChain(active.map((p) => p.id));
    const drawn = active.map((p) => ({ ...p, recipientId: pairs.get(p.id) ?? null }));
    const after: IModeContext = { ...ctx, participants: drawn };
    return {
        reply: 'Жеребьёвка проведена, рассылаю результаты участникам…',
        room: { status: 'closed' },
        participants: drawn.map((p) => ({ id: p.id, recipientId: p.recipientId })),
        messages: drawn.map((p) => resultMessage(after, p)),
    };
}

/** Сводка вручения подарков для организатора: кто кому и отметки. */
function handoverText(ctx: IModeContext): string {
    const active = ctx.participants.filter((p) => p.userId);
    const lines = [`Кто кому дарит в «${ctx.room.title}»:`];
    for (const giver of active) {
        const recipient = recipientOf(ctx, giver);
        const parts = [
            `${displayName(active, giver)} → ${recipient?.userId ? displayName(active, recipient) : 'подопечный вышел'}`,
        ];
        parts.push(isMarked(ctx, giver.id, GIFT_GIVEN) ? 'подарок ✓' : 'подарок —');
        if (recipient?.userId) {
            parts.push(isMarked(ctx, recipient.id, GIFT_RECEIVED) ? 'получено ✓' : 'получено —');
        }
        lines.push(parts.join(' · '));
    }
    // Ушедший участник оставил без Санты того, кому должен был дарить, — это видно сразу
    const orphaned = active.filter((p) => {
        const santa = ctx.participants.find((g) => g.recipientId === p.id);
        return !santa?.userId;
    });
    if (orphaned.length) {
        lines.push(
            `Остались без Санты: ${orphaned.map((p) => displayName(active, p)).join(', ')}.`,
        );
    }
    return clipText(lines.join('\n'));
}

function ownerActions(ctx: IModeContext): IModeAction[] {
    const { room, participants } = ctx;
    if (room.status === 'open') {
        return [
            {
                id: 'draw',
                title: 'Провести жеребьёвку',
                confirm: {
                    text: 'После жеребьёвки состав не изменить. Провести?',
                    yes: 'Да, провести',
                },
            },
            { id: 'date', title: 'Изменить дату обмена', input: EVENT_DATE },
        ];
    }
    if (room.status === 'closed') {
        const failed = participants.some((p) => p.userId && p.delivery === 'failed');
        return [
            ...(failed ? [{ id: 'retry', title: 'Повторить отправку' }] : []),
            // Без подтверждения: вопрос о дате и есть подтверждение, а перенос
            // обратим — дату можно изменить снова. Это тот же порядок, что у встречи
            { id: 'date', title: 'Изменить дату обмена', input: EVENT_DATE },
            { id: 'handover', title: 'Кто кому дарит' },
            { id: 'finish', title: 'Завершить игру' },
        ];
    }
    return [{ id: 'handover', title: 'Кто кому дарит' }];
}

/** Когда напомнить дарителям об обмене; null — напоминать не нужно. */
function reminderAt(ctx: IModeContext): string | null {
    const { room, now } = ctx;
    const eventDate = room.settings.eventDate;
    if (room.status !== 'closed' || !eventDate || room.settings.reminded) {
        return null;
    }
    // Жеребьёвку провели позже срока напоминания — напоминаем сразу, но не после обмена
    if (zonedTime(eventDate, '00:00', room.timezone) <= now.toISOString()) {
        return null;
    }
    return zonedTime(addDays(eventDate, -REMIND_DAYS_BEFORE), REMIND_TIME, room.timezone);
}

/**
 * Набор, который висит дольше недели без даты обмена, — напоминание организатору
 * один раз: возможно, про игру забыли. С датой обмена не подгоняем — о ней напомнит
 * напоминание дарителям.
 */
function nudgeAt(ctx: IModeContext): string | null {
    const { room } = ctx;
    if (room.status !== 'open' || room.settings.eventDate || room.settings.nudged) {
        return null;
    }
    return new Date(Date.parse(room.createdAt) + NUDGE_AFTER_DAYS * DAY_MS).toISOString();
}

/**
 * Режим «Тайный Санта»: участники выстраиваются в одну цепочку дарителей,
 * каждый получает имя и пожелание своего подопечного. За 2 дня до обмена бот
 * напоминает дарителям, а даритель может анонимно спросить подопечного о подарке.
 */
/** Перенос даты: после жеребьёвки дарители узнают о новой дате сразу. */
function rescheduleResult(ctx: IModeContext, input: { answer?: string }): IModeResult {
    const date = input.answer ?? '';
    const result: IModeResult = {
        reply: date ? `Обмен перенесён: ${formatDate(date)}.` : 'Дата обмена убрана.',
        showRoom: true,
        room: {
            settings: {
                eventDate: date,
                // Напоминание по новой дате отправится заново
                ...(ctx.room.status === 'closed' ? { reminded: '' } : {}),
            },
        },
    };
    if (ctx.room.status === 'closed' && date) {
        result.messages = ctx.participants
            .filter((p) => p.userId && p.recipientId)
            .map((giver) => ({
                to: giver.id,
                text: `🎄 «${ctx.room.title}»: обмен подарками перенесён на ${formatDate(date)}.`,
                buttons: [{ title: 'Кому я дарю?', action: 'whom' }],
            }));
    }
    return result;
}

/** Изменение пожелания после жеребьёвки: Санта покупает по нему — предупреждаем. */
function wishResult(ctx: IModeContext, input: { answer?: string }): IModeResult {
    const me = self(ctx);
    const result: IModeResult = {
        reply:
            ctx.room.status === 'closed'
                ? 'Пожелание сохранено. Ваш Тайный Санта получит обновление.'
                : 'Пожелание сохранено.',
        showRoom: true,
        participants: [{ id: me.id, profile: { wish: input.answer ?? '' } }],
    };
    if (ctx.room.status === 'closed') {
        const giver = ctx.participants.find((p) => p.recipientId === me.id);
        if (giver?.userId) {
            result.messages = [
                {
                    to: giver.id,
                    text: [
                        `✏️ «${ctx.room.title}»: пожелание вашего подопечного (${displayName(ctx.participants, me)}) изменилось.`,
                        `Новое пожелание: ${input.answer || 'не указано'}.`,
                    ].join('\n'),
                },
            ];
        }
    }
    return result;
}

export const SantaMode: IMode = {
    id: 'santa',
    title: 'Тайный Санта',
    pitch: 'Здесь можно сыграть в Тайного Санту с коллегами и друзьями, даже если все сидят в разных мессенджерах: Telegram, VK, MAX или Алиса. Для жеребьёвки нужно минимум три участника.',
    lifetime: 'event',
    minParticipants: MIN_PARTICIPANTS,
    maxParticipants: 100,
    season: { from: '11-01', to: '12-31' },
    createQuestions: [
        {
            key: 'budget',
            prompt: 'Какой бюджет подарка? Например: «до 1500 ₽».',
            type: 'text',
            optional: true,
            skipLabel: 'Без бюджета',
            maxLength: 60,
            options: [
                { title: '1000 ₽', value: 'до 1000 ₽', aliases: ['1000'] },
                { title: '1500 ₽', value: 'до 1500 ₽', aliases: ['1500'] },
                { title: '2000 ₽', value: 'до 2000 ₽', aliases: ['2000'] },
                { title: '3000 ₽', value: 'до 3000 ₽', aliases: ['3000'] },
                { title: '5000 ₽', value: 'до 5000 ₽', aliases: ['5000'] },
            ],
        },
        {
            key: 'eventDate',
            prompt: 'Когда обмен подарками? Например: «27 декабря».',
            type: 'date',
            optional: true,
            notPast: true,
            skipLabel: 'Без даты',
            options: [
                { title: '25 декабря', value: '25 декабря', aliases: ['25 декабря'] },
                { title: '26 декабря', value: '26 декабря', aliases: ['26 декабря'] },
                { title: '27 декабря', value: '27 декабря', aliases: ['27 декабря'] },
                { title: '28 декабря', value: '28 декабря', aliases: ['28 декабря'] },
                { title: '29 декабря', value: '29 декабря', aliases: ['29 декабря'] },
                { title: '30 декабря', value: '30 декабря', aliases: ['30 декабря'] },
            ],
        },
    ],
    joinQuestions: [WISH],
    relay: 'giver-to-recipient',
    texts: {
        closed: 'Жеребьёвка уже проведена',
        joined: 'Вы в игре, ждём жеребьёвку.',
        relay: 'Анонимный вопрос подопечному',
    },

    describe(room: IRoom): string {
        const lines = [`🎅 Тайный Санта «${room.title}»`];
        if (room.settings.ownerName) {
            lines.push(`Организатор: ${room.settings.ownerName}`);
        }
        return [...lines, ...settingsLines(room)].join('\n');
    },

    actions(ctx: IModeContext): IModeAction[] {
        const { room, me } = ctx;
        const actions: IModeAction[] = [];
        // Пожелание можно менять и после жеребьёвки: Санта получит обновление
        if (me && room.status !== 'finished') {
            actions.push({ id: 'wish', title: 'Изменить пожелание', input: WISH });
        }
        if (me?.recipientId) {
            actions.push({ id: 'whom', title: 'Кому я дарю?' });
        }
        if (me && room.status === 'closed') {
            actions.push({
                id: 'given',
                title: isMarked(ctx, me.id, GIFT_GIVEN)
                    ? 'Отменить: я подарил'
                    : 'Я подарил подарок',
            });
            actions.push({
                id: 'received',
                title: isMarked(ctx, me.id, GIFT_RECEIVED)
                    ? 'Отменить: я получил'
                    : 'Я получил подарок',
            });
        }
        return ctx.isOwner ? [...actions, ...ownerActions(ctx)] : actions;
    },

    async handle(action, ctx, input): Promise<IModeResult> {
        switch (action) {
            case 'draw':
                return draw(ctx);
            case 'date':
                return rescheduleResult(ctx, input);
            case 'wish':
                return wishResult(ctx, input);
            case 'whom':
                return {
                    reply: resultText(
                        ctx.room,
                        ctx.participants,
                        self(ctx),
                        recipientOf(ctx, self(ctx)),
                    ),
                };
            case 'given': {
                const me = self(ctx);
                const marked = isMarked(ctx, me.id, GIFT_GIVEN);
                const recipient = recipientOf(ctx, me);
                const whom = recipient?.userId ? ` ${recipient.name}` : '';
                const date = ctx.room.settings.eventDate
                    ? ` Обмен: ${formatDate(ctx.room.settings.eventDate)}.`
                    : '';
                return {
                    reply: marked
                        ? 'Отметка «подарил» снята.'
                        : `Отмечено: вы подарили подарок. Подопечный: ${whom}.${date}`,
                    showRoom: true,
                    marks: [{ participantId: me.id, key: GIFT_GIVEN, value: marked ? null : '1' }],
                };
            }
            case 'received': {
                const me = self(ctx);
                const marked = isMarked(ctx, me.id, GIFT_RECEIVED);
                return {
                    reply: marked
                        ? 'Отметка «получил» снята.'
                        : 'Поздравляем! Отмечено: подарок получен.',
                    showRoom: true,
                    marks: [
                        { participantId: me.id, key: GIFT_RECEIVED, value: marked ? null : '1' },
                    ],
                };
            }
            case 'handover':
                return { reply: handoverText(ctx) };
            case 'retry':
                return {
                    reply: 'Отправляю результаты повторно…',
                    messages: ctx.participants
                        .filter((p) => p.userId && p.delivery === 'failed')
                        .map((p) => resultMessage(ctx, p)),
                };
            case 'finish':
                return {
                    reply: `Игра «${ctx.room.title}» завершена.`,
                    showRoom: true,
                    room: { status: 'finished' },
                    // Участники узнают о завершении так же, как на встрече
                    messages: ctx.participants
                        .filter(
                            (p) =>
                                p.userId &&
                                (p.platform !== ctx.room.ownerPlatform ||
                                    p.userId !== ctx.room.ownerUserId),
                        )
                        .map((p) => ({
                            to: p.id,
                            text: `Игра «${ctx.room.title}» завершена. Спасибо, что играли!`,
                        })),
                };
            default:
                return {};
        }
    },

    schedule: (ctx) => (ctx.room.status === 'open' ? nudgeAt(ctx) : reminderAt(ctx)),

    async onSchedule(ctx: IModeContext): Promise<IModeResult> {
        const { room } = ctx;
        if (room.status === 'open') {
            return {
                ownerMessage: {
                    key: `santa-nudge:${room.id}`,
                    text: [
                        `🎅 «${room.title}»: игра в наборе уже больше недели.`,
                        'Напомните участникам код игры или проведите жеребьёвку, когда соберутся.',
                    ].join('\n'),
                },
                room: { settings: { nudged: '1' } },
            };
        }
        const date = formatDate(room.settings.eventDate ?? '');
        const eventDate = room.settings.eventDate ?? '';
        const messages: IPersonalMessage[] = [];
        for (const giver of ctx.participants.filter((p) => p.userId)) {
            // Даритель, чей подопечный ушёл, уже получил уведомление об этом (onLeave)
            const recipient = recipientOf(ctx, giver);
            if (recipient?.userId) {
                messages.push({
                    to: giver.id,
                    // Дата в ключе: после переноса обмена напоминание уходит заново
                    key: `santa-remind:${room.id}:${eventDate}:${giver.id}`,
                    text: [
                        `🎄 «${room.title}»: обмен подарками ${date}. Вы дарите: ${displayName(ctx.participants, recipient)}.`,
                        `Пожелание: ${recipient.profile.wish || 'не указано'}`,
                    ].join('\n'),
                    buttons: giverButtons,
                });
            }
        }
        return { room: { settings: { reminded: '1' } }, messages };
    },

    expiresAt(room: IRoom): string {
        const eventDate = room.settings.eventDate;
        const time = eventDate
            ? Date.parse(`${eventDate}T23:59:59Z`) + KEEP_AFTER_EVENT
            : Date.parse(room.createdAt) + KEEP_WITHOUT_EVENT;
        return new Date(time).toISOString();
    },

    onLeave(ctx: IModeContext, gone: IParticipant): IModeResult {
        const messages: IPersonalMessage[] = [];
        // Даритель подопечного-ушедшего должен знать, что пары больше нет
        const giver = ctx.participants.find((p) => p.recipientId === gone.id && p.userId);
        if (giver && giver.id !== gone.id) {
            // Причина ухода (удалил данные или исключён организатором) дарителя не касается
            messages.push({
                to: giver.id,
                text: isRoomOwner(ctx.room, giver)
                    ? `«${ctx.room.title}»: ваш подопечный ${displayName(ctx.participants, gone)} больше не участвует в игре.`
                    : `«${ctx.room.title}»: ваш подопечный ${displayName(ctx.participants, gone)} больше не участвует в игре. Напишите организатору.`,
            });
        }
        // Тот, кому ушедший должен был дарить, остался без Санты — молчать об этом нельзя
        const orphaned = ctx.participants.find((p) => p.id === gone.recipientId && p.userId);
        if (orphaned && orphaned.id !== gone.id) {
            // Имя Санты не раскрываем: игра-то продолжается
            messages.push({
                to: orphaned.id,
                text: isRoomOwner(ctx.room, orphaned)
                    ? `«${ctx.room.title}»: ваш Тайный Санта больше не участвует в игре. Вы организатор: договоритесь с участниками о подарке.`
                    : `«${ctx.room.title}»: ваш Тайный Санта больше не участвует в игре. Напишите организатору, чтобы договориться о подарке.`,
            });
        }
        return { messages };
    },

    cloneSettings(settings: Record<string, string>): Record<string, string> {
        // Фазовые флаги, дата прошлого обмена и список исключённых не переносятся:
        // напоминания в новой игре должны сработать заново, дата у прошлого обмена
        // уже прошла, а новая игра начинается с чистым составом
        const {
            nudged: _nudged,
            reminded: _reminded,
            eventDate: _eventDate,
            banned: _banned,
            ...rest
        } = settings;
        return rest;
    },
};
