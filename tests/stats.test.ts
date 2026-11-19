import { collectStats } from '../src/jobs/stats';
import { codeOf, roomIdOf, TestBot } from './helpers';

describe('статистика сезона', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
    });

    it('комнаты, участники, мессенджеры, жеребьёвки', async () => {
        // Первая игра дошла до жеребьёвки: организатор (Алиса) и двое в Алисе
        const first = await t.createGame('owner', true, 'Игра А');
        const roomId = roomIdOf(first);
        await t.join('anya', codeOf(first));
        await t.join('petya', codeOf(first));
        await t.act('owner', roomId, 'draw', undefined, true);

        // Вторая — в наборе
        const second = await t.createGame('owner', false, 'Игра Б');
        await t.join('vika', codeOf(second));

        const stats = await collectStats(t.app.service.store);
        expect(stats.rooms).toBe(2);
        expect(stats.activeRooms).toBe(2);
        // «удалить мои данные» стирает и человека: цифры считают живые записи
        expect(stats.participants).toBe(4);
        expect(stats.platforms).toEqual({ alisa: 4 });
        expect(stats.roomsDrawn).toBe(1);
        expect(stats.roomsFinished).toBe(0);
    });

    it('стёртые участники и завершённые игры не считаются людьми и активными', async () => {
        const created = await t.createGame('owner', true, 'Игра В');
        const roomId = roomIdOf(created);
        await t.join('anya', codeOf(created));
        await t.join('petya', codeOf(created));
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.act('owner', roomId, 'finish');

        const stats = await collectStats(t.app.service.store);
        expect(stats.rooms).toBe(1);
        expect(stats.activeRooms).toBe(0);
        expect(stats.roomsDrawn).toBe(1);
        expect(stats.roomsFinished).toBe(1);
    });
});
