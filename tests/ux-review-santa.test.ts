import { A, IPayload } from '../src/ui';
import { codeOf, ISentMessage, roomIdOf, TestBot } from './helpers';

/**
 * UX-обзор режима «Тайный Санта» глазами унылых/ленивых пользователей.
 * Всё в Telegram: тексты бота читаются из отправленных сообщений (t.sent).
 */

const OWNER = 3001;
const P: readonly number[] = [3002, 3003, 3004, 3005, 3006, 3007];

/** Общий бот: присваивается в beforeEach каждого describe. */
let t: TestBot;

function last(id: number): ISentMessage {
    return t.lastTo(id);
}

/** Последнее сообщение бота пользователю, содержащее подстроку. */
function sentTo(id: number, substr: string): ISentMessage {
    const found = [...t.sent]
        .reverse()
        .find((m) => m.chatId === String(id) && m.text.includes(substr));
    if (!found) {
        throw new Error(`В чат ${id} не отправлено сообщение с «${substr}»`);
    }
    return found;
}

/** Нажимает кнопку последнего ответа по началу подписи. */
async function click(id: number, title: string): Promise<void> {
    const message = last(id);
    const button = message.buttons.find((b) => b.title.startsWith(title));
    if (!button?.payload) {
        throw new Error(
            `Нет кнопки «${title}» в ответе: ${message.buttons.map((b) => b.title).join(', ')} — текст: ${message.text}`,
        );
    }
    await t.telegramPress(id, button.payload as IPayload);
}

describe('UX-обзор Тайного Санты (Telegram)', () => {
    beforeEach(() => {
        t = new TestBot();
        // Фиксированное «сегодня»: разбор дат («30.12») детерминирован
        t.now = new Date('2026-11-07T12:00:00Z');
    });

    afterEach(async () => {
        await t.close();
        // Сценарий D легитимно пишет в лог отказ Telegram (403) для заблокированного чата
        expect(t.errors.filter((e) => !e.includes('TelegramRequest'))).toEqual([]);
    });

    interface ICreateOptions {
        title?: string;
        /** null — нажать кнопку пропуска */
        budget?: string | null;
        date?: string | null;
        play?: boolean;
    }

    /** Организатор создаёт игру в Telegram, отвечая на вопросы как живой человек. */
    async function createGame(
        opts: ICreateOptions = {},
    ): Promise<{ code: string; roomId: string }> {
        const { title = 'Усталый офис', budget = 'до 1500 ₽', date = '30.12', play = true } = opts;
        await t.telegram(OWNER, 'создать', 'Оля');
        await t.telegram(OWNER, title, 'Оля');
        if (budget === null) {
            await click(OWNER, 'Без бюджета');
        } else {
            await t.telegram(OWNER, budget, 'Оля');
        }
        if (date === null) {
            await click(OWNER, 'Без даты');
        } else {
            await t.telegram(OWNER, date, 'Оля');
        }
        await click(OWNER, play ? 'Я участвую' : 'Только организую');
        if (play) {
            await click(OWNER, 'Да, так'); // имя из профиля
            await click(OWNER, 'Без пожелания');
        }
        const card = sentTo(OWNER, 'Игра создана');
        return { code: codeOf(card), roomId: roomIdOf(card) };
    }

    /** Участник входит по коду; wish null — кнопка «Без пожелания». */
    async function join(
        id: number,
        code: string,
        name: string,
        wish: string | null,
    ): Promise<void> {
        await t.telegram(id, code, name);
        await click(id, 'Участвую');
        await click(id, 'Да, так');
        if (wish === null) {
            await click(id, 'Без пожелания');
        } else {
            await t.telegram(id, wish, name);
        }
    }

    /** Организатор проводит жеребьёвку и дожидается рассылки. */
    async function draw(roomId: string): Promise<void> {
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Провести жеребьёвку');
        await click(OWNER, 'Да, провести');
        await t.app.notifier.whenIdle();
    }

    it('A: усталый офис на 6 человек — мастер, жеребьёвка, что видит каждый', async () => {
        await t.telegram(OWNER, 'создать', 'Оля');
        expect(last(OWNER).text).toContain('Как назовём игру');
        await t.telegram(OWNER, 'Усталый офис', 'Оля');
        // Живой человек пишет бюджет текстом, как в задании
        await t.telegram(OWNER, '1000 руб', 'Оля');
        expect(last(OWNER).text).toContain('Когда обмен');
        await t.telegram(OWNER, '30.12', 'Оля');
        await click(OWNER, 'Я участвую');
        await click(OWNER, 'Да, так');
        await click(OWNER, 'Без пожелания');

        const card = sentTo(OWNER, 'Игра создана');
        expect(card.text).toContain('Бюджет: 1000 руб');
        expect(card.text).toContain('Обмен: 30 декабря');
        const { code, roomId } = { code: codeOf(card), roomId: roomIdOf(card) };

        await join(P[0], code, 'Аня', 'книга-детектив');
        await join(P[1], code, 'Борис', 'пропустить'); // «пропустить» словом
        await join(P[2], code, 'Вера', 'без понятия');
        await join(P[3], code, 'Гоша', null); // кнопка «Без пожелания»
        await join(P[4], code, 'Дима', 'что-нибудь вкусное');
        expect(last(P[4]).text).toContain('Вы в игре, ждём жеребьёвку');

        await draw(roomId);
        // Каждый видит результат с кнопками
        for (const id of [OWNER, ...P.slice(0, 5)]) {
            const result = sentTo(id, 'вы — Тайный Санта. Ваш подопечный:');
            expect(result.buttons.map((b) => b.title)).toEqual([
                'Кому я дарю?',
                'Анонимный вопрос подопечному',
            ]);
        }
        const report = last(OWNER);
        expect(report.text).toContain('результаты отправлены 6 из 6');

        // Кому я дарю — у каждого читаемо
        const participants = await t.app.service.store.participantsOf(roomId);
        for (const [recipientName, wishExpect] of [
            ['Борис', 'Пожелание: не указано'],
            ['Вера', 'Пожелание: без понятия'],
        ] as const) {
            const recipient = participants.find((p) => p.name === recipientName);
            const giver = participants.find((p) => p.recipientId === recipient?.id);
            await t.telegramPress(Number(giver?.userId), {
                action: A.act,
                r: roomId,
                m: 'whom',
            });
            expect(last(Number(giver?.userId)).text).toContain(`Ваш подопечный: ${recipientName}.`);
            expect(last(Number(giver?.userId)).text).toContain(wishExpect);
        }
    });

    it('A2: бюджет «тысяча» мастер тоже принимает как есть', async () => {
        const { code } = await createGame({ title: 'Тысяча', budget: 'тысяча' });
        expect(code).toHaveLength(6);
        expect(sentTo(OWNER, 'Игра создана').text).toContain('Бюджет: тысяча');
    });

    it('B: опоздавший после жеребьёвки и в завершённой игре', async () => {
        const { code, roomId } = await createGame({ title: 'Опоздавшие' });
        await join(P[0], code, 'Аня', null);
        await join(P[1], code, 'Борис', null);
        await draw(roomId);

        // Опоздавший шлёт код
        await t.telegram(P[4], code, 'Опоздун');
        const preview = last(P[4]);
        // В превью причина названа один раз, внятно
        expect(preview.text).toContain('Войти в эту игру нельзя');
        expect(preview.text).toContain('Жеребьёвка уже проведена');
        expect(preview.buttons.map((b) => b.title)).toEqual(['Меню']);

        // Игра завершена — тот же код: бот честно говорит, что игра завершена
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Завершить игру');
        await t.telegram(P[5], code, 'Шестой');
        expect(last(P[5]).text).toBe(
            'Игра «Опоздавшие» уже завершена — войти в неё по коду нельзя.',
        );
    });

    it('C: передумал после жеребьёвки — кнопки выхода нет и подсказки нет', async () => {
        const { code, roomId } = await createGame({ title: 'Передумали' });
        await join(P[0], code, 'Аня', null);
        await join(P[1], code, 'Борис', null);
        await draw(roomId);

        // Участник ищет выход в карточке
        await t.telegramPress(P[0], { action: A.room, r: roomId });
        const card = last(P[0]);
        expect(card.buttons.map((b) => b.title)).not.toContain('Выйти из игры');

        // Жмёт «Выйти» из ещё висящего старого сообщения
        await t.telegramPress(P[0], { action: A.leave, r: roomId });
        expect(last(P[0]).text).toContain('Жеребьёвка уже проведена — состав игры не изменить.');
        expect(last(P[0]).text).not.toContain('удалить мои данные');

        // Организатор тоже не может исключить
        await t.telegramPress(OWNER, { action: A.members, r: roomId });
        expect(last(OWNER).buttons.filter((b) => b.title.startsWith('Исключить'))).toEqual([]);
    });

    it('D: бот заблокирован — отчёт и «Повторить отправку» в карточке', async () => {
        const { code, roomId } = await createGame({ title: 'Заблокировали' });
        await join(P[0], code, 'Аня', null);
        await join(P[1], code, 'Борис', null);
        t.blocked.add(String(P[1]));
        await draw(roomId);

        const report = last(OWNER);
        expect(report.text).toContain('результаты отправлены 2 из 3');
        expect(report.text).toContain('Не доставлено: Борис (Telegram).');
        expect(report.text).toContain(
            'Попросите их написать боту, затем нажмите «Повторить отправку».',
        );

        await click(OWNER, 'К игре');
        const card = last(OWNER);
        expect(card.buttons.map((b) => b.title)).toContain('Повторить отправку');

        t.blocked.delete(String(P[1]));
        await click(OWNER, 'Повторить отправку');
        await t.app.notifier.whenIdle();
        expect(last(P[1]).text).toMatch(/вы — Тайный Санта\. Ваш подопечный: /);
    });

    it('E: перенос даты после жеребёвки — дарители узнают сразу, напоминание пересчитывается', async () => {
        const { code, roomId } = await createGame({ title: 'Перенос', date: '30.12' });
        await join(P[0], code, 'Аня', null);
        await join(P[1], code, 'Борис', null);
        await draw(roomId);
        // В сообщении о жеребьёвке дата есть
        expect(sentTo(P[0], 'Тайный Санта. Ваш подопечный:').text).toContain('Обмен: 30 декабря');

        const before = t.sent.length;
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Изменить дату обмена');
        await t.telegram(OWNER, '5 января', 'Оля');
        expect(last(OWNER).text).toContain('Обмен перенесён: 5 января');
        await t.app.notifier.whenIdle();
        // Перенос после жеребёвки — дарители узнают о новой дате сразу
        const notifiedFirst = t.sent
            .slice(before)
            .filter((m) => m.text.includes('обмен подарками перенесён на 5 января'));
        expect(notifiedFirst.map((m) => m.chatId).sort()).toEqual([
            String(OWNER),
            String(P[0]),
            String(P[1]),
        ]);
        // Напоминание пересчиталось на новую дату
        expect((await t.app.service.store.findRoom(roomId))?.nextRunAt).toBe(
            '2027-01-03T07:00:00.000Z',
        );

        // Напоминание по новой дате приходит всем дарителям
        t.now = new Date('2027-01-03T07:01:00Z');
        expect((await t.app.scheduler.tick()).messages).toBe(3);
        expect(sentTo(P[0], 'обмен подарками 5 января').text).toMatch(/Вы дарите: /);
        expect((await t.app.scheduler.tick()).messages).toBe(0);

        // Перенос после напоминания — уведомление каждому
        const before2 = t.sent.length;
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Изменить дату обмена');
        await t.telegram(OWNER, '9 января', 'Оля');
        await t.app.notifier.whenIdle();
        const notified = t.sent
            .slice(before2)
            .filter((m) => m.text.includes('обмен подарками перенесён на 9 января'));
        expect(notified.map((m) => m.chatId).sort()).toEqual([
            String(OWNER),
            String(P[0]),
            String(P[1]),
        ]);
    });

    it('F: напоминание за 2 дня — дарителям, организатору-не-участнику его нет', async () => {
        const { code, roomId } = await createGame({
            title: 'Напоминание',
            play: false,
        });
        await join(P[0], code, 'Аня', 'книга');
        await join(P[1], code, 'Борис', null);
        await join(P[2], code, 'Вера', 'носки');
        await draw(roomId);

        t.now = new Date('2026-12-28T07:01:00Z'); // 28.12 10:00 по Москве, обмен 30.12
        expect((await t.app.scheduler.tick()).messages).toBe(3);
        const reminder = last(P[0]);
        expect(reminder.text).toContain('обмен подарками 30 декабря. Вы дарите:');
        expect(reminder.text).toContain('Пожелание:');
        expect(reminder.buttons.map((b) => b.title)).toEqual([
            'Кому я дарю?',
            'Анонимный вопрос подопечному',
        ]);
        // Пожелание дошло до Санты Ани
        const forAnya = t.sent.find((m) => m.text.includes('Вы дарите: Аня.'));
        expect(forAnya?.text).toContain('Пожелание: книга');
        // Организатор не участвует — ему напоминание не приходит, повторный tick молчит
        const ownerMessages = t.sent.filter(
            (m) => m.chatId === String(OWNER) && m.text.includes('обмен подарками 30 декабря'),
        );
        expect(ownerMessages).toEqual([]);
        expect((await t.app.scheduler.tick()).messages).toBe(0);
    });
});

/** Отдельный describe: G нужен свой порядок (код после создания), чтобы не путать хелперы. */
describe('UX-обзор: G, H, I, J', () => {
    beforeEach(() => {
        t = new TestBot();
        t.now = new Date('2026-11-07T12:00:00Z');
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    async function createGame(opts: {
        title: string;
        budget?: string | null;
        date?: string | null;
        play?: boolean;
    }): Promise<{ code: string; roomId: string }> {
        const { budget = 'до 1500 ₽', date = '30.12', play = true } = opts;
        await t.telegram(OWNER, 'создать', 'Оля');
        await t.telegram(OWNER, opts.title, 'Оля');
        if (budget === null) {
            await click2(OWNER, 'Без бюджета');
        } else {
            await t.telegram(OWNER, budget, 'Оля');
        }
        if (date === null) {
            await click2(OWNER, 'Без даты');
        } else {
            await t.telegram(OWNER, date, 'Оля');
        }
        await click2(OWNER, play ? 'Я участвую' : 'Только организую');
        if (play) {
            await click2(OWNER, 'Да, так');
            await click2(OWNER, 'Без пожелания');
        }
        const card = [...t.sent]
            .reverse()
            .find((m) => m.chatId === String(OWNER) && m.text.includes('Игра создана'));
        if (!card) {
            throw new Error('Нет карточки');
        }
        return { code: codeOf(card), roomId: roomIdOf(card) };
    }

    async function click2(id: number, title: string): Promise<void> {
        const message = t.lastTo(id);
        const button = message.buttons.find((b) => b.title.startsWith(title));
        if (!button?.payload) {
            throw new Error(`Нет кнопки «${title}»: ${message.text}`);
        }
        await t.telegramPress(id, button.payload);
    }

    async function join(
        id: number,
        code: string,
        name: string,
        wish: string | null,
    ): Promise<void> {
        await t.telegram(id, code, name);
        await click2(id, 'Участвую');
        await click2(id, 'Да, так');
        if (wish === null) {
            await click2(id, 'Без пожелания');
        } else {
            await t.telegram(id, wish, name);
        }
    }

    async function draw(roomId: string): Promise<void> {
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click2(OWNER, 'Провести жеребьёвку');
        await click2(OWNER, 'Да, провести');
        await t.app.notifier.whenIdle();
    }

    it('G: игра без даты висит неделю — подгон организатору один раз', async () => {
        const { code, roomId } = await createGame({
            title: 'Висит',
            budget: null,
            date: null,
            play: false,
        });
        await join(P[0], code, 'Аня', null);
        await join(P[1], code, 'Борис', null);
        await join(P[2], code, 'Вера', null);

        t.now = new Date('2026-11-14T12:01:00Z'); // неделя после создания
        expect((await t.app.scheduler.tick()).messages).toBe(1);
        const nudge = last(OWNER);
        expect(nudge.text).toContain('игра в наборе уже больше недели');
        expect(nudge.text).toContain('Напомните участникам код игры');
        expect((await t.app.scheduler.tick()).messages).toBe(0);
        expect((await t.app.service.store.findRoom(roomId))?.settings.nudged).toBe('1');
    });

    it('H: плохие коды — подсказки без бана, верный код работает', async () => {
        const { code } = await createGame({ title: 'Коды' });
        const stranger = P[5];
        // Неверный код в правильном формате
        await t.telegram(stranger, code.toLowerCase().split('').reverse().join(''), 'Хакер');
        expect(last(stranger).text).toContain('Игра с таким кодом не найдена');
        // Код с нулём: отдельная подсказка про алфавит
        await t.telegram(stranger, 'AAA0AA', 'Хакер');
        expect(last(stranger).text).toContain('В коде нет цифр 0 и 1');
        // Мусор — не код
        await t.telegram(stranger, 'блаблаба когда жеребьёвка', 'Хакер');
        expect(last(stranger).text).toContain('Не понял');
        // 5 неверных подряд — пока без бана
        for (const wrong of ['AAAAAB', 'AAAAAC', 'AAAAAD', 'AAAAAE', 'AAAAAF']) {
            await t.telegram(stranger, wrong, 'Хакер');
            expect(last(stranger).text).toContain('не найдена');
        }
        // Верного кода бан не касается
        await t.telegram(stranger, code, 'Хакер');
        expect(last(stranger).text).toContain('Участвуете?');
    });

    it('H2: 10 неверных кодов — блокировка на час; верный код при этом работает', async () => {
        const { code } = await createGame({ title: 'Бан' });
        const stranger = P[5];
        for (const wrong of '23456789AB'.split('').map((c) => `BBBBB${c}`)) {
            await t.telegram(stranger, wrong, 'Хакер');
            expect(last(stranger).text).toContain('не найдена');
        }
        // Одиннадцатый неверный код — бан; верный код в блокировку не попадает:
        // нашедший код не виноват, а подбор ограничен именно неверными попытками
        await t.telegram(stranger, 'KKKKKK', 'Хакер');
        expect(last(stranger).text).toBe('Слишком много неверных кодов. Попробуйте через час.');
        await t.telegram(stranger, code, 'Хакер');
        expect(last(stranger).text).toContain('Участвуете?');
        // Час не прошёл (в тестах часы CodeGuard — реальное время): ждать разбана не будем,
        // снятие блокировки через час покрыто модульным тестом CodeGuard
    });

    it('I: анонимный вопрос, ответ, жалоба, исключение автора', async () => {
        const { code, roomId } = await createGame({ title: 'Вопросы' });
        await join(P[0], code, 'Аня', null);
        await join(P[1], code, 'Борис', null);
        await draw(roomId);

        const participants = await t.app.service.store.participantsOf(roomId);
        // Автор вопроса — участник, не организатор: исключённого проверяем отдельно
        const giver = participants.find((p) => p.userId === String(P[0]));
        const recipient = participants.find((p) => p.id === giver?.recipientId);
        if (!giver?.userId || !recipient?.userId) {
            throw new Error('Нет пары даритель → подопечный в Telegram');
        }
        const giverId = Number(giver.userId);
        const recipientId = Number(recipient.userId);

        // Вопрос
        await t.telegramPress(giverId, { action: A.room, r: roomId });
        await click2(giverId, 'Анонимный вопрос подопечному');
        expect(last(giverId).text).toContain('получатель не узнает, от кого оно');
        await t.telegram(giverId, 'Какой чай любишь?', giver.name);
        expect(last(giverId).text).toBe('Сообщение отправлено.');
        await t.app.notifier.whenIdle();
        const question = last(recipientId);
        expect(question.text).toBe('Анонимное сообщение в «Вопросы»:\n\nКакой чай любишь?');
        expect(question.text).not.toContain(giver.name);
        // К каждому анонимному сообщению прилагается кнопка возврата к игре
        expect(question.buttons.map((b) => b.title)).toEqual([
            'Ответить анонимно',
            'Пожаловаться',
            'Заблокировать',
            'К игре',
        ]);

        // Ответ
        await click2(recipientId, 'Ответить анонимно');
        await t.telegram(recipientId, 'Зелёный, пожалуйста', recipient.name);
        await t.app.notifier.whenIdle();
        // Автор видит свой исходный вопрос в цитате
        expect(last(giverId).text).toBe(
            'Анонимное сообщение в «Вопросы»:\n\nЗелёный, пожалуйста\n\nВ ответ на ваше сообщение:\n«Какой чай любишь?»',
        );

        // Второй вопрос
        await t.telegramPress(giverId, { action: A.room, r: roomId });
        await click2(giverId, 'Анонимный вопрос подопечному');
        await t.telegram(giverId, 'И кофе можно?', giver.name);
        await t.app.notifier.whenIdle();
        expect(last(recipientId).text).toContain('И кофе можно?');

        // Жалоба на второй вопрос
        await click2(recipientId, 'Пожаловаться');
        expect(last(recipientId).text).toBe('Жалоба отправлена организатору.');
        await t.app.notifier.whenIdle();
        const complaint = last(OWNER);
        expect(complaint.text).toContain('Автора бот не раскрывает');
        expect(complaint.text).toContain('Текст сообщения:\nИ кофе можно?');
        expect(complaint.text).not.toContain(giver.name);

        // Исключение автора после жеребьёвки: подтверждение, затем результат
        await click2(OWNER, 'Исключить автора');
        expect(last(OWNER).text).toContain('Исключить автора из игры');
        await click2(OWNER, 'Да, исключить');
        expect(last(OWNER).text).toBe('Автор больше не участвует в игре.');
        await t.app.notifier.whenIdle();
        // Регрессия: уже доставленные сообщения автора сохраняются у получателя
        // (стираются только недоставленные; при «удалить мои данные» — все)
        const keptInbox = await t.app.relay.inbox(
            { platform: 'telegram', userId: String(recipientId) },
            roomId,
        );
        expect(keptInbox.map((r) => r.text)).toEqual(['Какой чай любишь?', 'И кофе можно?']);
        // Санте исключённого и его подопечному — уведомления
        const refreshed = await t.app.service.store.participantsOf(roomId);
        const santaOfGone = refreshed.find((p) => p.recipientId === giver.id && p.userId);
        const orphan = refreshed.find((p) => p.id === giver.recipientId && p.userId);
        expect(last(Number(santaOfGone?.userId)).text).toContain(
            `ваш подопечный ${giver.name} больше не участвует`,
        );
        expect(last(Number(orphan?.userId)).text).toContain('ваш Тайный Санта больше не участвует');
        // Сам исключённый узнаёт только факт, без причины: по факту исключения
        // в игре на 3–4 человек жалобщика вычислить нельзя
        const goneMessages = t.sent.filter(
            (m) => m.chatId === String(giverId) && m.text.includes('больше не участвует'),
        );
        expect(goneMessages).toHaveLength(1);
        expect(goneMessages[0]!.text).toContain('Вы больше не участвуете');
        expect(goneMessages[0]!.text).not.toContain('жалоб');
        expect(refreshed.find((p) => p.id === giver.id)?.userId).toBe('');
    });

    it('J: «удалить мои данные» после жеребьёвки — уведомления и карточка организатора', async () => {
        const { code, roomId } = await createGame({ title: 'Забыли' });
        await join(P[0], code, 'Аня', 'книга');
        await join(P[1], code, 'Борис', null);
        await draw(roomId);

        const participants = await t.app.service.store.participantsOf(roomId);
        const gone = participants.find((p) => p.userId === String(P[0]));
        const giver = participants.find((p) => p.recipientId === gone?.id);
        const orphan = participants.find((p) => p.id === gone?.recipientId);
        if (!gone || !giver?.userId || !orphan?.userId) {
            throw new Error('Нет пар');
        }

        await t.telegram(P[0], 'удалить мои данные', 'Аня');
        expect(last(P[0]).text).toContain('Удалить все ваши данные?');
        await click2(P[0], 'Да, удалить всё');
        expect(last(P[0]).text).toContain('Данных о вас у бота больше нет');
        await t.app.notifier.whenIdle();

        // Санте и подопечному — уведомления
        expect(last(Number(giver.userId)).text).toContain(
            `ваш подопечный ${gone.name} больше не участвует`,
        );
        expect(last(Number(orphan.userId)).text).toContain('ваш Тайный Санта больше не участвует');

        // Карточка организатора
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        const card = last(OWNER);
        expect(card.text).toContain('В игре 2 участника');
        await click2(OWNER, 'Кто кому дарит');
        const handover = last(OWNER);
        expect(handover.text).toContain('подопечный вышел');
        expect(handover.text).toContain('Остались без Санты');
        await t.telegramPress(OWNER, { action: A.members, r: roomId });
        expect(last(OWNER).text).toContain('участник выбыл (Telegram)');
    });
});
