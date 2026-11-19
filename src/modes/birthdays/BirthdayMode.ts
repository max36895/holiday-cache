import { addDays, formatDate, localDate, zonedTime } from '../../core/time';
import { IParticipant } from '../../core/types';
import { IQuestion } from '../../core/Wizard';
import { IMode, IModeContext, IPersonalMessage } from '../IMode';
import { TIMEZONE } from '../shared/events';
import { clipText } from '../../ui';

const BIRTHDAY: IQuestion = {
    key: 'birthday',
    type: 'daymonth',
    label: 'День рождения',
    prompt: 'Когда ваш день рождения? Укажите только день и месяц, например 29 февраля.',
};

function birthdayIn(monthDay: string, year: number): string {
    const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
    return `${year}-${monthDay === '02-29' && !leap ? '02-28' : monthDay}`;
}

function nextBirthday(p: IParticipant, ctx: IModeContext): string {
    const today = localDate(ctx.now, ctx.room.timezone);
    const year = Number(today.slice(0, 4));
    const date = birthdayIn(p.profile.birthday as string, year);
    return date >= today ? date : birthdayIn(p.profile.birthday as string, year + 1);
}

/** Курсор сохраняется в комнате; изменение даты не порождает прошедшие события. */
function events(
    ctx: IModeContext,
): { at: string; date: string; hero: IParticipant; days: number }[] {
    const from = ctx.room.settings.birthdayCursor ?? ctx.room.createdAt;
    const firstYear = Number(localDate(new Date(from), ctx.room.timezone).slice(0, 4));
    const lastYear = Number(localDate(ctx.now, ctx.room.timezone).slice(0, 4)) + 2;
    const result = [];
    for (const hero of ctx.participants.filter((p) => p.userId && p.profile.birthday)) {
        for (let year = firstYear; year <= lastYear; year++) {
            const date = birthdayIn(hero.profile.birthday as string, year);
            for (const days of [7, 0]) {
                const at = zonedTime(addDays(date, -days), '10:00', ctx.room.timezone);
                if (at > from && at >= (hero.profile.birthdayUpdated ?? hero.joinedAt)) {
                    result.push({ at, date, hero, days });
                }
            }
        }
    }
    return result.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Текст напоминания. 29 февраля в невисокосный год празднуем 28-го:
 * показываем настоящую дату и объясняем сдвиг — чтобы читалось как фишка, а не баг.
 */
function reminderText(
    title: string,
    e: { date: string; hero: IParticipant; days: number },
): string {
    const birthday = e.hero.profile.birthday as string;
    const date = formatDate(birthday);
    // Дата праздника отличается от названной только у 29 февраля в невисокосный год
    const shifted = e.date.slice(5) !== birthday;
    if (!shifted) {
        return `«${title}»: ${e.days ? 'через 7 дней' : 'сегодня'} день рождения отмечает ${e.hero.name} — ${date}.`;
    }
    return e.days
        ? `«${title}»: через неделю день рождения отмечает ${e.hero.name} — ${date} (в этом году поздравим 28-го).`
        : `«${title}»: сегодня день рождения отмечает ${e.hero.name} — ${date}! В этом году такого дня нет, поэтому поздравляем 28-го 🎉`;
}

export const BirthdayMode: IMode = {
    id: 'birthdays',
    title: 'Дни рождения команды',
    pitch: 'Дни рождения команды — общий календарь и напоминания за 7 дней и в сам день.',
    lifetime: 'permanent',
    minParticipants: 1,
    maxParticipants: 100,
    createQuestions: [TIMEZONE],
    joinQuestions: [BIRTHDAY],
    relay: 'none',
    texts: {
        joined: 'Дата сохранена. Дни рождения видны всем участникам.',
        closed: 'Комната закрыта',
    },
    describe: (room) =>
        `Дни рождения команды «${room.title}»\nЧасовой пояс: ${room.timezone}. Напоминания в 10:00.`,
    actions: (ctx) => [
        { id: 'dates', title: 'Ближайшие дни рождения' },
        ...(ctx.me ? [{ id: 'bday', title: 'Изменить день рождения', input: BIRTHDAY }] : []),
    ],
    async handle(action, ctx, input) {
        if (action === 'bday' && ctx.me) {
            const birthday = input.answer ?? '';
            return {
                reply:
                    birthday === '02-29'
                        ? 'Дата обновлена. В невисокосные годы поздравим 28 февраля.'
                        : 'Дата обновлена.',
                showRoom: true,
                participants: [
                    {
                        id: ctx.me.id,
                        profile: {
                            birthday,
                            birthdayUpdated: ctx.now.toISOString(),
                        },
                    },
                ],
            };
        }
        const today = localDate(ctx.now, ctx.room.timezone);
        const dates = ctx.participants
            .filter((p) => p.userId && p.profile.birthday)
            .map((p) => ({ p, date: nextBirthday(p, ctx) }))
            .sort((a, b) => a.date.localeCompare(b.date));
        return {
            reply: dates.length
                ? clipText(
                      dates
                          .map(
                              ({ p, date }) =>
                                  // Показываем дату, которую назвал человек: у родившихся
                                  // 29 февраля она и есть 29 февраля, а не подставной день
                                  `${p.name}: ${formatDate(p.profile.birthday as string)}${
                                      date === today ? ' — сегодня!' : ''
                                  }`,
                          )
                          .join('\n'),
                  )
                : 'Даты пока не указаны.',
        };
    },
    schedule: (ctx) => events(ctx)[0]?.at ?? null,
    async onSchedule(ctx) {
        const now = ctx.now.toISOString();
        const messages: IPersonalMessage[] = events(ctx)
            .filter((e) => e.at <= now)
            .flatMap((e) =>
                ctx.participants
                    .filter((p) => p.userId && p.id !== e.hero.id && p.joinedAt <= e.at)
                    .map((p) => ({
                        to: p.id,
                        key: `birthday:${e.date}:${e.days}:${e.hero.id}:${p.id}`,
                        text: reminderText(ctx.room.title, e),
                    })),
            );
        return { room: { settings: { birthdayCursor: now } }, messages };
    },
};
