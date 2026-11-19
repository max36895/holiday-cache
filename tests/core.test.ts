import { SantaMode } from '../src/modes/santa/SantaMode';
import { A, IPayload } from '../src/ui';
import { PartyMode, SummerMode } from './fixtures/partyMode';
import { codeOf, IReply, ISentMessage, roomIdOf, TestBot } from './helpers';

const OWNER = 2000;

function press(message: ISentMessage | IReply, title: string): IPayload {
    const payload = message.buttons.find((b) => b.title.startsWith(title))?.payload;
    if (!payload) {
        throw new Error(`Нет кнопки «${title}»: ${message.buttons.map((b) => b.title).join(', ')}`);
    }
    return payload;
}

describe('ядро на тестовом режиме: все возможности для следующих режимов', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot({}, [PartyMode, SummerMode, SantaMode]);
        t.now = new Date('2027-03-12T08:00:00Z');
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    /** Организатор в Telegram создаёт вечеринку; deliverAt — когда доставлять записки. */
    async function createParty(deliverAt?: string): Promise<{ code: string; roomId: string }> {
        await t.telegram(OWNER, 'создать', 'Орг');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Тестовая вечеринка'));
        await t.telegram(OWNER, 'Пятница', 'Орг');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Москва'));
        if (deliverAt) {
            await t.telegram(OWNER, deliverAt, 'Орг');
        } else {
            await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Пропустить'));
        }
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Только организую'));
        const card = t.sent[t.sent.length - 2] as ISentMessage;
        return {
            code: /Код: (\w{6})/.exec(card.text)?.[1] as string,
            roomId: press(card, 'Участники').r as string,
        };
    }

    /** Участник в Telegram входит: имя из профиля, день рождения, команда. */
    async function join(
        id: number,
        code: string,
        name: string,
        bday: string,
        team: 'А' | 'Б',
    ): Promise<void> {
        await t.telegram(id, code, name);
        await t.telegramPress(id, press(t.lastTo(id), 'Участвую'));
        await t.telegramPress(id, press(t.lastTo(id), 'Да, так'));
        await t.telegram(id, bday, name);
        await t.telegramPress(id, press(t.lastTo(id), `Команда ${team}`));
    }

    it('меню режимов: режим в свой сезон идёт первым', async () => {
        t.now = new Date('2027-06-10T08:00:00Z');
        const june = await t.alisa('u', 'создать');
        expect(june.text).toContain('Во что играем?');
        expect(june.buttons.map((b) => b.title)).toEqual([
            'Тестовая вечеринка',
            'Летник',
            'Тайный Санта',
            'Меню',
        ]);
        t.now = new Date('2027-07-10T08:00:00Z');
        const july = await t.alisa('u', 'создать');
        expect(july.buttons[0]?.title).toBe('Летник');
        t.now = new Date('2026-12-10T08:00:00Z');
        const december = await t.alisa('u', 'создать');
        expect(december.buttons[0]?.title).toBe('Тайный Санта');
    });

    it('бессрочная комната, вопросы при входе, несколько действий, отметки, жеребьёвка по группам', async () => {
        const { code, roomId } = await createParty();
        expect((await t.app.service.store.findRoom(roomId))?.expiresAt).toBeNull();
        await join(1, code, 'Аня', '14.03', 'А');
        await join(2, code, 'Вера', '1 июня', 'А');
        for (const [id, name] of [
            [3, 'Борис'],
            [4, 'Гоша'],
            [5, 'Дима'],
        ] as const) {
            await join(id, code, name, '01.09', 'Б');
        }
        expect(t.lastTo(5).text).toContain('Добро пожаловать.');
        await t.telegramPress(1, { action: A.room, r: roomId });
        expect(t.lastTo(1).text).toContain('Вы: Аня. День рождения: 14 марта. Команда: Команда А');

        await t.telegramPress(1, press(t.lastTo(1), 'Голосовать'));
        await t.telegramPress(1, press(t.lastTo(1), 'За'));
        await t.telegramPress(3, { action: A.act, r: roomId, m: 'vote', x: 'no' });
        await t.telegramPress(1, { action: A.act, r: roomId, m: 'paid' });
        await t.telegramPress(1, { action: A.act, r: roomId, m: 'paid' });
        expect(t.lastTo(1).text).toBe('Отметка снята.');
        await t.telegramPress(2, { action: A.act, r: roomId, m: 'paid' });
        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'tally' });
        expect(t.lastTo(OWNER).text).toBe('За: 1, против: 1, скинулись: 1.');

        await t.telegramPress(1, { action: A.act, r: roomId, m: 'note' });
        expect(t.lastTo(1).text).toContain('Текст заметки?');
        await t.telegram(1, 'принесу торт', 'Аня');
        expect(t.lastTo(1).text).toBe('Заметка сохранена.');

        await t.telegramPress(3, { action: A.actOk, r: roomId, m: 'groups' });
        expect(t.lastTo(3).text).toContain('только организатор');
        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'groups' });
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Да'));
        await t.app.notifier.whenIdle();
        const marks = (await t.app.service.store.marksOf(roomId)).filter((m) =>
            m.key.startsWith('gift:'),
        );
        expect(marks).toHaveLength(3);
        expect(t.lastTo(1).text).toMatch(/^Вы дарите: (Борис|Гоша|Дима)/);
        expect(t.lastTo(OWNER).text).toContain('результаты отправлены 2 из 2');

        // Бессрочная комната не удаляется по сроку, а вход открыт, пока режим не закрыл состав
        t.now = new Date('2032-01-01T00:00:00Z');
        expect(await t.app.service.cleanupExpired()).toBe(0);
    });

    it('расписание: onSchedule в наступившее время, повторный запуск ничего не отправляет второй раз', async () => {
        const { code, roomId } = await createParty();
        await join(1, code, 'Аня', '14.03', 'А');
        await join(2, code, 'Вера', '01.06', 'А');
        await join(3, code, 'Борис', '01.06', 'Б');
        const room = await t.app.service.store.findRoom(roomId);
        // 14 марта 10:00 по Москве
        expect(room?.nextRunAt).toBe('2027-03-14T07:00:00.000Z');

        expect(await t.app.scheduler.tick()).toEqual({ rooms: 0, messages: 0 });
        t.now = new Date('2027-03-14T07:03:00Z');
        expect(await t.app.scheduler.tick()).toEqual({ rooms: 1, messages: 2 });
        expect(t.lastTo(2).text).toBe('Сегодня день рождения у Аня');
        expect(t.lastTo(1).text).not.toContain('Сегодня день рождения');
        expect(await t.app.scheduler.tick()).toEqual({ rooms: 0, messages: 0 });
        expect((await t.app.service.store.findRoom(roomId))?.nextRunAt).toBe(
            '2027-06-01T07:00:00.000Z',
        );

        // Запуск прервался после рассылки, но до записи нового nextRunAt: журнал не даст повторить
        const after = await t.app.service.store.findRoom(roomId);
        await t.app.service.store.saveRoom({
            ...(after as NonNullable<typeof after>),
            settings: {},
            nextRunAt: '2027-03-14T07:00:00.000Z',
        });
        const sent = t.sent.length;
        expect(await t.app.scheduler.tick()).toEqual({ rooms: 1, messages: 0 });
        expect(t.sent).toHaveLength(sent);
    });

    it('пересылка «любой → любой»: ответ, жалоба, исключение автора, блокировка, лимит', async () => {
        const { code, roomId } = await createParty();
        await join(1, code, 'Аня', '14.03', 'А');
        await join(2, code, 'Вера', '01.06', 'Б');
        await join(3, code, 'Борис', '01.06', 'Б');

        await t.telegramPress(1, { action: A.room, r: roomId });
        await t.telegramPress(1, press(t.lastTo(1), 'Написать анонимно'));
        expect(t.lastTo(1).buttons.map((b) => b.title)).toEqual(['Вера', 'Борис', 'К игре']);
        await t.telegramPress(1, press(t.lastTo(1), 'Вера'));
        await t.telegram(1, 'Ты лучшая', 'Аня');
        expect(t.lastTo(1).text).toBe('Сообщение отправлено.');
        await t.app.notifier.whenIdle();
        const received = t.lastTo(2);
        expect(received.text).toBe('Анонимное сообщение в «Пятница»:\n\nТы лучшая');
        expect(received.text).not.toContain('Аня');
        // Текст хранится после доставки: организатор увидит его в жалобе
        expect((await t.app.service.store.relaysOf(roomId))[0]?.text).toBe('Ты лучшая');

        await t.telegramPress(2, press(received, 'Ответить анонимно'));
        await t.telegram(2, 'Спасибо!', 'Вера');
        await t.app.notifier.whenIdle();
        expect(t.lastTo(1).text).toBe(
            'Анонимное сообщение в «Пятница»:\n\nСпасибо!\n\nВ ответ на ваше сообщение:\n«Ты лучшая»',
        );

        await t.telegramPress(2, press(received, 'Заблокировать'));
        const [, vera, boris] = await t.app.service.store.participantsOf(roomId);
        await t.telegramPress(1, { action: A.write, r: roomId, x: vera?.id as string });
        await t.telegram(1, 'Ещё раз привет', 'Аня');
        await t.app.notifier.whenIdle();
        // Автор не узнаёт о блокировке, а сообщение не доставляется и не хранится
        expect(t.lastTo(1).text).toBe('Сообщение отправлено.');
        expect(t.lastTo(2).text).not.toContain('Ещё раз привет');

        await t.telegramPress(1, { action: A.write, r: roomId, x: boris?.id as string });
        await t.telegram(1, 'второе', 'Аня');
        await t.telegramPress(1, { action: A.write, r: roomId, x: boris?.id as string });
        await t.telegram(1, 'третье', 'Аня');
        expect(t.lastTo(1).text).toContain('не больше 2 сообщений');

        await t.telegramPress(2, press(received, 'Пожаловаться'));
        await t.app.notifier.whenIdle();
        const complaint = t.lastTo(OWNER);
        expect(complaint.text).toContain('пожаловался на анонимное сообщение');
        expect(complaint.text).toContain('Текст сообщения:\nТы лучшая');
        expect(complaint.text).not.toContain('Аня');
        // Повторная жалоба на то же сообщение организатору не уходит
        await t.telegramPress(2, press(received, 'Пожаловаться'));
        expect(t.lastTo(2).text).toBe('Вы уже пожаловались на это сообщение.');
        await t.app.notifier.whenIdle();
        expect(t.lastTo(OWNER)).toBe(complaint);
        await t.telegramPress(OWNER, press(complaint, 'Исключить автора'));
        const confirm = t.lastTo(OWNER);
        expect(confirm.text).toContain('Исключить автора из игры');
        await t.telegramPress(OWNER, press(confirm, 'Да, исключить'));
        expect(t.lastTo(OWNER).text).toBe('Автор больше не участвует в игре.');
        const names = (await t.app.service.store.participantsOf(roomId)).map((p) => p.name);
        expect(names).toEqual(['Вера', 'Борис']);
        // Сообщения исключённого — написанные и полученные — удалены вместе с ним
        expect(await t.app.service.store.relaysOf(roomId)).toEqual([]);
    });

    it('отложенная доставка: сообщение ждёт времени из настроек, до доставки его можно отменить', async () => {
        const { code, roomId } = await createParty('14.03.2027 10:00');
        await join(1, code, 'Аня', '14.03', 'А');
        await join(2, code, 'Вера', '01.06', 'Б');
        const vera = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.name === 'Вера',
        );
        for (const text of ['первая записка', 'вторая записка']) {
            await t.telegramPress(1, { action: A.write, r: roomId, x: vera?.id as string });
            await t.telegram(1, text, 'Аня');
            expect(t.lastTo(1).text).toBe('Сообщение будет доставлено в назначенное время.');
        }
        await t.telegramPress(1, { action: A.outbox, r: roomId });
        const outbox = t.lastTo(1);
        expect(outbox.buttons.map((b) => b.title)).toEqual([
            'Отменить: первая записка',
            'Отменить: вторая записка',
            'К игре',
        ]);
        await t.telegramPress(1, press(outbox, 'Отменить: вторая'));
        expect(t.lastTo(1).text).toBe('Сообщение отменено.');

        expect((await t.app.scheduler.tick()).messages).toBe(0);
        t.now = new Date('2027-03-14T07:01:00Z');
        const { messages } = await t.app.scheduler.tick();
        // Записка и напоминание о дне рождения Ани для Веры
        expect(messages).toBe(2);
        const texts = t.sent.filter((m) => m.chatId === '2').map((m) => m.text);
        expect(texts).toContain('Анонимное сообщение в «Пятница»:\n\nпервая записка');
        expect(texts.some((text) => text.includes('вторая записка'))).toBe(false);
    });
});

describe('Тайный Санта: напоминание и анонимный вопрос', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
        t.now = new Date('2026-12-01T08:00:00Z');
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('за 2 дня до обмена дарители получают напоминание — один раз', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        // Обмен 27 декабря: напоминание 25 декабря в 10:00 по Москве
        expect((await t.app.service.store.findRoom(roomId))?.nextRunAt).toBe(
            '2026-12-25T07:00:00.000Z',
        );
        t.now = new Date('2026-12-25T07:01:00Z');
        // Участники в Алисе: сообщения готовятся, но Алиса не умеет писать первой
        expect((await t.app.scheduler.tick()).messages).toBe(3);
        expect((await t.app.scheduler.tick()).messages).toBe(0);
        expect((await t.app.service.store.findRoom(roomId))?.nextRunAt).toBeNull();
    });

    it('набор без даты обмена висит неделю — организатору приходит подгон, один раз', async () => {
        // Создаём без бюджета и даты обмена
        await t.alisa('owner', 'создать');
        await t.alisa('owner', 'Тишина');
        await t.alisa('owner', 'пропустить');
        const role = await t.alisa('owner', 'пропустить');
        const created = await t.alisaClick('owner', role, 'Только организую');
        const roomId = roomIdOf(created);
        // Подгон — через неделю после создания
        expect((await t.app.service.store.findRoom(roomId))?.nextRunAt).toBe(
            '2026-12-08T08:00:00.000Z',
        );
        t.now = new Date('2026-12-08T08:01:00Z');
        expect((await t.app.scheduler.tick()).messages).toBe(1);
        expect((await t.app.service.store.findRoom(roomId))?.settings.nudged).toBe('1');
        expect((await t.app.scheduler.tick()).messages).toBe(0);
    });

    it('даритель анонимно спрашивает подопечного, тот отвечает', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        for (const [id, name] of [
            [11, 'Аня'],
            [12, 'Петя'],
        ] as const) {
            await t.telegram(id, code, name);
            await t.telegramPress(id, press(t.lastTo(id), 'Участвую'));
            await t.telegramPress(id, press(t.lastTo(id), 'Да, так'));
            await t.telegram(id, 'пропустить', name);
        }
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        // В цепочке из трёх всегда есть даритель из Telegram с подопечным из Telegram
        const participants = await t.app.service.store.participantsOf(roomId);
        const telegram = participants.filter((p) => p.platform === 'telegram');
        const giver = telegram.find((p) => telegram.some((r) => r.id === p.recipientId));
        const recipient = telegram.find((p) => p.id === giver?.recipientId);
        const giverId = Number(giver?.userId);
        const recipientId = Number(recipient?.userId);

        await t.telegramPress(giverId, { action: A.room, r: roomId });
        await t.telegramPress(giverId, press(t.lastTo(giverId), 'Анонимный вопрос подопечному'));
        await t.telegram(giverId, 'Какой цвет любишь?', giver?.name);
        await t.app.notifier.whenIdle();
        const question = t.lastTo(recipientId);
        expect(question.text).toBe('Анонимное сообщение в «Офис 2026»:\n\nКакой цвет любишь?');
        await t.telegramPress(recipientId, press(question, 'Ответить анонимно'));
        await t.telegram(recipientId, 'Синий', recipient?.name);
        await t.app.notifier.whenIdle();
        expect(t.lastTo(giverId).text).toBe(
            'Анонимное сообщение в «Офис 2026»:\n\nСиний\n\nВ ответ на ваше сообщение:\n«Какой цвет любишь?»',
        );

        // После жеребьёвки запись участника остаётся, но «удалить мои данные» стирает его переписку
        await t.telegram(recipientId, 'удалить мои данные', recipient?.name);
        await t.telegramPress(recipientId, press(t.lastTo(recipientId), 'Да, удалить всё'));
        expect(await t.app.service.store.relaysOf(roomId)).toEqual([]);
    });

    it('правка пожелания, перенос даты и уход участника доходят до всех после жеребёвки', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        for (const [id, name] of [
            [11, 'Аня'],
            [12, 'Петя'],
        ] as const) {
            await t.telegram(id, code, name);
            await t.telegramPress(id, press(t.lastTo(id), 'Участвую'));
            await t.telegramPress(id, press(t.lastTo(id), 'Да, так'));
            await t.telegram(id, 'пропустить', name);
        }
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        const participants = await t.app.service.store.participantsOf(roomId);
        const telegramP = participants.filter((p) => p.platform === 'telegram');
        // В цепочке из трёх ровно одна пара «Telegram → Telegram»
        const giverP = telegramP.find((p) => telegramP.some((r) => r.id === p.recipientId));
        const recipientP = telegramP.find((p) => p.id === giverP?.recipientId);
        const giverId = Number(giverP?.userId);
        const recipientId = Number(recipientP?.userId);

        // Пожелание меняют после жеребёвки — Санта получает обновление
        await t.telegramPress(recipientId, { action: A.act, r: roomId, m: 'wish' });
        await t.telegram(recipientId, 'термос', 'Аня');
        await t.app.notifier.whenIdle();
        expect(t.lastTo(giverId).text).toContain('пожелание');
        expect(t.lastTo(giverId).text).toContain('термос');

        // Напоминание ушло, дату перенесли — дарителям сразу сообщают новую дату
        t.now = new Date('2026-12-25T07:01:00Z');
        await t.app.scheduler.tick();
        await t.act('owner', roomId, 'date');
        await t.act('owner', roomId, 'date', undefined, true);
        await t.alisa('owner', '30 декабря');
        await t.app.notifier.whenIdle();
        expect(t.lastTo(recipientId).text).toContain('перенесён на 30 декабря');
        expect((await t.app.service.store.findRoom(roomId))?.nextRunAt).toBe(
            '2026-12-28T07:00:00.000Z',
        );

        // Даритель удаляет данные: осиротевший участник и сводка узнают
        await t.telegram(giverId, 'удалить мои данные');
        await t.telegramPress(giverId, press(t.lastTo(giverId), 'Да, удалить всё'));
        await t.app.notifier.whenIdle();
        expect(t.lastTo(recipientId).text).toContain('ваш Тайный Санта больше не участвует');
        const summary = await t.act('owner', roomId, 'handover');
        expect(summary.text).toContain(`Остались без Санты: ${recipientP?.name}`);
    });
});
