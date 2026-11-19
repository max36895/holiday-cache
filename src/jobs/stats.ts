import { Store } from '../core/Store';
import { platformLabel } from '../texts';
import { runJob } from './run';

/** Цифры сезона для статьи: комнаты, участники, мессенджеры, жеребьёвки. */
export interface ISeasonStats {
    rooms: number;
    /** Идут прямо сейчас: набор или игра */
    activeRooms: number;
    /** Люди, а не стёртые записи: после «удалить мои данные» участник не считается */
    participants: number;
    /** Сколько участников в каком мессенджере */
    platforms: Record<string, number>;
    /** Комнаты, дошедшие до фиксации состава (жеребьёвка, выбор даты) */
    roomsDrawn: number;
    roomsFinished: number;
}

/**
 * Считает итоги сезона по таблицам бота. Вызывается из задачи cron — числа
 * накапливаются с первого дня, к статье ничего не придётся собирать руками.
 *
 * @param store Хранилище бота
 * @returns Цифры сезона
 */
export async function collectStats(store: Store): Promise<ISeasonStats> {
    const rooms = [
        ...(await store.roomsByStatus('open')),
        ...(await store.roomsByStatus('closed')),
        ...(await store.roomsByStatus('finished')),
    ];
    const platforms: Record<string, number> = {};
    let participants = 0;
    for (const room of rooms) {
        for (const participant of await store.participantsOf(room.id)) {
            if (!participant.userId) {
                continue;
            }
            participants++;
            platforms[participant.platform] = (platforms[participant.platform] ?? 0) + 1;
        }
    }
    return {
        rooms: rooms.length,
        activeRooms: rooms.filter((room) => room.status !== 'finished').length,
        participants,
        platforms,
        roomsDrawn: rooms.filter((room) => room.closedAt).length,
        roomsFinished: rooms.filter((room) => room.status === 'finished').length,
    };
}

/**
 * Итоги сезона: cron раз в сутки или по запросу. Строка в лог — её и копируем в статью.
 */
if (require.main === module) {
    runJob('stats', async ({ service }) => {
        const stats = await collectStats(service.store);
        const platforms = Object.entries(stats.platforms)
            .sort((a, b) => b[1] - a[1])
            .map(([platform, count]) => `${platformLabel(platform)} — ${count}`)
            .join(', ');
        return [
            `комнат: ${stats.rooms} (активных ${stats.activeRooms})`,
            `участников: ${stats.participants}`,
            `мессенджеры: ${platforms || 'нет'}`,
            `дошло до жеребьёвки: ${stats.roomsDrawn}, завершено: ${stats.roomsFinished}`,
        ].join('; ');
    });
}
