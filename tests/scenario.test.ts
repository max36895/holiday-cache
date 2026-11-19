import { A } from '../src/ui';
import { codeOf, roomIdOf, TestBot } from './helpers';

describe('Тайный Санта через Алису', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('первое сообщение — меню, неизвестный текст — подсказка', async () => {
        const menu = await t.alisa('u1', '');
        expect(menu.text).toContain('Тайный Санта');
        expect(menu.buttons.map((b) => b.title)).toEqual([
            'Создать игру',
            'Войти по коду',
            'Мои игры',
            'Помощь',
        ]);
        const unknown = await t.alisa('u1', 'как дела');
        expect(unknown.text).toContain('Не понял');
    });

    it('организатор создаёт игру, участники входят по коду, жеребьёвка — цепочка без подарков себе', async () => {
        const created = await t.createGame('owner', true);
        expect(created.text).toContain('Игра создана');
        expect(created.text).toContain('Бюджет: до 1500 ₽');
        expect(created.text).toContain('Обмен: 27 декабря');
        const code = codeOf(created);
        expect(created.text).toContain(`https://t.me/rooms_test_bot?start=${code}`);

        const preview = await t.alisa('anya', code.toLowerCase());
        expect(preview.text).toContain('Тайный Санта «Офис 2026»');
        expect(preview.buttons.map((b) => b.title)).toEqual(['Участвую', 'Отмена']);

        const joined = await t.join('anya', code, 'книгу');
        expect(joined.text).toContain('Вы в игре, ждём жеребьёвку');
        expect(joined.text).toContain('Пожелание: книгу');
        await t.join('petya', code);
        await t.join('olya', code);

        const menu = await t.alisa('owner', 'меню');
        const card = await t.alisaClick('owner', menu, 'Текущая игра');
        expect(card.text).toContain('В игре 4 участника');
        const confirm = await t.alisaClick('owner', card, 'Провести жеребьёвку');
        expect(confirm.text).toContain('состав не изменить');
        const drawn = await t.alisaClick('owner', confirm, 'Да, провести');
        expect(drawn.text).toContain('Жеребьёвка проведена');
        await t.app.notifier.whenIdle();

        const roomId = roomIdOf(drawn);
        const gives = new Map<string, string>();
        for (const user of ['owner', 'anya', 'petya', 'olya']) {
            const r = await t.act(user, roomId, 'whom');
            const name = /Тайный Санта\. Ваш подопечный: (\S+)\./.exec(r.text)?.[1];
            expect(name).toBeDefined();
            expect(name).not.toBe(user);
            gives.set(user, name as string);
        }
        expect(new Set(gives.values()).size).toBe(4);
        // «Кому я дарю?» работает и текстом (голосом): название кнопки действия режима
        const anyaGiver = [...gives].find(([, to]) => to === 'Anya')?.[0] as string;
        await t.alisaPress(anyaGiver, { action: A.room, r: roomId });
        const forAnya = await t.alisa(anyaGiver, 'кому я дарю');
        expect(forAnya.text).toContain('Пожелание: книгу');
    });

    it('права и статус проверяются на сервере, а не скрытием кнопок', async () => {
        const created = await t.createGame('owner', false);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);

        const draw = await t.act('anya', roomId, 'draw', undefined, true);
        expect(draw.text).toContain('только организатор');
        for (const action of [A.members, A.eraseOk, A.invite]) {
            const r = await t.alisaPress('anya', { action, r: roomId });
            expect(r.text).toContain('только организатор');
        }
        for (const action of ['finish', 'retry', 'nope']) {
            const r = await t.act('anya', roomId, action);
            expect(r.text).toContain('недоступно');
        }
        const stranger = await t.alisaPress('stranger', { action: A.room, r: roomId });
        expect(stranger.text).toContain('Вы не участвуете');

        const tooFew = await t.act('owner', roomId, 'draw', undefined, true);
        expect(tooFew.text).toContain('не меньше 3 участников');

        await t.join('olya', code);
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        const before = await t.act('anya', roomId, 'whom');
        const again = await t.act('owner', roomId, 'draw', undefined, true);
        expect(again.text).toContain('недоступно');
        const after = await t.act('anya', roomId, 'whom');
        expect(after.text).toBe(before.text);

        const late = await t.alisa('late', code);
        // В превью причина названа один раз, внятно
        expect(late.text).toContain('Войти в эту игру нельзя');
        expect(late.text).toContain('Жеребьёвка уже проведена');
        const leave = await t.alisaPress('anya', { action: A.leave, r: roomId });
        expect(leave.text).toContain('Жеребьёвка уже проведена');
        // Пожелание менять можно и после жеребёвки (Санта получит обновление)
        await t.act('anya', roomId, 'wish');
        const changed = await t.alisa('anya', 'термос');
        expect(changed.text).toContain('Пожелание сохранено');
    });

    it('два одновременных запроса жеребьёвки не пересчитывают пары', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        const owner = { platform: 'alisa', userId: 'owner' };
        const [first, second] = await Promise.all([
            t.app.service.runAction(owner, roomId, 'draw', {}),
            t.app.service.runAction(owner, roomId, 'draw', {}).catch((e: Error) => e),
        ]);
        expect(first.outgoing).toHaveLength(3);
        expect(second).toBeInstanceOf(Error);
    });

    it('проверяет ответы мастера', async () => {
        await t.alisa('owner', 'создать');
        const long = await t.alisa('owner', 'x'.repeat(61));
        expect(long.text).toContain('Слишком длинно: не больше 60 символов');
        await t.alisa('owner', 'Офис');
        await t.alisa('owner', 'пропустить');
        const badDate = await t.alisa('owner', 'после праздников');
        expect(badDate.text).toContain('Не понял дату');

        const code = codeOf(await t.createGame('owner2', false));
        const preview = await t.alisa('anya', code);
        await t.alisaClick('anya', preview, 'Участвую');
        const badName = await t.alisa('anya', 'А'.repeat(41));
        expect(badName.text).toContain('Слишком длинно: не больше 40 символов');
        await t.alisa('anya', 'Аня');
        const badWish = await t.alisa('anya', 'п'.repeat(301));
        expect(badWish.text).toContain('не больше 300 символов');
        const joined = await t.alisa('anya', 'книгу');
        expect(joined.text).toContain('Вы в игре');
    });

    it('пожелание меняется до жеребьёвки через вопрос действия', async () => {
        const created = await t.createGame('owner', false);
        const roomId = roomIdOf(created);
        await t.join('anya', codeOf(created), 'книгу');
        const ask = await t.act('anya', roomId, 'wish');
        expect(ask.text).toContain('Напишите пожелание');
        const saved = await t.alisa('anya', 'шарф');
        expect(saved.text).toContain('Пожелание сохранено');
        expect(saved.text).toContain('Пожелание: шарф');
    });

    it('кнопка «Отмена» и слово «меню» прерывают мастер', async () => {
        const ask = await t.alisa('owner', 'создать');
        const cancelled = await t.alisaClick('owner', ask, 'Отмена');
        expect(cancelled.buttons.map((b) => b.title)).toContain('Создать игру');
        await t.alisa('owner', 'создать');
        const menu = await t.alisa('owner', 'меню');
        expect(menu.text).toContain('Тайный Санта');
        const after = await t.alisa('owner', 'Офис');
        expect(after.text).toContain('Не понял');
    });

    it('подбор кодов ограничен: после 10 неверных кодов — блокировка на час; верный код работает', async () => {
        const code = codeOf(await t.createGame('owner', false));
        for (const last of '23456789AB') {
            const r = await t.alisa('hacker', `AAAAA${last}`);
            expect(r.text).toContain('не найдена');
        }
        // Одиннадцатая неверная попытка — бан; верный код бан не закрывает:
        // нашедший код не виноват, а подбор ограничен именно неверными попытками
        const blocked = await t.alisa('hacker', 'KKKKKK');
        expect(blocked.text).toContain('Слишком много неверных кодов');
        const valid = await t.alisa('hacker', code);
        expect(valid.text).toContain('Участвуете?');
    });

    it('организатор исключает участника, участник выходит сам', async () => {
        const created = await t.createGame('owner', false);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        const list = await t.alisaPress('owner', { action: A.members, r: roomId });
        expect(list.text).toContain('1. Anya (Алиса)');
        const kicked = await t.alisaClick('owner', list, 'Исключить: Anya');
        expect(kicked.text).toContain('Anya (Алиса) больше не участвует');
        expect(kicked.text).not.toContain('1. Anya');
        // Выход требует подтверждения: стираются имя и ответы
        const confirm = await t.alisaPress('petya', { action: A.leave, r: roomId });
        expect(confirm.text).toContain('Точно выйти из игры');
        const left = await t.alisaPress('petya', { action: A.leaveOk, r: roomId });
        expect(left.text).toContain('Вы вышли из игры');
        const empty = await t.alisaPress('owner', { action: A.members, r: roomId });
        expect(empty.text).toContain('Пока никого');
    });

    it('«Мои игры» показывает игры организатора и участника; удаление игры стирает участников', async () => {
        const code = codeOf(await t.createGame('owner', false, 'Семья'));
        await t.join('anya', code);
        const mine = await t.alisa('anya', 'мои игры');
        expect(mine.buttons.map((b) => b.title)).toContain('Семья · набор');
        const ownerList = await t.alisa('owner', 'мои игры');
        expect(ownerList.buttons.map((b) => b.title)).toContain('Семья · набор · организатор');
        const card = await t.alisaClick('owner', ownerList, 'Семья');
        const confirm = await t.alisaClick('owner', card, 'Удалить игру');
        const deleted = await t.alisaClick('owner', confirm, 'Да, удалить');
        expect(deleted.text).toContain('Игра «Семья» удалена');
        const after = await t.alisa('anya', 'мои игры');
        expect(after.text).toContain('пока нет игр');
        expect(await t.app.service.findByCode(code)).toBeNull();
    });

    it('не больше 10 незавершённых игр у организатора', async () => {
        for (let i = 0; i < 10; i++) {
            await t.createGame('owner', false, `Игра ${i}`);
        }
        const r = await t.alisa('owner', 'создать');
        expect(r.text).toContain('уже 10 незавершённых игр');
    });

    it('«удалить мои данные»: после жеребьёвки стираются имя, id и профиль; игры организатора удаляются', async () => {
        const created = await t.createGame('owner', false);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code, 'книгу');
        await t.join('petya', code);
        await t.join('olya', code);
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();

        const ask = await t.alisa('anya', 'удалить мои данные');
        const done = await t.alisaClick('anya', ask, 'Да, удалить всё');
        expect(done.text).toContain('покинуто игр: 1');
        const participants = await t.app.service.store.participantsOf(roomId);
        const erased = participants.find((p) => !p.userId);
        expect(erased).toMatchObject({ name: '', profile: {}, userId: '' });
        const giver = participants.find((p) => p.recipientId === erased?.id);
        const forGiver = await t.act(giver?.userId as string, roomId, 'whom');
        expect(forGiver.text).toContain('подопечный');

        const ownerAsk = await t.alisa('owner', 'удалить мои данные');
        const ownerDone = await t.alisaClick('owner', ownerAsk, 'Да, удалить всё');
        expect(ownerDone.text).toContain('Удалено игр: 1');
        expect(await t.app.service.store.findRoom(roomId)).toBeNull();
    });

    it('до жеребьёвки «удалить мои данные» выводит из игры', async () => {
        const code = codeOf(await t.createGame('owner', false));
        await t.join('anya', code);
        const ask = await t.alisa('anya', 'удалить мои данные');
        await t.alisaClick('anya', ask, 'Да, удалить всё');
        const room = await t.app.service.findByCode(code);
        expect(await t.app.service.store.participantsOf(room?.id as string)).toEqual([]);
    });

    it('cleanup удаляет комнаты с истёкшим сроком хранения', async () => {
        const created = await t.createGame('owner', false);
        const roomId = roomIdOf(created);
        await t.join('anya', codeOf(created));
        const room = await t.app.service.store.findRoom(roomId);
        if (!room) {
            throw new Error('Комната не создана');
        }
        // 30 дней после даты обмена
        const eventEnd = Date.parse(`${room.settings.eventDate}T23:59:59Z`);
        expect(Date.parse(room.expiresAt as string) - eventEnd).toBe(30 * 24 * 60 * 60 * 1000);
        expect(await t.app.service.cleanupExpired()).toBe(0);
        t.now = new Date(eventEnd + 31 * 24 * 60 * 60 * 1000);
        expect(await t.app.service.cleanupExpired()).toBe(1);
        expect(await t.app.service.store.participantsOf(roomId)).toEqual([]);
    });

    it('«Сыграть ещё раз» создаёт новую игру с теми же правилами; дату можно перенести', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        await t.act('owner', roomId, 'draw', undefined, true);
        const card = await t.act('owner', roomId, 'finish');
        expect(card.text).toContain('завершена');
        expect(card.buttons.map((b) => b.title)).toContain('Сыграть ещё раз');

        const again = await t.alisaClick('owner', card, 'Сыграть ещё раз');
        expect(again.text).toContain('Игра создана');
        const newCode = codeOf(again);
        expect(newCode).not.toBe(code);
        const fresh = await t.app.service.store.findRoom(roomIdOf(again));
        expect(fresh?.status).toBe('open');
        expect(fresh?.settings.budget).toBe('до 1500 ₽');
        // Регрессия: старая дата обмена не переезжает в новую игру —
        // организатор задаёт новую сам
        expect(fresh?.settings.eventDate).toBeUndefined();
        // Фазовые флаги старой игры не переносятся: напоминания сработают заново
        expect(fresh?.settings.reminded).toBeUndefined();
        // Старая игра не тронута
        expect((await t.app.service.store.findRoom(roomId))?.status).toBe('finished');

        // Дату обмена можно перенести, пока идёт набор
        await t.act('owner', roomIdOf(again), 'date');
        const moved = await t.alisa('owner', '30 декабря');
        expect(moved.text).toContain('Обмен перенесён: 30 декабря');
        expect((await t.app.service.store.findRoom(roomIdOf(again)))?.settings.eventDate).toBe(
            '2026-12-30',
        );
    });

    it('вручение подарков: участники отмечаются, организатор видит, что дошло до всех', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        await t.act('owner', roomId, 'draw', undefined, true);

        const participants = await t.app.service.store.participantsOf(roomId);
        const ownerP = participants.find((p) => p.userId === 'owner');
        const recipientP = participants.find((p) => p.id === ownerP?.recipientId);

        // Даритель отмечает вручение, получатель — получение; ответ уже карточка комнаты
        const given = await t.act('owner', roomId, 'given');
        expect(given.text).toContain('вы подарили подарок');
        expect(given.buttons.map((b) => b.title)).toContain('Отменить: я подарил');
        const got = await t.act(recipientP?.userId as string, roomId, 'received');
        expect(got.text).toContain('подарок получен');

        // Сводка организатора: у пары владельца обе отметки, у остальных — нет
        const summary = await t.act('owner', roomId, 'handover');
        const ownerLine = summary.text
            .split('\n')
            .find((line) => line.includes('подарок ✓')) as string;
        expect(ownerLine).toContain('получено ✓');
        expect(summary.text.match(/подарок —/g)?.length).toBe(2);
    });
});
