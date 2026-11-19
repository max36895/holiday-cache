/**
 * Правки второго круга тестирования (sandbox/report-round2.md): даты-регресс,
 * протухшие кнопки, черновики анонимок, уведомления при кике, бан-список,
 * фраза с кодом, перезапуск навыка.
 */
import { parseDate, parseDateTime, parseDayMonth } from '../src/core/time';
import { A, IPayload } from '../src/ui';
import { MODES } from '../src/modes/registry';
import { ISentMessage, codeOf, roomIdOf, TestBot } from './helpers';

const OWNER = 2001;
const ANYA = 2002;
const PETYA = 2003;
const NICK = 2004;
const TODAY = '2026-11-14';

/** Нажимает кнопку из Telegram-сообщения по подписи. */
function press(message: ISentMessage, title: string): IPayload {
    const payload = message.buttons.find((b) => b.title.startsWith(title))?.payload;
    if (!payload) {
        throw new Error(`Нет кнопки «${title}»: ${message.buttons.map((b) => b.title).join(', ')}`);
    }
    return payload;
}

/** Создаёт Санту с Telegram-организатором без бюджета и даты, только организует. */
async function createSantaTg(t: TestBot, title: string): Promise<{ code: string; roomId: string }> {
    await t.telegram(OWNER, '/start', 'Оля');
    await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Создать игру'));
    await t.telegram(OWNER, title, 'Оля');
    await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Без бюджета'));
    await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Без даты'));
    await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Только организую'));
    // Карточка уходит первой, приглашение — вторым: ищем карточку по заголовку
    const card = [...t.sent]
        .reverse()
        .find((m) => m.chatId === String(OWNER) && m.text.includes('Игра создана'))!;
    const reply = { text: card.text, buttons: card.buttons };
    return { code: codeOf(reply), roomId: roomIdOf(reply) };
}

/** Telegram-участник входит в игру и ждёт жеребьёвку. */
async function joinTg(t: TestBot, id: number, name: string, code: string): Promise<void> {
    await t.telegram(id, code, name);
    await t.telegramPress(id, press(t.lastTo(id), 'Участвую'));
    await t.telegramPress(id, press(t.lastTo(id), 'Да, так'));
    await t.telegramPress(id, press(t.lastTo(id), 'Без пожелания'));
}

/** Карточка игры с кнопкой жеребьёвки среди последних сообщений организатору. */
function santaCard(t: TestBot, title: string): ISentMessage {
    const card = [...t.sent]
        .reverse()
        .find(
            (m) =>
                m.chatId === String(OWNER) &&
                m.text.includes(title) &&
                m.buttons.some((b) => b.title.startsWith('Провести жеребьёвку')),
        );
    if (!card) {
        throw new Error(`Нет карточки «${title}» с жеребьёвкой`);
    }
    return card;
}

/** Организатор проводит жеребьёвку, результаты доходят. */
async function drawTg(t: TestBot, title: string): Promise<void> {
    await t.telegramPress(OWNER, press(santaCard(t, title), 'Провести жеребьёвку'));
    await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Да, провести'));
    await t.app.notifier.whenIdle();
}

describe('даты: регресс первого круга', () => {
    it('parseDateTime: голое время без даты — сегодня', () => {
        expect(parseDateTime('в 19:00', TODAY)).toBe('2026-11-14T19:00');
        expect(parseDateTime('19:30', TODAY)).toBe('2026-11-14T19:30');
        expect(parseDateTime('19-30', TODAY)).toBe('2026-11-14T19:30');
        expect(parseDateTime('в 19-30', TODAY)).toBe('2026-11-14T19:30');
        expect(parseDateTime('в 9', TODAY)).toBe('2026-11-14T09:00');
        expect(parseDateTime('завтра в 9', TODAY)).toBe('2026-11-15T09:00');
        expect(parseDateTime('сегодня в 23:00', TODAY)).toBe('2026-11-14T23:00');
        expect(parseDateTime('11.03 11:11', TODAY)).toBe('2027-03-11T11:11');
        expect(parseDateTime('2027-03-11 19:30', TODAY)).toBe('2027-03-11T19:30');
        expect(parseDateTime('11 марта в 11:11', TODAY)).toBe('2027-03-11T11:11');
        expect(parseDateTime('14.03.2027 19.30', TODAY)).toBe('2027-03-14T19:30');
    });

    it('слитный день и месяц: «11марта» разбирается во всех парсерах', () => {
        expect(parseDate('11марта', TODAY)).toBe('2027-03-11');
        expect(parseDateTime('11марта в 19:00', TODAY)).toBe('2027-03-11T19:00');
        expect(parseDayMonth('11марта')).toBe('03-11');
        // Числовые месяцы не портятся нормализацией
        expect(parseDate('27.12', TODAY)).toBe('2026-12-27');
        expect(parseDayMonth('29 февраля')).toBe('02-29');
    });
});

describe('фраза с кодом и перезапуск навыка', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
    });

    it('«Привет. Код: K7M2QX» — вход в игру, а не подсказка про символы', async () => {
        const { code } = await createSantaTg(t, 'С кодом в фразе');
        await t.telegram(ANYA, `Привет. Код: ${code}`, 'Аня');
        expect(t.lastTo(ANYA).text).toContain('Участвуете?');
        // Код с запрещёнными символами в приветственной фразе — подсказка
        await t.telegram(PETYA, 'Привет. Код: AB10OL', 'Петя');
        expect(t.lastTo(PETYA).text).toContain('нет цифр 0 и 1');
    });

    it('«запусти навык …» в старой сессии Алисы открывает меню', async () => {
        expect((await t.alisa('guest', 'запусти навык тестовый навык')).text).toContain(
            'Играем вместе',
        );
        expect((await t.alisa('guest2', 'открой навык тестовый навык')).text).toContain(
            'Играем вместе',
        );
    });

    it('последняя попытка кода предупреждает, верный код во время блокировки работает', async () => {
        const { code } = await createSantaTg(t, 'Бан');
        for (const last of '23456789') {
            expect((await t.alisa('hacker', `CCCCC${last}`)).text).toContain('не найдена');
        }
        expect((await t.alisa('hacker', 'CCCCCA')).text).toContain('Осталось попыток: 1');
        expect((await t.alisa('hacker', 'CCCCCB')).text).toContain('Это последняя попытка');
        expect((await t.alisa('hacker', 'CCCCCC')).text).toContain('Слишком много неверных кодов');
        // Верный код в блокировку не попает: нашедший код не виноват
        expect((await t.alisa('hacker', code)).text).toContain('Участвуете?');
    });

    it('«похоже на код» тоже считается попыткой подбора', async () => {
        await createSantaTg(t, 'Подсказки');
        for (let i = 0; i < 8; i++) {
            await t.alisa('hacker', 'AB10OL');
        }
        expect((await t.alisa('hacker', 'AB10OL')).text).toContain('Осталось попыток: 1');
    });
});

describe('анонимные сообщения: протухшая кнопка ответа', () => {
    let t: TestBot;
    let roomId: string;

    beforeEach(async () => {
        t = new TestBot();
        // Все на Telegram: Алисе нельзя писать первой — уведомления до неё не дойдут
        const created = await createSantaTg(t, 'Ответы');
        roomId = created.roomId;
        await joinTg(t, ANYA, 'Аня', created.code);
        await joinTg(t, PETYA, 'Петя', created.code);
        await joinTg(t, NICK, 'Ник', created.code);
        await drawTg(t, 'Ответы');
    });

    afterEach(async () => {
        await t.close();
    });

    it('после исключения автора ошибка приходит на кнопке, до ввода текста', async () => {
        // Аня анонимно спрашивает подопечного
        const anyaId = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.userId === String(ANYA),
        )!.id;
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Анонимный вопрос подопечному'));
        await t.telegram(ANYA, 'Какой чай любишь?', 'Аня');
        await t.app.notifier.whenIdle();
        const relay = (await t.app.service.store.relaysOf(roomId)).find(
            (r) => r.text === 'Какой чай любишь?',
        )!;
        const recipientId = Number(
            (await t.app.service.store.participantsOf(roomId)).find((p) => p.id === relay.toId)!
                .userId,
        );
        // Жалоба → исключение автора
        await t.telegramPress(recipientId, press(t.lastTo(recipientId), 'Пожаловаться'));
        await t.app.notifier.whenIdle();
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Исключить автора'));
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Да, исключить'));
        await t.app.notifier.whenIdle();
        // После фиксации состава запись остаётся, но имя и id стёрты (анонимность)
        expect(
            (await t.app.service.store.participantsOf(roomId)).find((p) => p.id === anyaId)!.userId,
        ).toBe('');
        // Протухшая кнопка «Ответить анонимно»: ошибка сразу, мастер не открывается
        await t.telegramPress(recipientId, { action: A.reply, x: relay.id });
        expect(t.lastTo(recipientId).text).toContain('Автор этого сообщения больше не участвует');
        expect(t.lastTo(recipientId).text).not.toContain('Напишите сообщение');
        // И ответ вникуда невозможен даже в обход мастера
        await expect(
            t.app.relay.reply(
                { platform: 'telegram', userId: String(recipientId) },
                relay.id,
                'ответ',
            ),
        ).rejects.toThrow('Автор этого сообщения больше не участвует');
    });
});

describe('валентинки: черновик при выборе адресата', () => {
    let t: TestBot;
    let code: string;

    beforeEach(async () => {
        t = new TestBot({}, MODES);
        await t.alisa('owner', 'создать');
        await t.alisa('owner', 'Анонимные валентинки');
        await t.alisa('owner', 'Секретные валентинки');
        await t.alisa('owner', 'Москва');
        const role = await t.alisa('owner', '14 февраля в 10:00');
        await t.alisaClick('owner', role, 'Я участвую');
        const created = await t.alisa('owner', 'Оля');
        code = codeOf(created);
        await t.join('anya', code);
        await t.join('petya', code);
    });

    afterEach(async () => {
        await t.close();
    });

    it('текст → выбор адресата → текст подсказкой, «Да, так» отправляет', async () => {
        // Помощь-хелпер join оставляет открытый черновик: отменяем его
        await t.alisa('anya', 'отмена');
        // Свободный текст при нескольких адресатах — выбор адресата
        const chooser = await t.alisa('anya', 'С наступающим!');
        expect(chooser.text).toContain('Кому адресовать');
        // Имена адресатов проговариваются в самом тексте: пользователь без экрана
        // слышит, из кого выбирать
        expect(chooser.text).toContain('Оля');
        expect(chooser.text).toContain('Petya');
        const targetButton = chooser.buttons.find((b) => b.title === 'Petya')!.payload;
        expect(targetButton).not.toBeNull();
        const wizard = await t.alisaPress('anya', targetButton!);
        // Текст вернулся подсказкой мастера, а не пропал
        expect(wizard.text).toContain('Напишите сообщение');
        expect((await t.alisaClick('anya', wizard, 'Да, так')).text).toContain(
            'Сообщение будет доставлено в назначенное время',
        );
    });
});

describe('кик и запрет исключения организатора', () => {
    let t: TestBot;
    let code: string;
    let roomId: string;

    beforeEach(async () => {
        t = new TestBot();
        const created = await t.createGame('owner', false, 'Кик-тест');
        code = codeOf(created);
        roomId = roomIdOf(created);
        await t.telegram(ANYA, code, 'Аня');
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Участвую'));
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Да, так'));
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Без пожелания'));
    });

    afterEach(async () => {
        await t.close();
    });

    it('исключённый получает нейтральное уведомление, кнопка-призрак умирает', async () => {
        const list = await t.alisaPress('owner', { action: A.members, r: roomId });
        await t.alisaClick('owner', list, 'Исключить: Аня');
        await t.app.notifier.whenIdle();
        // Исключённому пришло уведомление без причины
        expect(t.lastTo(ANYA).text).toContain('больше не участвуете');
        expect(t.lastTo(ANYA).text).not.toContain('жалоб');
        // Кнопка-призрак «Текущая игра» у исключённого умирает при первом нажатии
        await t.telegram(ANYA, 'меню', 'Аня');
        await t.telegramPress(ANYA, press(t.lastTo(ANYA), 'Текущая игра'));
        expect(t.lastTo(ANYA).text).toContain('Вы не участвуете');
        // Кик (без жалобы) не заносит в бан-список: организатор мог ошибиться
        await t.telegram(ANYA, code, 'Аня');
        expect(t.lastTo(ANYA).text).toContain('Участвуете?');
    });

    it('организатора нельзя исключить из его же игры', async () => {
        const created = await t.createGame('owner2', true, 'Организатор играет');
        const room2 = roomIdOf(created);
        await t.join('friend', codeOf(created));
        const ownerRow = (await t.app.service.store.participantsOf(room2)).find(
            (p) => p.userId === 'owner2',
        )!;
        await expect(
            t.app.service.expel({ platform: 'alisa', userId: 'owner2' }, room2, ownerRow.id),
        ).rejects.toThrow('Организатора нельзя исключить из игры.');
    });
});

describe('UX-правки второго круга', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
    });

    it('«входящие сообщения» голосом работает без открытой карточки', async () => {
        const created = await t.createGame('owner', true, 'Голос');
        const roomId = roomIdOf(created);
        await t.join('anya', codeOf(created));
        await t.join('petya', codeOf(created));
        const card = await t.alisaPress('owner', { action: A.room, r: roomId });
        const confirm = await t.alisaClick('owner', card, 'Провести жеребьёвку');
        await t.alisaClick('owner', confirm, 'Да, провести');
        await t.app.notifier.whenIdle();
        // Организатор пишет подопечному; подопечный затем говорит «входящие сообщения»
        const rows = await t.app.service.store.participantsOf(roomId);
        const ownerRow = rows.find((p) => p.userId === 'owner')!;
        const recipientId = rows.find((p) => p.id === ownerRow.recipientId)!.userId;
        await t.alisaPress('owner', { action: A.write, r: roomId });
        await t.alisa('owner', 'Какой подарок хочешь?');
        const spoken = await t.alisa(recipientId, 'входящие сообщения');
        expect(spoken.text).toContain('Ваши входящие анонимные сообщения');
        expect(spoken.text).toContain('Какой подарок хочешь?');
    });

    it('мастер переживает промах по кнопке главного меню', async () => {
        await t.alisa('owner', 'создать');
        await t.alisa('owner', 'Промах');
        // «Создать игру» из старой клавиатуры во время мастера не стирает ввод
        const again = await t.alisaPress('owner', { action: A.create });
        expect(again.text).toContain('Сначала закончите заполнение');
        expect(again.text).toContain('Какой бюджет подарка');
    });

    it('подсказка даты объясняет, что время не нужно', async () => {
        await t.alisa('owner', 'создать');
        await t.alisa('owner', 'Без времени');
        await t.alisa('owner', 'до 1500 ₽');
        const bad = await t.alisa('owner', '27 декабря в 19:00');
        expect(bad.text).toContain('Не понял дату');
        expect(bad.text).toContain('без времени');
    });

    it('перенос даты закрытой Санты: вопрос сразу, без подтверждения', async () => {
        const created = await t.createGame('owner', false, 'Перенос');
        const roomId = roomIdOf(created);
        await t.join('anya', codeOf(created));
        await t.join('petya', codeOf(created));
        const card = await t.alisaPress('owner', { action: A.room, r: roomId });
        const confirm = await t.alisaClick('owner', card, 'Провести жеребьёвку');
        await t.alisaClick('owner', confirm, 'Да, провести');
        await t.app.notifier.whenIdle();
        const roomCard = await t.alisaPress('owner', { action: A.room, r: roomId });
        const dateAsk = await t.alisaClick('owner', roomCard, 'Изменить дату обмена');
        // Сразу вопрос даты, а не «Перенести?» — ответ-дата не может уехать в черновик
        expect(dateAsk.text).toContain('Когда обмен подарками');
        expect((await t.alisa('owner', '5 января')).text).toContain('Обмен перенесён: 5 января');
    });
});
