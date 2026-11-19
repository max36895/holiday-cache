import { IMode } from '../IMode';
import {
    eventAt,
    eventDescription,
    eventExpiresAt,
    FINISH,
    finished,
    TIMEZONE,
} from '../shared/events';

export const ValentineMode: IMode = {
    id: 'valentines',
    title: 'Анонимные валентинки',
    pitch: 'Анонимные валентинки — поздравления, которые откроются в назначенное время.',
    lifetime: 'event',
    minParticipants: 2,
    maxParticipants: 100,
    createQuestions: [
        TIMEZONE,
        {
            key: 'eventAt',
            type: 'datetime',
            prompt: 'Когда доставить валентинки? Например: 14 февраля 10:00.',
            notPast: true,
            options: [
                { title: '13 февраля в 18:00', value: '13 февраля 18:00' },
                { title: '14 февраля в 08:00', value: '14 февраля 08:00' },
                { title: '14 февраля в 10:00', value: '14 февраля 10:00' },
                { title: '14 февраля в 15:00', value: '14 февраля 15:00' },
            ],
        },
    ],
    joinQuestions: [],
    relay: 'any-to-any',
    relayLimit: 20,
    relayDeliverAt: eventAt,
    relayDeadline: eventAt,
    relayReplies: () => false,
    texts: {
        joined: 'Вы в игре. Можно отправить до 20 анонимных поздравлений по 500 символов.',
        closed: 'Приём валентинок завершён',
        relay: 'Написать анонимно',
    },
    describe: (room) =>
        `${eventDescription(room, 'Анонимные валентинки')}\n${
            room.status === 'open'
                ? 'До этого времени сообщения скрыты. Лимит: 20 поздравлений по 500 символов.'
                : 'Сообщения читайте во «Входящих сообщениях» карточки игры.'
        }`,
    actions: (ctx) =>
        ctx.isOwner && ctx.room.status !== 'finished' && eventAt(ctx.room) <= ctx.now.toISOString()
            ? [FINISH]
            : [],
    async handle(_action, ctx) {
        return finished(ctx);
    },
    cloneSettings(settings) {
        // Дата прошлого праздника не переносится: организатор задаёт новую дату
        const { eventAt: _eventAt, finishedAt: _finishedAt, ...rest } = settings;
        return rest;
    },
    schedule: (ctx) => (ctx.room.status === 'open' ? eventAt(ctx.room) : null),
    async onSchedule() {
        return { room: { status: 'closed' } };
    },
    expiresAt: eventExpiresAt,
};
