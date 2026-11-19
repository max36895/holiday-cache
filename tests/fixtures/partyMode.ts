import { addDays, localDate, zonedTime } from '../../src/core/time';
import { IParticipant } from '../../src/core/types';
import { IModeAction, IModeContext, IModeResult, IMode } from '../../src/modes/IMode';
import { drawGroups } from '../../src/modes/shared/draw';

/** Ближайшая дата дня рождения MM-DD не раньше from (YYYY-MM-DD). */
function nextBirthday(monthDay: string, from: string): string {
    const year = Number(from.slice(0, 4));
    const thisYear = `${year}-${monthDay}`;
    return thisYear >= from ? thisYear : `${year + 1}-${monthDay}`;
}

function earliestBirthday(ctx: IModeContext): string | null {
    const today = localDate(ctx.now, ctx.room.timezone);
    const lastRun = ctx.room.settings.lastRun;
    const from = lastRun && lastRun >= today ? addDays(lastRun, 1) : today;
    const dates = ctx.participants
        .filter((p) => p.userId && p.profile.bday)
        .map((p) => nextBirthday(p.profile.bday as string, from))
        .sort();
    return dates[0] ?? null;
}

function team(ctx: IModeContext, value: string): IParticipant[] {
    return ctx.participants.filter((p) => p.userId && p.profile.team === value);
}

/**
 * Тестовый режим из критериев приёмки: задействует все возможности ядра —
 * бессрочную комнату, вопросы при входе, несколько действий, расписание,
 * пересылку «любой → любой», отметки и жеребьёвку по группам.
 */
export const PartyMode: IMode = {
    id: 'party',
    title: 'Тестовая вечеринка',
    pitch: 'Вечеринка для проверки ядра.',
    lifetime: 'permanent',
    minParticipants: 2,
    maxParticipants: 50,
    createQuestions: [
        {
            key: 'timezone',
            prompt: 'Часовой пояс?',
            type: 'choice',
            options: [
                { value: 'Europe/Moscow', title: 'Москва' },
                { value: 'Asia/Novosibirsk', title: 'Новосибирск' },
            ],
        },
        { key: 'deliverAt', prompt: 'Когда доставлять записки?', type: 'datetime', optional: true },
    ],
    joinQuestions: [
        { key: 'bday', prompt: 'День рождения?', type: 'daymonth', label: 'День рождения' },
        {
            key: 'team',
            prompt: 'Команда?',
            type: 'choice',
            label: 'Команда',
            options: [
                { value: 'a', title: 'Команда А' },
                { value: 'b', title: 'Команда Б' },
            ],
        },
    ],
    relay: 'any-to-any',
    relayLimit: 2,
    relayDeliverAt(room) {
        const at = room.settings.deliverAt;
        return at ? zonedTime(at.slice(0, 10), at.slice(11, 16), room.timezone) : null;
    },
    texts: { closed: 'Состав зафиксирован', joined: 'Добро пожаловать.' },

    describe(room) {
        return `🎉 Вечеринка «${room.title}»`;
    },

    actions(ctx): IModeAction[] {
        const actions: IModeAction[] = [];
        if (ctx.me) {
            const paid = ctx.marks.some((m) => m.participantId === ctx.me?.id && m.key === 'paid');
            actions.push(
                {
                    id: 'vote',
                    title: 'Голосовать',
                    options: [
                        { value: 'yes', title: 'За' },
                        { value: 'no', title: 'Против' },
                    ],
                },
                { id: 'paid', title: paid ? 'Отменить взнос' : 'Я скинулся' },
                {
                    id: 'note',
                    title: 'Заметка',
                    input: { key: 'note', prompt: 'Текст заметки?', type: 'text', maxLength: 50 },
                },
            );
        }
        if (ctx.isOwner) {
            actions.push({ id: 'tally', title: 'Итоги' });
            if (ctx.room.status === 'open') {
                actions.push({
                    id: 'groups',
                    title: 'Жеребьёвка',
                    confirm: { text: 'Точно?', yes: 'Да' },
                });
            }
        }
        return actions;
    },

    async handle(action, ctx, input): Promise<IModeResult> {
        const me = ctx.me as IParticipant;
        switch (action) {
            case 'vote':
                return {
                    reply: 'Голос принят.',
                    marks: [{ participantId: me.id, key: 'vote', value: input.option ?? null }],
                };
            case 'paid': {
                const paid = ctx.marks.some((m) => m.participantId === me.id && m.key === 'paid');
                return {
                    reply: paid ? 'Отметка снята.' : 'Отмечено.',
                    marks: [{ participantId: me.id, key: 'paid', value: paid ? null : '1' }],
                };
            }
            case 'note':
                return {
                    reply: 'Заметка сохранена.',
                    participants: [{ id: me.id, profile: { note: input.answer ?? '' } }],
                };
            case 'tally': {
                const count = (key: string, value?: string): number =>
                    ctx.marks.filter(
                        (m) => m.key === key && (value === undefined || m.value === value),
                    ).length;
                return {
                    reply: `За: ${count('vote', 'yes')}, против: ${count('vote', 'no')}, скинулись: ${count('paid')}.`,
                };
            }
            case 'groups': {
                const pairs = drawGroups(
                    team(ctx, 'a').map((p) => p.id),
                    team(ctx, 'b').map((p) => p.id),
                );
                const name = (id: string): string =>
                    ctx.participants.find((p) => p.id === id)?.name ?? '';
                return {
                    reply: 'Пары составлены.',
                    room: { status: 'closed' },
                    marks: pairs.map((p) => ({
                        participantId: p.giver,
                        key: `gift:${p.recipient}`,
                        value: '1',
                    })),
                    messages: pairs.map((p) => ({
                        to: p.giver,
                        text: `Вы дарите: ${name(p.recipient)}`,
                        track: true,
                    })),
                };
            }
            default:
                return {};
        }
    },

    schedule(ctx) {
        const date = earliestBirthday(ctx);
        return date ? zonedTime(date, '10:00', ctx.room.timezone) : null;
    },

    async onSchedule(ctx): Promise<IModeResult> {
        const today = localDate(ctx.now, ctx.room.timezone);
        const heroes = ctx.participants.filter(
            (p) => p.userId && p.profile.bday === today.slice(5),
        );
        return {
            room: { settings: { lastRun: today } },
            messages: heroes.flatMap((hero) =>
                ctx.participants
                    .filter((p) => p.userId && p.id !== hero.id)
                    .map((p) => ({
                        to: p.id,
                        key: `bday:${today}:${hero.id}:${p.id}`,
                        text: `Сегодня день рождения у ${hero.name}`,
                    })),
            ),
        };
    },
};

/** Второй режим для меню выбора: сезонный, с 1 по 31 июля. */
export const SummerMode: IMode = {
    ...PartyMode,
    id: 'summer',
    title: 'Летник',
    pitch: 'Летняя игра.',
    season: { from: '07-01', to: '07-31' },
};
