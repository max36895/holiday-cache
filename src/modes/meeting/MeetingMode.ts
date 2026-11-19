import { formatDateTime } from '../../core/time';
import { IQuestion } from '../../core/Wizard';
import { IMode, IModeAction, IModeContext } from '../IMode';
import {
    eventAt,
    eventDescription,
    eventExpiresAt,
    FINISH,
    finished,
    TIMEZONE,
} from '../shared/events';

const DATE: IQuestion = {
    key: 'eventAt',
    type: 'datetime',
    prompt: 'Когда встречаемся? Например: «сегодня в 19:00» или «14 марта 19:00».',
    notPast: true,
};
const PLACE: IQuestion = {
    key: 'place',
    type: 'text',
    prompt: 'Где встречаемся? Укажите адрес или опишите место.',
    maxLength: 300,
};
const RSVP: IQuestion = {
    key: 'rsvp',
    label: 'Участие',
    type: 'choice',
    prompt: 'Придёте на встречу?',
    options: [
        { value: 'yes', title: 'Приду' },
        { value: 'no', title: 'Не приду' },
        { value: 'maybe', title: 'Пока не знаю' },
    ],
};

function paid(ctx: IModeContext, id: string): boolean {
    return ctx.marks.some((m) => m.participantId === id && m.key === 'paid');
}

export const MeetingMode: IMode = {
    id: 'meeting',
    title: 'Сбор на встречу',
    pitch: 'Сбор на встречу — кто придёт и кто сдал взнос (отметки — по желанию).',
    lifetime: 'event',
    minParticipants: 1,
    maxParticipants: 100,
    createQuestions: [
        TIMEZONE,
        DATE,
        PLACE,
        {
            key: 'contribution',
            type: 'number',
            prompt: 'Сумма взноса в рублях? Можно пропустить.',
            optional: true,
            min: 1,
            max: 1_000_000,
            options: [
                { title: '300 рублей', value: '300', aliases: ['300'] },
                { title: '500 рублей', value: '500', aliases: ['500'] },
                { title: '1000 рублей', value: '1000', aliases: ['1000'] },
                { title: '1500 рублей', value: '1500', aliases: ['1500'] },
                { title: '2000 рублей', value: '2000', aliases: ['2000'] },
            ],
        },
        {
            key: 'instructions',
            type: 'text',
            prompt: 'Как передать деньги? Можно пропустить.',
            optional: true,
            maxLength: 300,
            options: [
                { title: 'Переводом на карту', value: 'Переводом на карту', aliases: ['карту'] },
                { title: 'Наличными', value: 'Наличными', aliases: ['наличными', 'наличкой'] },
            ],
        },
    ],
    joinQuestions: [RSVP],
    relay: 'none',
    texts: {
        joined: 'Ответ сохранён, его можно изменить до завершения встречи.',
        closed: 'Встреча завершена',
    },
    describe(room) {
        return [
            eventDescription(room, 'Сбор на встречу'),
            `Место: ${room.settings.place}`,
            ...(room.settings.contribution
                ? [
                      `Взнос: ${room.settings.contribution} ₽`,
                      room.settings.instructions ?? '',
                      '«Я сдал» — заявление участника, не подтверждение платежа. Бот не принимает и не переводит деньги.',
                  ]
                : []),
        ]
            .filter(Boolean)
            .join('\n');
    },
    actions(ctx) {
        const actions: IModeAction[] = [];
        if (ctx.me && ctx.room.status !== 'finished') {
            actions.push({ id: 'rsvp', title: 'Изменить ответ', input: RSVP });
            if (ctx.room.settings.contribution) {
                actions.push({
                    id: 'paid',
                    title: paid(ctx, ctx.me.id) ? 'Снять отметку о взносе' : 'Я сдал',
                });
            }
        }
        if (ctx.isOwner) {
            actions.push({ id: 'tally', title: 'Ответы и взносы' });
            if (ctx.room.status !== 'finished') {
                actions.push(
                    { id: 'date', title: 'Изменить дату встречи', input: DATE },
                    { id: 'place', title: 'Изменить место встречи', input: PLACE },
                    FINISH,
                );
            }
        }
        return actions;
    },
    async handle(action, ctx, input) {
        const me = ctx.me;
        if (action === 'finish') {
            return {
                ...finished(ctx),
                messages: ctx.participants
                    .filter(
                        (p) =>
                            p.userId &&
                            (p.platform !== ctx.room.ownerPlatform ||
                                p.userId !== ctx.room.ownerUserId),
                    )
                    .map((p) => ({
                        to: p.id,
                        text: `Встреча «${ctx.room.title}» завершена. Спасибо за ответы!`,
                    })),
            };
        }
        if (action === 'rsvp' && me) {
            return {
                showRoom: true,
                participants: [{ id: me.id, profile: { rsvp: input.answer ?? 'maybe' } }],
            };
        }
        if (action === 'paid' && me) {
            return {
                reply: paid(ctx, me.id) ? 'Отметка снята.' : 'Отмечено с ваших слов.',
                showRoom: true,
                marks: [
                    { participantId: me.id, key: 'paid', value: paid(ctx, me.id) ? null : '1' },
                ],
            };
        }
        if (action === 'date' || action === 'place') {
            const settings = {
                [action === 'date' ? 'eventAt' : 'place']: input.answer ?? '',
                ...(action === 'date' ? { reminded: '' } : {}),
            };
            const room = { ...ctx.room, settings: { ...ctx.room.settings, ...settings } };
            const headline =
                action === 'date'
                    ? `Встреча перенесена: ${formatDateTime(input.answer ?? '')}.`
                    : `Встреча теперь в другом месте: ${input.answer ?? ''}.`;
            return {
                showRoom: true,
                room: { settings },
                messages: ctx.participants
                    .filter((p) => p.userId)
                    .map((p) => ({
                        to: p.id,
                        text: `${headline}\n${MeetingMode.describe(room)}`,
                    })),
            };
        }
        const active = ctx.participants.filter((p) => p.userId);
        return {
            reply: [
                ...(RSVP.options ?? []).map(
                    (o) => `${o.title}: ${active.filter((p) => p.profile.rsvp === o.value).length}`,
                ),
                ...active.map(
                    (p) =>
                        `${p.name}: ${RSVP.options?.find((o) => o.value === p.profile.rsvp)?.title ?? 'Пока не знаю'}${ctx.room.settings.contribution ? `; взнос ${paid(ctx, p.id) ? 'отмечен' : 'не отмечен'}` : ''}`,
                ),
            ].join('\n'),
        };
    },
    schedule(ctx) {
        return ctx.room.settings.reminded
            ? null
            : new Date(Date.parse(eventAt(ctx.room)) - 86400000).toISOString();
    },
    async onSchedule(ctx) {
        const at = eventAt(ctx.room);
        return {
            room: { settings: { reminded: '1' } },
            messages:
                at <= ctx.now.toISOString()
                    ? []
                    : ctx.participants
                          .filter((p) => p.userId && p.profile.rsvp !== 'no')
                          .map((p) => ({
                              to: p.id,
                              key: `meeting:${at}:${p.id}`,
                              text: `Скоро встреча!\n${MeetingMode.describe(ctx.room)}`,
                          })),
        };
    },
    expiresAt: eventExpiresAt,
    cloneSettings(settings) {
        // Дата прошлой встречи не переносится: организатор задаёт новую
        const {
            eventAt: _eventAt,
            reminded: _reminded,
            finishedAt: _finishedAt,
            ...rest
        } = settings;
        return rest;
    },
};
