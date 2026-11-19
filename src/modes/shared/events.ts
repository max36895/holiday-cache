import { formatDateTime, zonedTime } from '../../core/time';
import { IRoom } from '../../core/types';
import { IQuestion } from '../../core/Wizard';
import { IModeAction, IModeContext, IModeResult } from '../IMode';

export const TIMEZONE: IQuestion = {
    key: 'timezone',
    type: 'timezone',
    prompt: 'Часовой пояс IANA, например Europe/Moscow или Asia/Novosibirsk?',
    options: [
        { title: 'Москва', value: 'Europe/Moscow' },
        { title: 'Новосибирск', value: 'Asia/Novosibirsk' },
        { title: 'UTC', value: 'UTC' },
    ],
};

export const FINISH: IModeAction = { id: 'finish', title: 'Завершить игру' };
export function finished(ctx: IModeContext): IModeResult {
    return {
        reply: 'Игра завершена.',
        showRoom: true,
        room: { status: 'finished', settings: { finishedAt: ctx.now.toISOString() } },
    };
}

export function eventAt(room: IRoom): string {
    const at = room.settings.eventAt as string;
    return zonedTime(at.slice(0, 10), at.slice(11, 16), room.timezone);
}

export function eventDescription(room: IRoom, title: string): string {
    const at = room.settings.eventAt as string;
    // Дата без года означает ближайшую будущую: если она уехала на другой год — показываем год
    const year = at.slice(0, 4);
    const createdYear = room.createdAt.slice(0, 4);
    const when = `${formatDateTime(at)} (${room.timezone}${year !== createdYear ? `, ${year}` : ''})`;
    return `${title} «${room.title}»\n${when}`;
}

/** Разовые комнаты храним 30 дней после события или завершения, что позже. */
export function eventExpiresAt(room: IRoom): string {
    return new Date(
        Math.max(
            Date.parse(eventAt(room)),
            Date.parse(room.settings.finishedAt || room.closedAt || room.createdAt),
        ) +
            30 * 86400000,
    ).toISOString();
}
