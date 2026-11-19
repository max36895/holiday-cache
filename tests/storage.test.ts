import { Knex } from 'knex';
import { IKnexDbInfo } from 'umbot-knex-adapter';
import { TABLES } from '../src/core/db';
import { codeOf, roomIdOf, TestBot } from './helpers';

describe('SQLite через umbot-knex-adapter', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('таблицы бота создаются на первом запросе вместе со встроенными таблицами umbot', async () => {
        await t.alisa('owner', '');
        const db = (t.bot.getAppContext().database.databaseInfo as IKnexDbInfo).connection as Knex;
        for (const table of [...Object.keys(TABLES), 'UsersData']) {
            expect(await db.schema.hasTable(table)).toBe(true);
        }
        const indexes = (await db.raw("SELECT name FROM sqlite_master WHERE type = 'index'")) as {
            name: string;
        }[];
        expect(indexes.map((i) => i.name)).toEqual(
            expect.arrayContaining([
                'umbot_rooms_code',
                'umbot_rooms_nextRunAt',
                'umbot_marks_roomId_key',
            ]),
        );
    });

    it('полный цикл игры: создание, вход, жеребьёвка, «Кому я дарю?»', async () => {
        const created = await t.createGame('owner', false, 'Офис');
        const code = codeOf(created);
        for (const user of ['anya', 'petya', 'olya']) {
            const joined = await t.join(user, code, `пожелание ${user}`);
            expect(joined.text).toContain('Вы в игре');
        }
        const roomId = roomIdOf(created);
        const drawn = await t.act('owner', roomId, 'draw', undefined, true);
        expect(drawn.text).toContain('Жеребьёвка проведена');
        await t.app.notifier.whenIdle();
        const whom = await t.act('anya', roomId, 'whom');
        expect(whom.text).toMatch(
            /Тайный Санта\. Ваш подопечный: (Petya|Olya)\.\nПожелание: пожелание (petya|olya)/,
        );
        // userData живёт в таблице UsersData той же базы
        const menu = await t.alisa('anya', 'меню');
        expect(menu.buttons[0]?.title).toBe('Текущая игра: Офис');
    });

    it('блокировка комнаты в базе: занятая другим процессом комната ждёт освобождения', async () => {
        const created = await t.createGame('owner', false);
        const roomId = roomIdOf(created);
        await t.alisa('anya', codeOf(created));
        const db = (t.bot.getAppContext().database.databaseInfo as IKnexDbInfo).connection as Knex;
        // Аренда «другого процесса» на 300 мс
        await db('locks').insert({
            key: `room:${roomId}`,
            owner: 'other',
            expiresAt: new Date(Date.now() + 300).toISOString(),
        });
        const started = Date.now();
        await t.app.service
            .leave({ platform: 'alisa', userId: 'owner' }, roomId)
            .catch(() => undefined);
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        expect(await db('locks').count({ n: '*' })).toEqual([{ n: 0 }]);
    });
});

describe('файловая БД umbot (режим разработки)', () => {
    it('проходит тот же цикл игры', async () => {
        const t = new TestBot({ sqliteFile: undefined });
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        const roomId = roomIdOf(created);
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        const whom = await t.act('anya', roomId, 'whom');
        expect(whom.text).toMatch(/Тайный Санта\. Ваш подопечный: (Owner|Petya)\./);
        await t.close();
        expect(t.errors).toEqual([]);
    });
});
