import { ValentineMode } from '../src/modes/valentines/ValentineMode';
import { MODES } from '../src/modes/registry';
import { A, IPayload } from '../src/ui';
import { codeOf, IReply, ISentMessage, roomIdOf, TestBot } from './helpers';

/**
 * UX-обзор «Анонимных валентинок» и «Тайного дарителя» (gift) глазами живых,
 * креативных и эмоциональных пользователей: эмодзи, длинные имена, границы
 * лимитов, отмена в последний момент, драма с блокировками и исключениями.
 */

const OWNER = 4101; // Александра 👑✨ — организатор, участвует сама
const ROMANTIC = 4102;
const ANYA = 4103;
const BORETS = 4104;
const P_ALISA = 'alisa-4401';
const P_VK = 4201;
const P_MAX = 4301;

const VALENTINE_TITLE = '💚💚💚 Новогодний корпоративчик 2026!!!';
/** 14.02.2027 18:00 по Москве */
const DEADLINE = new Date('2027-02-14T15:01:00Z');

/** Общий бот: присваивается в beforeEach каждого describe. */
let t: TestBot;

function last(id: number): ISentMessage {
    return t.lastTo(id);
}

function findSent(id: number, substr: string): ISentMessage {
    const found = [...t.sent]
        .reverse()
        .find((m) => m.chatId === String(id) && m.text.includes(substr));
    if (!found) {
        throw new Error(`В чат ${id} не отправлено сообщение с «${substr}»`);
    }
    return found;
}

function payloadOf(reply: IReply | ISentMessage, title: string): IPayload {
    const button = reply.buttons.find((b) => b.title.startsWith(title));
    if (!button?.payload) {
        throw new Error(
            `Нет кнопки «${title}» в ответе: ${reply.buttons.map((b) => b.title).join(', ')}`,
        );
    }
    return button.payload;
}

async function click(id: number, title: string): Promise<void> {
    await t.telegramPress(id, payloadOf(last(id), title));
}

async function idle(): Promise<void> {
    await t.app.notifier.whenIdle();
}

/** Организатор создаёт валентинки в Telegram: название с эмодзи, дата 14.02.2027 18:00, участвует сама. */
async function createValentines(
    eventAt = '14.02.2027 18:00',
    title = VALENTINE_TITLE,
): Promise<{ code: string; roomId: string }> {
    await t.telegram(OWNER, 'создать', 'Александра 👑✨');
    await click(OWNER, 'Анонимные валентинки');
    await t.telegram(OWNER, title, 'Александра 👑✨');
    await t.telegram(OWNER, 'Москва', 'Александра 👑✨');
    await t.telegram(OWNER, eventAt, 'Александра 👑✨');
    await click(OWNER, 'Я участвую');
    await click(OWNER, 'Да, так'); // имя из профиля: «Александра 👑✨»
    const card = findSent(OWNER, 'Игра создана');
    return { code: codeOf(card), roomId: roomIdOf(card) };
}

/** Участник Telegram входит по коду; имя набирает текстом. */
async function joinTG(id: number, code: string, name: string): Promise<void> {
    await t.telegram(id, code, name);
    await click(id, 'Участвую');
    await t.telegram(id, name, name);
}

async function joinVK(id: number, code: string, name: string): Promise<void> {
    await t.vk(id, code);
    await t.vkClick(id, last(id), 'Участвую');
    await t.vk(id, name);
}

async function joinMAX(id: number, code: string, name: string): Promise<void> {
    await t.max(id, code, name);
    await t.maxPress(id, payloadOf(last(id), 'Участвую'));
    await t.max(id, name);
}

async function joinAlisa(userId: string, code: string, name = 'Алиса Снежная'): Promise<void> {
    const preview = await t.alisa(userId, code);
    await t.alisaClick(userId, preview, 'Участвую');
    await t.alisa(userId, name);
}

/** Отправка валентинки через бот-интерфейс: «Написать анонимно» → выбор адресата → текст. */
function valentineSender(roomId: string) {
    return async (fromId: number, targetTitle: string, text: string): Promise<ISentMessage> => {
        await t.telegramPress(fromId, { action: A.write, r: roomId });
        await t.telegramPress(fromId, payloadOf(last(fromId), targetTitle));
        await t.telegram(fromId, text);
        return last(fromId);
    };
}

/** id участника по chat_id Telegram. */
async function participantId(roomId: string, chatId: number): Promise<string> {
    const found = (await t.app.service.store.participantsOf(roomId)).find(
        (p) => p.userId === String(chatId),
    );
    if (!found) {
        throw new Error(`Нет участника с chat_id ${chatId}`);
    }
    return found.id;
}

describe('Валентинки: креативные пользователи', () => {
    beforeEach(() => {
        t = new TestBot({}, MODES);
        t.now = new Date('2027-01-25T12:00:00Z'); // конец января, до 14.02.2027
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('A: создание с эмодзи, кривые форматы даты, 5 участников с четырёх платформ', async () => {
        await t.telegram(OWNER, 'создать', 'Александра 👑✨');
        await click(OWNER, 'Анонимные валентинки');
        // Название с эмодзи принимается целиком
        await t.telegram(OWNER, VALENTINE_TITLE, 'Александра 👑✨');
        await t.telegram(OWNER, 'Москва', 'Александра 👑✨');
        // Кривые форматы даты/времени
        await t.telegram(OWNER, '14 февраля вечером', 'Александра 👑✨');
        expect(last(OWNER).text).toContain('Не понял дату и время');
        await t.telegram(OWNER, '25:00', 'Александра 👑✨');
        expect(last(OWNER).text).toContain('Не понял дату и время');
        await t.telegram(OWNER, '31.02.2027', 'Александра 👑✨');
        expect(last(OWNER).text).toContain('Не понял дату и время');
        // Кнопка-пресет «14 февраля в 08:00» работает: значение принимается как ответ
        await click(OWNER, '14 февраля в 08:00');
        expect(last(OWNER).text).toContain('Вы участвуете в игре сами');
        await click(OWNER, 'Я участвую');
        await click(OWNER, 'Да, так');

        const card = findSent(OWNER, 'Игра создана');
        const { code, roomId } = { code: codeOf(card), roomId: roomIdOf(card) };
        expect(card.text).toContain(VALENTINE_TITLE);
        expect(card.text).toContain('14 февраля в 08:00 (Europe/Moscow)');
        expect(card.text).toContain('Лимит: 20 поздравлений по 500 символов');

        await joinTG(ROMANTIC, code, 'Романтик Влюблённый');
        expect(last(ROMANTIC).text).toContain('Вы в игре');
        await joinVK(P_VK, code, 'Вика Веткина');
        expect(t.lastTo(P_VK).text).toContain('Вы в игре');
        await joinMAX(P_MAX, code, 'Максим Весёлый');
        expect(t.lastTo(P_MAX).text).toContain('Вы в игре');
        await joinTG(BORETS, code, 'Тимофей Тормоз');
        await joinAlisa(P_ALISA, code);
        await idle();

        // Организатор видит всех шестерых
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        expect(last(OWNER).text).toContain('В игре 6 участников');
        // И уведомления о каждом новичке приходили
        expect(findSent(OWNER, 'в игре Вика Веткина (VK). Всего').text).toContain(VALENTINE_TITLE);
        expect(findSent(OWNER, 'в игре Алиса Снежная (Алиса). Всего').text).toBeDefined();
        // Алиса видит карточку с эмодзи-названием
        const alisaCard = await t.alisaPress(P_ALISA, { action: A.room, r: roomId });
        expect(alisaCard.text).toContain(VALENTINE_TITLE);
    });

    it('B: границы 500/501/505, эмодзи, себе нельзя, 20 сообщений и 21-е уже нет', async () => {
        const { code, roomId } = await createValentines();
        await joinTG(ROMANTIC, code, 'Романтик Влюблённый');
        await joinTG(ANYA, code, 'Мила Аня');
        await joinAlisa(P_ALISA, code);
        const send = valentineSender(roomId);
        const anyaId = await participantId(roomId, ANYA);

        // «Кому написать?» — себя в списке нет
        await t.telegramPress(ROMANTIC, { action: A.write, r: roomId });
        const list = last(ROMANTIC);
        expect(list.text).toContain('Кому написать?');
        expect(list.buttons.some((b) => b.title.includes('Романтик'))).toBe(false);
        expect(list.buttons.some((b) => b.title.startsWith('Мила Аня'))).toBe(true);

        // Попытка написать себе подделанной кнопкой — вежливый отказ
        const myId = await participantId(roomId, ROMANTIC);
        await t.telegramPress(ROMANTIC, { action: A.write, r: roomId, x: myId });
        expect(last(ROMANTIC).text).toBe('Себе написать нельзя.');

        // 501 и 505 символов — отказ с повтором вопроса
        await t.telegramPress(ROMANTIC, { action: A.write, r: roomId, x: anyaId });
        expect(last(ROMANTIC).text).toContain('получатель не узнает, от кого оно');
        await t.telegram(ROMANTIC, 'а'.repeat(501));
        expect(last(ROMANTIC).text).toContain('Слишком длинно: не больше 500 символов');
        await t.telegram(ROMANTIC, 'а'.repeat(505));
        expect(last(ROMANTIC).text).toContain('Слишком длинно: не больше 500 символов');
        // Ровно 500 с эмодзи внутри — принято
        const long500 = `💌 ${'а'.repeat(497)}`;
        expect(long500.length).toBe(500);
        await t.telegram(ROMANTIC, long500);
        expect(last(ROMANTIC).text).toBe('Сообщение будет доставлено в назначенное время.');

        // Второе сообщение тому же человеку — можно
        await send(ROMANTIC, 'Мила Аня', 'а'.repeat(500));
        expect(last(ROMANTIC).text).toBe('Сообщение будет доставлено в назначенное время.');
        await send(ROMANTIC, 'Александра', 'Шеф, я всё отправил!');

        // Добиваем до лимита 20 и пробуем 21-е
        const owner = { platform: 'telegram', userId: String(ROMANTIC) };
        const alisaPart = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.platform === 'alisa',
        )!;
        const ownerPartId = await participantId(roomId, OWNER);
        for (let i = 3; i < 20; i++) {
            const toId = [anyaId, ownerPartId, alisaPart.id][i % 3];
            const result = await t.app.relay.send(owner, roomId, toId, `Валентинка №${i}`);
            expect(result.scheduled).toBe(true);
        }
        await send(ROMANTIC, 'Мила Аня', 'Двадцать первая, ну пожалуйста!');
        expect(last(ROMANTIC).text).toBe('Можно отправить не больше 20 сообщений в этой игре.');

        // Всего отправлено 20, из них 2 — одному человеку
        const mine = (await t.app.service.store.relaysOf(roomId)).filter((r) => r.fromId === myId);
        expect(mine).toHaveLength(20);
    });

    it('C: до срока получатель ничего не видит, автор отменяет, повторная отмена', async () => {
        const { code, roomId } = await createValentines();
        await joinTG(ROMANTIC, code, 'Романтик Влюблённый');
        await joinTG(ANYA, code, 'Мила Аня');
        const send = valentineSender(roomId);

        await send(ROMANTIC, 'Мила Аня', 'Ты сегодня чудесна 🌹');
        await send(ROMANTIC, 'Мила Аня', `💌 ${'а'.repeat(478)}`);

        // Получатель до срока: входящих нет и кнопки нет
        expect(
            await t.app.relay.inbox({ platform: 'telegram', userId: String(ANYA) }, roomId),
        ).toEqual([]);
        await t.telegramPress(ANYA, { action: A.inbox, r: roomId });
        // Сообщения уже ждут доставки: подсказка вместо пустого «нет»
        expect(last(ANYA).text).toContain('Вам уже отправлено 2 сообщения');
        expect(last(ANYA).text).toContain('откроются');

        // Автор: «Мои сообщения», длинный текст обрезан в кнопке, но нажатие работает
        await t.telegramPress(ROMANTIC, { action: A.outbox, r: roomId });
        const outbox = last(ROMANTIC);
        expect(outbox.text).toContain('Ваши сообщения, которые ещё не доставлены:');
        const long = outbox.buttons.find((b) => b.title.startsWith('Отменить: 💌'))!;
        expect([...long.title]).toHaveLength(40); // режется по кодпойнтам — эмодзи цел
        expect(long.title.endsWith('…')).toBe(true);
        await t.telegramPress(ROMANTIC, long.payload!);
        expect(last(ROMANTIC).text).toBe('Сообщение отменено.');

        // Отменяет то же самое ещё раз — вежливое «уже отменено» вместо «игру удалили»
        await t.telegramPress(ROMANTIC, long.payload!);
        expect(last(ROMANTIC).text).toBe('Сообщение уже отменено.');

        // Осталось одно недоставленное
        await t.telegramPress(ROMANTIC, { action: A.outbox, r: roomId });
        expect(last(ROMANTIC).buttons.filter((b) => b.title.startsWith('Отменить:'))).toHaveLength(
            1,
        );
    });

    it('D: доставка по сроку всем, Алиса читает в карточке, после срока приём закрыт', async () => {
        const { code, roomId } = await createValentines();
        await joinTG(ROMANTIC, code, 'Романтик Влюблённый');
        await joinTG(ANYA, code, 'Мила Аня');
        await joinAlisa(P_ALISA, code);
        const send = valentineSender(roomId);
        const anyaId = await participantId(roomId, ANYA);
        const alisaPart = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.platform === 'alisa',
        )!;

        await send(ROMANTIC, 'Мила Аня', `💌 ${'а'.repeat(478)}`);
        await send(ROMANTIC, 'Мила Аня', 'И ещё раз: ты чудесна!');
        await send(ROMANTIC, 'Александра', 'Шеф, я всё отправил!');
        await t.app.relay.send(
            { platform: 'telegram', userId: String(ROMANTIC) },
            roomId,
            alisaPart.id,
            'Для Алисы — ей можно только в карточке',
        );
        await t.app.relay.send(
            { platform: 'telegram', userId: String(ROMANTIC) },
            roomId,
            anyaId,
            'Пятое, контрольное',
        );
        expect((await t.app.scheduler.tick()).messages).toBe(0);

        t.now = DEADLINE;
        expect((await t.app.scheduler.tick()).messages).toBe(5);

        // Каждому в мессенджер, кнопки без ответа и без следов автора
        const longForAnya = findSent(ANYA, '💌');
        expect(longForAnya.text).toContain(`Анонимное сообщение в «${VALENTINE_TITLE}»`);
        expect(longForAnya.buttons.map((b) => b.title)).toEqual([
            'Пожаловаться',
            'Заблокировать',
            'К игре',
        ]);
        expect(findSent(ANYA, 'Пятое, контрольное').text).toBeDefined();
        expect(findSent(OWNER, 'Анонимное сообщение').text).toContain('Шеф, я всё отправил!');
        expect((await t.app.scheduler.tick()).messages).toBe(0);

        // Алисе пуша нет — она читает в карточке игры
        const card = await t.alisaPress(P_ALISA, { action: A.room, r: roomId });
        expect(card.buttons.map((b) => b.title)).toContain('Входящие сообщения');
        const inbox = await t.alisaClick(P_ALISA, card, 'Входящие сообщения');
        expect(inbox.text).toContain('Для Алисы — ей можно только в карточке');

        // После срока написать нельзя
        await t.telegramPress(ROMANTIC, { action: A.write, r: roomId });
        expect(last(ROMANTIC).text).toBe('Сейчас написать некому.');

        // Отмена в последний момент — уже доставлено
        const sentRelay = (await t.app.service.store.relaysOf(roomId)).find(
            (r) => r.status === 'sent',
        )!;
        await t.telegramPress(ROMANTIC, { action: A.unsend, r: roomId, x: sentRelay.id });
        expect(last(ROMANTIC).text).toBe('Сообщение уже доставлено.');

        // Приём завершён — режим закрыл комнату
        await t.telegramPress(ROMANTIC, { action: A.room, r: roomId });
        expect(last(ROMANTIC).text).toContain('Приём валентинок завершён');
    });

    it('E: драма — блокировка, жалоба, исключение; исключённый не узнаёт, доставленное у получателей остаётся', async () => {
        const { code, roomId } = await createValentines('14.02.2027 18:00', 'Драма в офисе');
        await joinTG(ROMANTIC, code, 'Хам Угрюмый');
        await joinTG(ANYA, code, 'Мила Аня');
        await joinTG(BORETS, code, 'Добрый Боря');
        const send = valentineSender(roomId);

        await send(ROMANTIC, 'Мила Аня', 'Ты никому не нравишься');
        await send(ROMANTIC, 'Мила Аня', 'И вообще мозги включи');
        await send(ROMANTIC, 'Мила Аня', 'Третье, не такое хамское');
        await send(ROMANTIC, 'Добрый Боря', 'И тебе не поздоровится');
        await send(BORETS, 'Мила Аня', 'Не обращай внимания на грубиянов');

        t.now = DEADLINE;
        expect((await t.app.scheduler.tick()).messages).toBe(5);
        expect(findSent(ANYA, 'Анонимное сообщение').text).toBeDefined();

        // Аня блокирует автора одного из хамств
        await t.telegramPress(ANYA, payloadOf(findSent(ANYA, 'мозги включи'), 'Заблокировать'));
        expect(last(ANYA).text).toBe(
            'Автор больше не сможет вам писать. Сам он об этом не узнает.',
        );

        // Жалуется на другое — организатор видит текст, но не автора
        await t.telegramPress(
            ANYA,
            payloadOf(findSent(ANYA, 'никому не нравишься'), 'Пожаловаться'),
        );
        expect(last(ANYA).text).toBe('Жалоба отправлена организатору.');
        await idle();
        const complaint = findSent(OWNER, 'участник пожаловался');
        expect(complaint.text).toContain('Автора бот не раскрывает');
        expect(complaint.text).toContain('Ты никому не нравишься');
        expect(complaint.text).not.toContain('Хам Угрюмый');

        // Тихая блокировка на отправке через UI в валентинках недостижима: приём закрывается
        // ровно в момент доставки. Её поведение проверено в режиме gift (тест I).

        // Организатор исключает автора: подтверждение, затем результат
        await t.telegramPress(OWNER, payloadOf(complaint, 'Исключить автора'));
        expect(last(OWNER).text).toContain('Исключить автора из игры');
        await t.telegramPress(OWNER, payloadOf(last(OWNER), 'Да, исключить'));
        expect(last(OWNER).text).toBe('Автор больше не участвует в игре.');
        await idle();

        // Исключённый узнаёт только сам факт, без причины и слова «жалоба»
        const toExpelled = t.sent.filter(
            (m) => m.chatId === String(ROMANTIC) && m.text.includes('Вы больше не участвуете'),
        );
        expect(toExpelled).toHaveLength(1);
        expect(toExpelled[0]!.text).not.toContain('жалоб');
        expect(
            t.sent.filter((m) => m.chatId === String(ROMANTIC) && m.text.includes('исключ')),
        ).toEqual([]);
        // Других сообщений об уходе (например, формата режима) исключённому нет
        expect(
            t.sent.filter(
                (m) =>
                    m.chatId === String(ROMANTIC) &&
                    m.text.includes('не участвует') &&
                    !m.text.includes('Если это ошибка'),
            ),
        ).toEqual([]);

        // Исключённый теряет доступ: карточка и отправка — «Вы не участвуете»
        await t.telegramPress(ROMANTIC, { action: A.room, r: roomId });
        expect(last(ROMANTIC).text).toBe('Вы не участвуете в этой игре.');
        await t.telegramPress(ROMANTIC, { action: A.write, r: roomId });
        expect(last(ROMANTIC).text).toBe('Вы не участвуете в этой игре.');

        // Доставленные валентинки исключённого СОХРАНИЛИСЬ у Ани — стёрты только недоставленные
        const inboxAfter = await t.app.relay.inbox(
            { platform: 'telegram', userId: String(ANYA) },
            roomId,
        );
        expect(inboxAfter.map((r) => r.text)).toEqual([
            'Ты никому не нравишься',
            'И вообще мозги включи',
            'Третье, не такое хамское',
            'Не обращай внимания на грубиянов',
        ]);
        await t.telegramPress(ANYA, { action: A.inbox, r: roomId });
        expect(last(ANYA).text).toContain('Не обращай внимания на грубиянов');
        expect(last(ANYA).text).toContain('мозги включи');
    });

    it('F: исключение до доставки — недоставленные валентинки всё равно уйдут получателю', async () => {
        const { code, roomId } = await createValentines('14.02.2027 18:00', 'Спешное исключение');
        await joinTG(ROMANTIC, code, 'Поспешный Гость');
        await joinTG(ANYA, code, 'Мила Аня');
        const send = valentineSender(roomId);

        await send(ROMANTIC, 'Мила Аня', 'Первое от гостя');
        await send(ROMANTIC, 'Мила Аня', 'Второе от гостя');
        await send(ANYA, 'Поспешный Гость', 'Ответ гостю');

        // Организатор исключает гостя до срока — через «Участники»
        await t.telegramPress(OWNER, { action: A.members, r: roomId });
        expect(last(OWNER).text).toContain('Поспешный Гость (Telegram)');
        await click(OWNER, 'Исключить: Поспешный Гость');
        expect(last(OWNER).text).toContain(
            'Поспешный Гость (Telegram) больше не участвует в игре.',
        );
        expect(last(OWNER).text).toContain('Мила Аня (Telegram)');

        // Срок наступил — что с недоставленными валентинками исключённого?
        t.now = DEADLINE;
        expect((await t.app.scheduler.tick()).messages).toBe(0);

        // Ни Аня, ни кто-либо ещё их не получили: при исключении сообщения гостя
        // молча удалены вместе с ним — и отправленные, и адресованные ему
        expect(
            t.sent.filter(
                (m) => m.chatId === String(ANYA) && m.text.includes('Анонимное сообщение'),
            ),
        ).toEqual([]);
        expect(
            t.sent.filter(
                (m) => m.chatId === String(ROMANTIC) && m.text.includes('Анонимное сообщение'),
            ),
        ).toEqual([]);
        const leftovers = (await t.app.service.store.relaysOf(roomId)).filter(
            (r) => r.text.includes('от гостя') || r.text.includes('Ответ гостю'),
        );
        expect(leftovers).toEqual([]);
        // Никаких предупреждений организатор при этом не получал: только список участников
        // и подтверждение исключения
        expect(
            t.sent.filter(
                (m) =>
                    m.chatId === String(OWNER) &&
                    m.text.includes('Поспешный') &&
                    !m.text.includes('Участники «') &&
                    !m.text.includes('больше не участвует'),
            ),
        ).toEqual([]);
    });
});

describe('Тайный даритель (gift): креативные пользователи', () => {
    beforeEach(() => {
        t = new TestBot({}, MODES);
        t.now = new Date('2026-11-07T12:00:00Z');
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    /** Комната gift: бюджет текстом, дата текстом, организатор участвует. */
    async function createGift(
        opts: { title?: string; budget?: string | null; date?: string | null } = {},
    ): Promise<{ code: string; roomId: string }> {
        const {
            title = 'Подарочный обмен в офисе 🎉',
            budget = 'до 1500 ₽',
            date = '30.12',
        } = opts;
        await t.telegram(OWNER, 'создать', 'Александра 👑✨');
        await click(OWNER, 'Тайный даритель');
        await t.telegram(OWNER, title, 'Александра 👑✨');
        if (budget === null) {
            await click(OWNER, 'Без бюджета');
        } else {
            await t.telegram(OWNER, budget, 'Александра 👑✨');
        }
        // Повод — новый вопрос «Тайного дарителя», отличающий его от Санты
        await click(OWNER, 'Без повода');
        if (date === null) {
            await click(OWNER, 'Без даты');
        } else {
            await t.telegram(OWNER, date, 'Александра 👑✨');
        }
        await click(OWNER, 'Я участвую');
        await click(OWNER, 'Да, так');
        await click(OWNER, 'Без пожелания');
        const card = findSent(OWNER, 'Игра создана');
        return { code: codeOf(card), roomId: roomIdOf(card) };
    }

    async function joinGift(id: number, code: string, name: string, wish?: string): Promise<void> {
        await joinTG(id, code, name);
        if (wish === undefined) {
            await click(id, 'Без пожелания');
        } else {
            await t.telegram(id, wish, name);
        }
        expect(last(id).text).toContain('Вы в игре, ждём жеребьёвку');
    }

    async function drawGift(roomId: string): Promise<void> {
        await idle(); // фоновые уведомления о новичках не должны перебить ответ жеребёвки
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Провести жере'); // «ё» в кнопке — составной символ, ищем без него
        await click(OWNER, 'Да, провести');
        await idle();
    }

    it('G: без бюджета/даты, жеребёвка от 3, кнопка бюджета не работает, вопрос, пожелание, отметки, сводка', async () => {
        // Минимальная комната: ни бюджета, ни даты
        const mini = await createGift({ budget: null, date: null, title: 'Мини-обмен' });
        expect(findSent(OWNER, 'Игра создана').text).not.toContain('Бюджет:');
        expect(findSent(OWNER, 'Игра создана').text).not.toContain('Обмен:');
        await joinGift(ROMANTIC, mini.code, 'Кристина Орлова');
        // Жеребёвка от трёх: вдвоём нельзя
        await drawGift(mini.roomId);
        expect(last(OWNER).text).toContain('нужно не меньше 3 участников, сейчас 2');

        // Полная комната: кнопка-пресет бюджета «1500 ₽» работает
        await t.telegram(OWNER, 'создать', 'Александра 👑✨');
        await click(OWNER, 'Тайный даритель');
        const from = t.sent.length; // дальше все тексты — только gift, без меню с Тайным Сантой
        await t.telegram(OWNER, 'Подарочный обмен в офисе 🎉', 'Александра 👑✨');
        await click(OWNER, '1500 ₽');
        expect(last(OWNER).text).toContain('Какой повод'); // пресет принят, вопрос следующий
        await click(OWNER, 'Без повода');
        await t.telegram(OWNER, '30.12', 'Александра 👑✨');
        await click(OWNER, 'Я участвую');
        await click(OWNER, 'Да, так');
        await click(OWNER, 'Без пожелания');
        const card = findSent(OWNER, 'Игра создана');
        const { code, roomId } = { code: codeOf(card), roomId: roomIdOf(card) };
        expect(card.text).toContain('Бюджет: до 1500 ₽');
        expect(card.text).toContain('Обмен: 30 декабря');

        await joinGift(ROMANTIC, code, 'Кристина Орлова', 'книга фэнтези');
        await joinGift(ANYA, code, 'Борис Улыбкин', 'носки тёплые');

        await drawGift(roomId);
        // Результат у каждого, уже без Санты
        for (const id of [OWNER, ROMANTIC, ANYA]) {
            const result = findSent(id, 'вы — тайный даритель. Ваш подопечный:');
            expect(result.buttons.map((b) => b.title)).toEqual([
                'Кому я дарю?',
                'Анонимный вопрос подопечному',
            ]);
        }
        // Ни 🎅, ни 🎄, ни «Тайный Санта» во всех сообщениях gift
        expect(t.sent.slice(from).filter((m) => /Санта|🎅|🎄/.test(m.text))).toEqual([]);

        // Анонимный вопрос подопечному
        const participants = await t.app.service.store.participantsOf(roomId);
        const ownerPart = participants.find((p) => p.userId === String(OWNER))!;
        const recipient = participants.find((p) => p.id === ownerPart.recipientId)!;
        const recipientChat = Number(recipient.userId);
        await t.telegramPress(
            OWNER,
            payloadOf(
                findSent(OWNER, 'вы — тайный даритель. Ваш подопечный:'),
                'Анонимный вопрос подопечному',
            ),
        );
        await t.telegram(OWNER, 'Какие книги любишь читать?', 'Александра 👑✨');
        expect(last(OWNER).text).toBe('Сообщение отправлено.');
        await idle();
        const question = findSent(recipientChat, 'Анонимное сообщение');
        expect(question.text).toContain('Какие книги любишь читать?');
        expect(question.buttons.map((b) => b.title)).toEqual([
            'Ответить анонимно',
            'Пожаловаться',
            'Заблокировать',
            'К игре',
        ]);

        // Подопечный меняет пожелание ПОСЛЕ жеребёвки — Санта получает обновление
        await t.telegramPress(recipientChat, { action: A.room, r: roomId });
        await click(recipientChat, 'Изменить пожелание');
        await t.telegram(recipientChat, 'Лучше книгу детективную', 'Александра 👑✨');
        expect(last(recipientChat).text).toContain('тайный даритель получит обновление');
        await idle();
        const santaOfRecipient = participants.find((p) => p.recipientId === recipient.id)!;
        const update = findSent(Number(santaOfRecipient.userId), 'пожелание');
        expect(update.text).toContain('изменилось');
        expect(update.text).toContain('Новое пожелание: Лучше книгу детективную');

        // Отметки «подарил» и «получил»
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Я подарил подарок');
        expect(last(OWNER).text).toContain('Отмечено: вы подарили подарок');
        expect(last(OWNER).text).toContain('Обмен: 30 декабря');
        await click(OWNER, 'Я получил подарок');
        expect(last(OWNER).text).toContain('Поздравляем! Отмечено: подарок получен.');

        // Сводка организатора до завершения: отметки есть, пар нет
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Состояние подарков');
        const summary = last(OWNER);
        expect(summary.text).toContain('подарил — да');
        expect(summary.text).toContain('получил — да');
        expect(summary.text).not.toContain('→');

        // Завершение: раскрываются пары
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Завершить игру');
        expect(last(OWNER).text).toContain('Игра завершена');
        await click(OWNER, 'Кто кому дарит');
        expect(last(OWNER).text).toContain('→');
        expect(last(OWNER).text).toContain('подарок ✓');
    });

    it('H: «Сыграть ещё раз» — новая комната без старой даты, бюджет переезжает', async () => {
        const { code, roomId } = await createGift({});
        await joinGift(ROMANTIC, code, 'Кристина Орлова', 'книга');
        await joinGift(ANYA, code, 'Борис Улыбкин');
        await drawGift(roomId);
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Завершить игру');

        await click(OWNER, 'Сыграть ещё раз');
        // Клон отвечает своим заголовком с объяснением, что перенеслось
        const newCard = findSent(OWNER, 'Новая игра готова');
        expect(newCard.text).toContain('Дата обмена сброшена');
        const newRoomId = roomIdOf(newCard);
        const newCode = codeOf(newCard);
        // Новая комната: пустая, открытая, с новым кодом
        expect(newCode).not.toBe(code);
        expect(
            (await t.app.service.store.participantsOf(newRoomId)).filter((p) => p.userId),
        ).toEqual([]);
        expect((await t.app.service.store.findRoom(newRoomId))!.status).toBe('open');
        expect(newCard.text).toContain('Идёт набор участников');

        // Дата обмена НЕ переезжает из старой игры: организатор задаёт новую сам
        expect((await t.app.service.store.findRoom(newRoomId))!.settings.eventDate).toBeUndefined();
        expect(newCard.text).not.toContain('Обмен:');
        // Бюджет при этом переехал
        expect(newCard.text).toContain('Бюджет: до 1500 ₽');
    });

    it('I: «удалить мои данные» после жеребёвки — уведомления, комната жива, блокировка тиха', async () => {
        const { code, roomId } = await createGift({});
        await joinGift(ROMANTIC, code, 'Кристина Орлова', 'книга');
        await joinGift(ANYA, code, 'Борис Улыбкин', 'носки');
        await joinGift(BORETS, code, 'Вера Ясная', 'сертификат');
        await drawGift(roomId);

        const participants = await t.app.service.store.participantsOf(roomId);
        const gone = participants.find((p) => p.userId === String(ROMANTIC))!;
        const giverOfGone = participants.find((p) => p.recipientId === gone.id)!;
        const orphan = participants.find((p) => p.id === gone.recipientId)!;

        // Кристина удаляет данные
        await t.telegram(ROMANTIC, 'удалить мои данные', 'Кристина Орлова');
        await click(ROMANTIC, 'Да, удалить всё');
        expect(last(ROMANTIC).text).toContain('Данных о вас у бота больше нет');
        await idle();

        // Дарителю Кристины и её подопечному — уведомления, Кристине — ничего
        expect(last(Number(giverOfGone.userId)).text).toContain(
            'ваш подопечный Кристина Орлова больше не участвует',
        );
        expect(last(Number(orphan.userId)).text).toContain(
            'ваш тайный даритель больше не участвует',
        );
        expect(
            t.sent.filter(
                (m) => m.chatId === String(ROMANTIC) && m.text.includes('больше не участвует'),
            ),
        ).toEqual([]);

        // Комната работает дальше: сводка без Кристины, вопрос и отметки живут
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        await click(OWNER, 'Состояние подарков');
        const summary = last(OWNER);
        expect(summary.text).toContain('Борис Улыбкин');
        expect(summary.text).toContain('Вера Ясная');
        expect(summary.text).not.toContain('Кристина');
        const ownerPart = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.userId === String(OWNER),
        )!;
        const ownerRecipient = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.id === ownerPart.recipientId,
        )!;
        if (ownerRecipient.userId) {
            await t.telegramPress(OWNER, { action: A.write, r: roomId });
            await t.telegram(OWNER, 'Уточнение по подарку?', 'Александра 👑✨');
            expect(last(OWNER).text).toBe('Сообщение отправлено.');
            await idle();
            expect(
                findSent(Number(ownerRecipient.userId), 'Уточнение по подарку?').text,
            ).toBeDefined();

            // Получатель блокирует организатора-дарителя — следующий вопрос уходит «в пустоту»,
            // но бот говорит «Сообщение отправлено.»
            const questionMsg = findSent(Number(ownerRecipient.userId), 'Уточнение по подарку?');
            await t.telegramPress(
                Number(ownerRecipient.userId),
                payloadOf(questionMsg, 'Заблокировать'),
            );
            expect(last(Number(ownerRecipient.userId)).text).toBe(
                'Автор больше не сможет вам писать. Сам он об этом не узнает.',
            );
            const before = t.sent.filter(
                (m) =>
                    m.chatId === String(Number(ownerRecipient.userId)) &&
                    m.text.includes('Анонимное'),
            ).length;
            await t.telegramPress(OWNER, { action: A.write, r: roomId });
            await t.telegram(OWNER, 'Второй вопрос в пустоту', 'Александра 👑✨');
            expect(last(OWNER).text).toBe('Сообщение отправлено.');
            await idle();
            const after = t.sent.filter(
                (m) =>
                    m.chatId === String(Number(ownerRecipient.userId)) &&
                    m.text.includes('Анонимное'),
            ).length;
            expect(after).toBe(before); // тихо выброшено
            // Но «Я подарил подарок» у дарителя работает
            await t.telegramPress(OWNER, { action: A.room, r: roomId });
            await click(OWNER, 'Я подарил подарок');
            expect(last(OWNER).text).toContain('Отмечено: вы подарили подарок');
        }

        // Список участников: вместо Кристины — «участник выбыл»
        await t.telegramPress(OWNER, { action: A.members, r: roomId });
        expect(last(OWNER).text).toContain('участник выбыл (Telegram)');
    });
});

describe('Креативные крайности: имена, кнопки, эмодзи', () => {
    beforeEach(async () => {
        t = new TestBot({}, MODES);
        t.now = new Date('2027-01-25T12:00:00Z');
        // Первый запрос инициализирует таблицы БД — без него service.createRoom падает
        await t.telegram(OWNER, 'меню', 'Александра 👑✨');
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    /** Комната валентинок с заданными именами (создание через сервис, чтобы задать любые имена). */
    async function roomWithNames(names: readonly [number, string][]): Promise<string> {
        const created = await t.app.service.createRoom(
            { platform: 'telegram', userId: String(OWNER) },
            ValentineMode,
            'Тест имён',
            { timezone: 'Europe/Moscow', eventAt: '2027-02-14T18:00' },
        );
        await t.app.service.join(
            { platform: 'telegram', userId: String(OWNER) },
            created.id,
            'Александра 👑✨',
            {},
        );
        for (const [id, name] of names) {
            await t.app.service.join(
                { platform: 'telegram', userId: String(id) },
                created.id,
                name,
                {},
            );
        }
        return created.id;
    }

    it('Две участницы с одинаковым именем: кнопки неразличимы, голосом не выбрать, по кнопке — точно в цель', async () => {
        const roomId = await roomWithNames([
            [ROMANTIC, 'Кристина Орлова'],
            [ANYA, 'Кристина Орлова'],
        ]);
        await t.telegramPress(OWNER, { action: A.write, r: roomId });
        const list = last(OWNER);
        const twins = list.buttons.filter((b) => b.title === 'Кристина Орлова');
        expect(twins).toHaveLength(2);
        expect(twins[0]!.payload!.x).not.toBe(twins[1]!.payload!.x);

        // Голосом/текстом имя не выбрать: две одинаковые кнопки — бот не понял
        await t.telegram(OWNER, 'кристина орлова', 'Александра 👑✨');
        expect(last(OWNER).text).toBe('Не понял. Пришлите код игры или выберите действие.');

        // Но нажатие по payload второй кнопки доставляет именно второй Кристине
        await t.telegramPress(OWNER, twins[1]!.payload!);
        await t.telegram(OWNER, 'Привет второй Кристине', 'Александра 👑✨');
        t.now = DEADLINE;
        await idle();
        expect((await t.app.scheduler.tick()).messages).toBe(1);
        expect(findSent(ANYA, 'Привет второй Кристине').text).toBeDefined();
        expect(
            t.sent.filter(
                (m) => m.chatId === String(ROMANTIC) && m.text.includes('второй Кристине'),
            ),
        ).toEqual([]);
    });

    it('Похожие длинные имена: кнопки «Исключить» обрезаны до неразличимости, но payload верный', async () => {
        const roomId = await roomWithNames([
            [ROMANTIC, 'Александра Великолепная Звезда Сцены'],
            [ANYA, 'Александра Великолепная Звезда Экрана'],
        ]);
        await t.telegramPress(OWNER, { action: A.members, r: roomId });
        const members = last(OWNER);
        const kicks = members.buttons.filter((b) =>
            b.title.startsWith('Исключить: Александра Великолепная'),
        );
        expect(kicks).toHaveLength(2);
        // Обе кнопки обрезаны до 40 символов и стали одинаковыми
        expect(kicks[0]!.title).toBe(kicks[1]!.title);
        expect(kicks[0]!.title).toHaveLength(40);
        expect(kicks[0]!.title.endsWith('…')).toBe(true);
        // Но payload различает: исключаем «Экрана»
        await t.telegramPress(OWNER, kicks[1]!.payload!);
        expect(last(OWNER).text).toContain(
            'Александра Великолепная Звезда Экрана (Telegram) больше не участвует',
        );
    });

    it('Эмодзи на границе 40 символов не рвётся пополам в кнопке', async () => {
        const name = 'Ю'.repeat(27) + '💜💜';
        const roomId = await roomWithNames([[ROMANTIC, name]]);
        await t.telegramPress(OWNER, { action: A.members, r: roomId });
        const button = last(OWNER).buttons.find((b) => b.title.startsWith('Исключить: Ю'))!;
        // Режется по кодпойнтам: 39 кодпойнтов + «…», эмодзи цел
        expect([...button.title]).toHaveLength(40);
        expect(button.title).toBe(`Исключить: ${'Ю'.repeat(27)}💜…`);
        // Логика при этом не сломана: по payload участница исключается
        await t.telegramPress(OWNER, button.payload!);
        expect(last(OWNER).text).toContain(`${name} (Telegram) больше не участвует`);
    });

    it('Имя из 100 символов: отказ, лимит 40 нигде не назван заранее', async () => {
        const { code } = await createValentines();
        await t.telegram(BORETS, code, 'Новичок');
        await click(BORETS, 'Участвую');
        // Сам вопрос про имя ничего не говорит о лимите
        const prompt = last(BORETS).text;
        expect(prompt).toContain('Оставить так или напишете другое имя');
        expect(prompt).not.toContain('символ');
        await t.telegram(BORETS, 'Ю'.repeat(100), 'Новичок');
        expect(last(BORETS).text).toContain('Слишком длинно: не больше 40 символов');
        await t.telegram(BORETS, 'Короткое Имя', 'Новичок');
        expect(last(BORETS).text).toContain('Вы в игре');
    });

    it('Код с эмодзи вокруг: мусор вычищается, ищется настоящий код', async () => {
        await t.telegram(BORETS, '💚K7M2QX', 'Новичок');
        // Код выделяется из мусора, но игры с таким кодом нет
        expect(last(BORETS).text).toContain('Игра с таким кодом не найдена');
    });

    it('Регрессия: «💚КОД» входит в настоящую игру', async () => {
        const created = await t.app.service.createRoom(
            { platform: 'telegram', userId: String(OWNER) },
            ValentineMode,
            'Код с эмодзи',
            { timezone: 'Europe/Moscow', eventAt: '2027-02-14T18:00' },
        );
        await t.telegram(BORETS, `💚${created.code}`, 'Новичок');
        expect(last(BORETS).text).toContain('Участвуете?');
        await click(BORETS, 'Участвую');
        await t.telegram(BORETS, 'Новичок', 'Новичок');
        expect(last(BORETS).text).toContain('Вы в игре');
    });
});
