import { A, IPayload } from '../src/ui';
import { codeOf, ISentMessage, roomIdOf, TestBot } from './helpers';
import { GiftMode } from '../src/modes/gift/GiftMode';
import { MeetingMode } from '../src/modes/meeting/MeetingMode';
import { MODES } from '../src/modes/registry';
import { SantaMode } from '../src/modes/santa/SantaMode';
import { ValentineMode } from '../src/modes/valentines/ValentineMode';

/**
 * QA-обзор кроссплатформенного опыта: Telegram + VK + MAX + Алиса в одной комнате,
 * «злой пользователь», долговечность комнат, мусор в анкетах, параллельные игры.
 * Каждый сценарий — воспроизведённый тест: утверждения отражают фактическое поведение.
 */

const OWNER = 1001; // Telegram-организатор
const VK_REF = 2002; // VK-участник по ссылке
const MAX_USER = 3001; // MAX-участник

type TButton = { title: string; payload: IPayload | null };

function press(message: { buttons: TButton[] }, title: string): IPayload {
    const button = message.buttons.find((b) => b.title.startsWith(title))?.payload;
    if (!button) {
        throw new Error(`Нет кнопки «${title}»: ${message.buttons.map((b) => b.title).join(', ')}`);
    }
    return button;
}

const alisaUser = (id: string): { platform: string; userId: string } => ({
    platform: 'alisa',
    userId: id,
});

describe('A+B. Семья на четырёх платформах и ссылки-приглашения', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot({
            links: {
                telegram: 'rooms_test_bot',
                vk: 'rooms_test',
                max: 'rooms_test_bot',
                alisa: 'ТайныйСанта',
            },
        });
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('организатор в Telegram, участники из VK, MAX и Алисы: полный цикл Санты', async () => {
        // Организатор в Telegram создаёт игру
        await t.telegram(OWNER, '/start', 'Папа');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Создать игру'));
        await t.telegram(OWNER, 'Семья 2026', 'Папа');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Без бюджета'));
        // Кнопка-пресет даты работает: значение принимается как ответ
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), '27 декабря'));
        expect(t.lastTo(OWNER).text).toContain('Вы участвуете в игре сами');
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Я участвую'));
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Да, так'));
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Без пожелания'));
        const card = t.sent[t.sent.length - 2] as ISentMessage;
        const invite = t.lastTo(OWNER);

        // B. Ссылки-приглашения во все платформы в одном тексте
        const code = /Код: (\w{6})/.exec(card.text)?.[1] as string;
        expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
        expect(invite.text).toContain(`https://t.me/rooms_test_bot?start=${code}`);
        expect(invite.text).toContain(`https://vk.me/rooms_test?ref=${code}`);
        expect(invite.text).toContain(`https://max.ru/rooms_test_bot?start=${code}`);
        expect(invite.text).toContain('Алиса, запусти навык');

        const roomId = press(card, 'Участники').r as string;

        // VK: вход по ссылке ?ref=, имя из профиля
        await t.vk(VK_REF, '', undefined, code);
        const vkPreview = t.lastTo(VK_REF);
        expect(vkPreview.text).toContain('Участвуете?');
        await t.vkClick(VK_REF, vkPreview, 'Участвую');
        expect(t.lastTo(VK_REF).text).toContain('«Вика Веткина»');
        await t.vkClick(VK_REF, t.lastTo(VK_REF), 'Да, так');
        await t.vk(VK_REF, 'пропустить');
        expect(t.lastTo(VK_REF).text).toContain('Вы в игре');

        // MAX: вход по ссылке ?start=, имя из payload события start
        await t.maxStart(MAX_USER, code);
        await t.maxPress(MAX_USER, press(t.lastTo(MAX_USER), 'Участвую'));
        expect(t.lastTo(MAX_USER).text).toContain('«Маша»');
        await t.maxPress(MAX_USER, press(t.lastTo(MAX_USER), 'Да, так'));
        await t.max(MAX_USER, 'пропустить');
        expect(t.lastTo(MAX_USER).text).toContain('Вы в игре');

        // Алиса: вход по коду
        await t.join('alisa-anya', code, 'конструктор');

        // Жеребьёвка из Telegram
        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'draw' });
        await t.telegramPress(OWNER, press(t.lastTo(OWNER), 'Да, провести'));
        expect(t.lastTo(OWNER).text).toContain('рассылаю');
        await t.app.notifier.whenIdle();

        // Пуши с результатом фиксируем сразу: дальше приходят отчёты и чужие вопросы
        const vkResult = t.lastTo(VK_REF);
        const maxResult = t.lastTo(MAX_USER);

        // «Кому я дарю?» с каждой платформы: одинаковый формат без платформенных огрызков
        await t.vkClick(VK_REF, vkResult, 'Кому я дарю?');
        const vkWhom = t.lastTo(VK_REF).text;
        await t.maxPress(MAX_USER, press(maxResult, 'Кому я дарю?'));
        const maxWhom = t.lastTo(MAX_USER).text;
        // Организатору результат пришёл пушем, но последним сообщением уже отчёт
        // о доставке — действие выполняем payload-кнопкой из его результата
        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'whom' });
        const tgWhom = t.lastTo(OWNER).text;
        const alisaWhom = (await t.act('alisa-anya', roomId, 'whom')).text;
        for (const text of [vkWhom, maxWhom, tgWhom, alisaWhom]) {
            expect(text).toMatch(/вы — Тайный Санта\. Ваш подопечный: .+\./);
            expect(text).toMatch(/Пожелание: (конструктор|не указано)/);
        }
        expect(vkWhom).not.toContain('Алиса');
        expect(maxWhom).not.toContain('Алиса');
        expect(tgWhom).not.toContain('Алиса');

        // Анонимный вопрос отправляется с каждой платформы
        await t.telegramPress(OWNER, { action: A.write, r: roomId });
        await t.telegram(OWNER, 'Кофе или чай?', 'Папа');
        expect(t.lastTo(OWNER).text).toContain('Сообщение отправлено');
        await t.vkClick(VK_REF, vkResult, 'Анонимный вопрос подопечному');
        await t.vk(VK_REF, 'Настолки любите?');
        expect(t.lastTo(VK_REF).text).toContain('Сообщение отправлено');
        await t.maxPress(MAX_USER, press(maxResult, 'Анонимный вопрос подопечному'));
        await t.max(MAX_USER, 'Книги какие любите?');
        expect(t.lastTo(MAX_USER).text).toContain('Сообщение отправлено');
        await t.alisaPress('alisa-anya', { action: A.write, r: roomId });
        await t.alisa('alisa-anya', 'Сюрприз или деньги?');

        // Ответы приходят всем; получатель Алисы читает во «Входящих сообщениях» карточки
        await t.app.notifier.whenIdle();
        for (const [user, answer, name] of [
            [OWNER, 'Кофе, чёрный', 'Папа'],
            [VK_REF, 'Настолки — да', 'Вика'],
            [MAX_USER, 'Классику', 'Маша'],
        ] as const) {
            const push = t.lastTo(user);
            if (!push.text.includes('Анонимное сообщение')) {
                // этого участника спрашивает пользователь Алисы: пуша нет и не будет
                continue;
            }
            if (user === VK_REF) {
                await t.vkClick(VK_REF, push, 'Ответить анонимно');
                await t.vk(VK_REF, answer);
            } else if (user === MAX_USER) {
                await t.maxPress(MAX_USER, press(push, 'Ответить анонимно'));
                await t.max(MAX_USER, answer);
            } else {
                await t.telegramPress(user, press(push, 'Ответить анонимно'));
                await t.telegram(user, answer, name);
            }
            expect(t.lastTo(user).text).toContain('Сообщение отправлено');
        }
        const alisaCard = await t.alisaClick(
            'alisa-anya',
            await t.alisa('alisa-anya', 'мои игры'),
            'Семья 2026',
        );
        const inbox = await t.alisaClick('alisa-anya', alisaCard, 'Входящие сообщения');
        expect(inbox.text).toContain('Ваши входящие анонимные сообщения');
        await t.alisaClick('alisa-anya', inbox, 'Ответить анонимно');
        await t.alisa('alisa-anya', 'Сюрприз!');
        await t.app.notifier.whenIdle();

        // Отметки «подарил/получил» с каждой платформы
        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'given' });
        expect(t.lastTo(OWNER).text).toContain('вы подарили подарок');
        await t.vk(VK_REF, '', { action: A.act, r: roomId, m: 'given' });
        expect(t.lastTo(VK_REF).text).toContain('вы подарили подарок');
        await t.maxPress(MAX_USER, { action: A.act, r: roomId, m: 'received' });
        expect(t.lastTo(MAX_USER).text).toContain('подарок получен');
        await t.act('alisa-anya', roomId, 'received');
        expect((await t.act('alisa-anya', roomId, 'given')).text).toContain('вы подарили подарок');

        // Организаторский отчёт: сводка и честный статус доставки
        await t.telegramPress(OWNER, { action: A.act, r: roomId, m: 'handover' });
        const handover = t.lastTo(OWNER).text;
        expect(handover).toContain('Кто кому дарит');
        expect(handover).toContain('подарок ✓');
        await t.telegramPress(OWNER, { action: A.room, r: roomId });
        const summary = t.lastTo(OWNER).text;
        expect(summary).toContain('Результаты отправлены: 3 из 4');
        // Про Алису — объяснение, а не голое «не доставлено»
        expect(summary).toContain('в карточке игры');
    });
});

describe('C. Злой пользователь', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('код: регистр, дефис, похожие символы, чужой код при своей игре', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const hacker = 9001;

        // Регистронезависимость и дефис
        await t.telegram(hacker, code.toLowerCase(), 'Хакер');
        expect(t.lastTo(hacker).text).toContain('Участвуете?');
        await t.telegram(hacker, `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase(), 'Хакер');
        expect(t.lastTo(hacker).text).toContain('Участвуете?');

        // Похожие символы: 0, 1, I, L, O — подсказка, а не «не найдена»
        await t.telegram(hacker, '0O1LI0', 'Хакер');
        expect(t.lastTo(hacker).text).toContain('нет цифр 0 и 1');

        // Игрок своей комнаты получил код чужой: предупреждение на превью
        await t.join('player', code);
        const other = await t.createGame('owner2', false, 'Другая');
        const preview = await t.alisa('player', codeOf(other).toLowerCase());
        expect(preview.text).toContain('вы уже участвуете в игре');
        expect(preview.text).toContain('Другая');
    });

    it('выдуманные payload-кнопки отклоняются вежливо и по делу', async () => {
        const created = await t.createGame('owner', true);
        const code = codeOf(created);
        const roomId = roomIdOf(created);
        await t.join('player', code);
        const otherRoomId = roomIdOf(await t.createGame('owner2', false, 'Другая'));

        // Не участник
        expect((await t.act('stranger', roomId, 'whom')).text).toContain('Вы не участвуете');
        // Участник другой комнаты чужим roomId
        expect(
            (await t.alisaPress('player', { action: A.act, r: otherRoomId, m: 'whom' })).text,
        ).toContain('Вы не участвуете');
        // Скрытая кнопка организатора у участника
        expect((await t.act('player', roomId, 'draw', undefined, true)).text).toContain(
            'только организатор',
        );
        expect((await t.alisaPress('player', { action: A.members, r: roomId })).text).toContain(
            'только организатор',
        );
        // handover в открытой комнате не существует ни у кого
        expect((await t.act('player', roomId, 'handover')).text).toContain('недоступно');
        // Действие, которое ещё не показывалось
        expect((await t.act('player', roomId, 'whom')).text).toContain('недоступно');
        // Анонимная переписка не участником
        expect((await t.alisaPress('stranger', { action: A.write, r: roomId })).text).toContain(
            'Вы не участвуете',
        );

        // Жеребьёвка, чтобы появились анонимные сообщения
        await t.join('extra', code);
        await t.act('owner', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();

        // player и owner пишут подопечным (единственная цель — кнопка без x)
        await t.alisaPress('player', { action: A.write, r: roomId });
        await t.alisa('player', 'Привет!');
        await t.alisa('player', 'меню');
        await t.alisaPress('owner', { action: A.write, r: roomId });
        await t.alisa('owner', 'Как обмен идёт?');
        await t.alisa('owner', 'меню');
        const relays = await t.app.service.store.relaysOf(roomId);
        const mine = relays.find((r) => r.text === 'Привет!') as { id: string };
        const other = relays.find((r) => r.text === 'Как обмен идёт?') as {
            id: string;
            fromId: string;
            toId: string;
        };

        // Заблокировать и пожаловаться на своё сообщение нельзя
        expect((await t.alisaPress('player', { action: A.block, x: mine.id })).text).toContain(
            'адресовано не вам',
        );
        expect((await t.alisaPress('player', { action: A.report, x: mine.id })).text).toContain(
            'адресовано не вам',
        );
        // Чужое сообщение: участник, который ни автор, ни адресат
        const tester = (await t.app.service.store.participantsOf(roomId)).find(
            (p) => p.userId && p.id !== other.fromId && p.id !== other.toId,
        ) as { userId: string };
        expect(
            (await t.alisaPress(tester.userId, { action: A.block, x: other.id })).text,
        ).toContain('адресовано не вам');
        // Выдуманный id сообщения
        expect((await t.alisaPress('stranger', { action: A.block, x: 'nope' })).text).toContain(
            'Сообщение не найдено',
        );

        // Анонимный вопрос «мимо» подопечного: единственная цель подставляется тихо
        const wrongTarget = await t.alisaPress('extra', {
            action: A.write,
            r: roomId,
            x: 'fake-participant',
        });
        expect(wrongTarget.text).toContain('Напишите сообщение');
        await t.alisa('extra', 'меню');

        // Подбор кодов ограничен: одиннадцатая неверная попытка — бан
        for (const last of '23456789AB') {
            expect((await t.alisa('guard', `AAAAA${last}`)).text).toContain('не найдена');
        }
        expect((await t.alisa('guard', 'KKKKKK')).text).toContain('Слишком много неверных кодов');
    });
});

describe('D. Многоигрок-одиночка', () => {
    let t: TestBot;
    const loner = alisaUser('loner');

    beforeEach(() => {
        t = new TestBot({}, MODES);
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('5 игр в 5 режимах: все видны в «Моих играх», удаление данных чистит всё', async () => {
        // Дни рождения — целиком кнопками из карточки
        const menu = await t.alisa('loner', 'меню');
        const chooser = await t.alisaClick('loner', menu, 'Создать игру');
        expect(chooser.buttons.map((b) => b.title)).toContain('Дни рождения команды');
        await t.alisaClick('loner', chooser, 'Дни рождения команды');
        const title = await t.alisa('loner', 'Команда ЛНУ');
        const tz = await t.alisaClick('loner', title, 'Москва');
        const role = await t.alisaClick('loner', tz, 'Я участвую');
        expect(role.text).toContain('Как вас подписать');
        await t.alisa('loner', 'Лена');
        const birthdayCard = await t.alisa('loner', '14 марта');
        // Создатель участвует: карточка «Игра создана» с его анкетой
        expect(birthdayCard.text).toContain('Игра создана');
        expect(birthdayCard.text).toContain('Вы: Лена. День рождения: 14 марта');

        // Остальные режимы — через сервис (как в holiday-modes.test.ts)
        await t.app.service.createRoom(loner, ValentineMode, 'Валентинки', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-02-14T10:00',
        });
        await t.app.service.createRoom(loner, MeetingMode, 'Встреча', {
            timezone: 'Europe/Moscow',
            eventAt: '2026-12-01T19:00',
            place: 'Кафе',
            contribution: '500',
        });
        await t.app.service.createRoom(loner, GiftMode, 'Подарки', { eventDate: '2027-03-01' });
        // Пятая игра — Тайный Санта другого организатора, loner participates
        const santa = await t.app.service.createRoom(alisaUser('друг'), SantaMode, 'Ёлка', {
            eventDate: '2026-12-27',
        });
        await t.app.service.join(loner, santa.id, 'Лена', { wish: 'носки' });

        const mine = await t.alisa('loner', 'мои игры');
        const titles = mine.buttons.map((b) => b.title);
        for (const roomName of ['Команда ЛНУ', 'Валентинки', 'Встреча', 'Подарки', 'Ёлка']) {
            expect(titles.some((title2) => title2.startsWith(roomName))).toBe(true);
        }
        expect(titles.find((title2) => title2.startsWith('Ёлка'))).not.toContain('организатор');

        // Два одинаковых названия: кнопки неотличимы
        await t.app.service.createRoom(loner, SantaMode, 'Тест', { eventDate: '2026-12-27' });
        await t.app.service.createRoom(loner, SantaMode, 'Тест', { eventDate: '2026-12-27' });
        const again = await t.alisa('loner', 'мои игры');
        const dupTitles = again.buttons
            .map((b) => b.title)
            .filter((title2) => title2.startsWith('Тест'));
        expect(dupTitles).toHaveLength(2);
        expect(dupTitles[0]).toBe(dupTitles[1]);

        // Удаление данных: отчёт и чистые «Мои игры»
        const ask = await t.alisa('loner', 'удалить мои данные');
        const done = await t.alisaClick('loner', ask, 'Да, удалить всё');
        expect(done.text).toContain('Удалено игр: 6');
        expect(done.text).toContain('покинуто игр: 1');
        expect((await t.alisa('loner', 'мои игры')).text).toContain('пока нет игр');
        const santaAfter = await t.app.service.store.participantsOf(santa.id);
        expect(santaAfter.some((p) => p.userId === 'loner')).toBe(false);
        expect(await t.app.service.store.findRoom(santa.id)).not.toBeNull();
    });

    it('«Мои игры» показывает последние 8 из всех игр, без пагинации', async () => {
        await t.alisa('crowd', 'меню'); // инициализация таблиц БД
        for (let i = 0; i < 10; i++) {
            await t.app.service.createRoom(alisaUser('crowd'), SantaMode, `Игра ${i}`, {
                eventDate: '2026-12-27',
            });
        }
        const mine = await t.alisa('crowd', 'мои игры');
        const titles = mine.buttons.map((b) => b.title).filter((title) => title !== 'Меню');
        expect(titles).toHaveLength(8);
        expect(titles.some((title) => title.startsWith('Игра 8'))).toBe(false);
        expect(titles.some((title) => title.startsWith('Игра 9'))).toBe(false);
        expect(mine.buttons.some((b) => b.title.startsWith('Далее'))).toBe(false);
        // Игры за лимитом не пропадают молча: в заголовке честный счётчик
        expect(mine.text).toContain('Ваши игры: (последние 8 из 10)');
    });
});

describe('E. Долгожитель: cleanup после 31 и 91 дня', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('комната с датой обмена удаляется через 30 дней после события', async () => {
        const created = await t.createGame('owner', false);
        const roomId = roomIdOf(created);
        await t.join('anya', codeOf(created));
        const room = await t.app.service.store.findRoom(roomId);
        const eventEnd = Date.parse(`${room?.settings.eventDate}T23:59:59Z`);
        t.now = new Date(eventEnd + 31 * 24 * 60 * 60 * 1000);
        expect(await t.app.service.cleanupExpired()).toBe(1);

        // Старые кнопки из чата отвечают понятным текстом
        const staleCard = await t.alisaPress('anya', { action: A.room, r: roomId });
        expect(staleCard.text).toContain('Игра не найдена');
        expect(staleCard.text).toContain('срок хранения истёк');
        const staleAction = await t.alisaPress('anya', { action: A.act, r: roomId, m: 'whom' });
        expect(staleAction.text).toContain('Игра не найдена');
        // «Мои игры» и меню без битых кнопок
        expect((await t.alisa('anya', 'мои игры')).text).toContain('пока нет игр');
        const menu = await t.alisa('anya', 'меню');
        expect(menu.buttons.some((b) => b.title.startsWith('Текущая игра'))).toBe(false);
        expect((await t.alisa('owner', 'мои игры')).text).toContain('пока нет игр');
    });

    it('комната без даты обмена удаляется через 90 дней после создания', async () => {
        await t.alisa('owner2', 'меню'); // инициализация таблиц БД
        const createdAt = new Date();
        const room = await t.app.service.createRoom(alisaUser('owner2'), SantaMode, 'Без даты', {});
        t.now = new Date(createdAt.getTime() + 91 * 24 * 60 * 60 * 1000);
        expect(await t.app.service.cleanupExpired()).toBe(1);
        expect((await t.alisa('owner2', 'мои игры')).text).toContain('пока нет игр');
        const stale = await t.alisaPress('owner2', { action: A.room, r: room.id });
        expect(stale.text).toContain('Игра не найдена');
    });
});

describe('F. Мусор в анкетах', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('пустые, переносы, слишком длинные — вежливый повтор вопроса; эмодзи проходят', async () => {
        await t.alisa('u1', 'создать');
        expect((await t.alisa('u1', '   ')).text).toContain('от 1 до 60 символов');
        expect((await t.alisa('u1', '\n')).text).toContain('от 1 до 60 символов');
        expect((await t.alisa('u1', 'x'.repeat(200))).text).toContain(
            'Слишком длинно: не больше 60 символов',
        );
        await t.alisa('u1', '...'); // валидное, хоть и бессмысленное название
        await t.alisa('u1', 'пропустить');
        const date = await t.alisa('u1', '27 декабря');
        await t.alisaClick('u1', date, 'Я участвую');
        await t.alisa('u1', '🎮');
        const created = await t.alisa('u1', 'пропустить');
        const code = codeOf(created);
        const preview = await t.alisa('u2', code.toLowerCase());
        await t.alisaClick('u2', preview, 'Участвую');
        expect((await t.alisa('u2', '   ')).text).toContain('от 1 до 40 символов');
        expect((await t.alisa('u2', '\n')).text).toContain('от 1 до 40 символов');
        expect((await t.alisa('u2', 'А'.repeat(41))).text).toContain(
            'Слишком длинно: не больше 40 символов',
        );
        const emojiName = await t.alisa('u2', '🎮🎄💫');
        expect(emojiName.text).toContain('Напишите пожелание');
        expect((await t.alisa('u2', 'ж'.repeat(301))).text).toContain('не больше 300');
        expect((await t.alisa('u2', 'ж'.repeat(5000))).text).toContain('не больше 300');
        const joined = await t.alisa('u2', '<b>жирный</b> и *звёздочки*');
        expect(joined.text).toContain('Вы в игре');
        expect(joined.text).toContain('Пожелание: <b>жирный</b> и *звёздочки*');
        await t.join('u3', code);
        await t.act('u1', roomIdOf(created), 'draw', undefined, true);
        await t.app.notifier.whenIdle();
    });

    it('HTML и markdown в пожеланиях и анонимных сообщениях не ломают отправку', async () => {
        // Комната из одних Telegram-участников: теги видны в outgoing-сообщениях как есть
        await t.telegram(7001, '/start', 'Тэг');
        await t.telegramPress(7001, press(t.lastTo(7001), 'Создать игру'));
        await t.telegram(7001, 'Теги', 'Тэг');
        await t.telegramPress(7001, press(t.lastTo(7001), 'Без бюджета'));
        await t.telegram(7001, '27 декабря', 'Тэг');
        await t.telegramPress(7001, press(t.lastTo(7001), 'Я участвую'));
        await t.telegramPress(7001, press(t.lastTo(7001), 'Да, так'));
        await t.telegram(7001, '<b>жирный</b> & *наклон*', 'Тэг');
        const card = t.sent[t.sent.length - 2] as ISentMessage;
        const code = /Код: (\w{6})/.exec(card.text)?.[1] as string;
        const roomId = press(card, 'Участники').r as string;
        for (const id of [7002, 7003]) {
            await t.telegram(id, code, 'Гость');
            await t.telegramPress(id, press(t.lastTo(id), 'Участвую'));
            await t.telegramPress(id, press(t.lastTo(id), 'Да, так'));
            await t.telegram(id, 'ок', 'Гость');
        }
        await t.telegramPress(7001, { action: A.actOk, r: roomId, m: 'draw' });
        await t.app.notifier.whenIdle();

        // Пожелание с тегами ушло Санте как обычный текст
        const withTags = t.sent.find((m) => m.text.includes('<b>жирный</b>'));
        expect(withTags).toBeDefined();

        // Анонимное сообщение с HTML и markdown доходит буквально
        const participants = await t.app.service.store.participantsOf(roomId);
        const htmlP = participants.find((p) => p.name === 'Тэг');
        const giver = participants.find((p) => p.recipientId === htmlP?.id);
        const giverId = Number(giver?.userId);
        await t.telegramPress(giverId, press(t.lastTo(giverId), 'Анонимный вопрос подопечному'));
        await t.telegram(giverId, '<i>курсив</i> & [ссылка](http://x) <script>alert(1)</script>');
        await t.app.notifier.whenIdle();
        const delivered = t.sent.find((m) => m.text.includes('<script>alert(1)</script>'));
        expect(delivered).toBeDefined();
        expect(delivered?.chatId).toBe(String(htmlP?.userId));
    });
});

describe('G. Параллельная жизнь', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('два организатора с одинаковым названием и две Ани в одной комнате', async () => {
        const created = await t.createGame('boss1', true, 'Офис');
        const code = codeOf(created);
        // Второй организатор в Telegram создаёт игру с тем же названием
        await t.telegram(5001, '/start', 'Босс');
        await t.telegramPress(5001, press(t.lastTo(5001), 'Создать игру'));
        await t.telegram(5001, 'Офис', 'Босс');
        await t.telegramPress(5001, press(t.lastTo(5001), 'Без бюджета'));
        await t.telegram(5001, '27 декабря', 'Босс');
        await t.telegramPress(5001, press(t.lastTo(5001), 'Только организую'));
        expect((t.sent[t.sent.length - 2] as ISentMessage).text).toContain('Игра создана');

        // У каждого организатора своя игра в «Моих играх»
        const mine1 = await t.alisa('boss1', 'мои игры');
        expect(mine1.buttons.filter((b) => b.title.startsWith('Офис'))).toHaveLength(1);
        await t.telegram(5001, 'мои игры', 'Босс');
        expect(t.lastTo(5001).buttons.filter((b) => b.title.startsWith('Офис'))).toHaveLength(1);

        // Две Ани в одной комнате
        const card = await t.alisaClick('boss1', await t.alisa('boss1', 'мои игры'), 'Офис');
        const roomId = press(card, 'Участники').r as string;
        const anyaPreview = await t.alisa('anya2', code.toLowerCase());
        await t.alisaClick('anya2', anyaPreview, 'Участвую');
        await t.alisa('anya2', 'Аня');
        await t.alisa('anya2', 'пропустить');
        await t.telegram(5002, code, 'Аня');
        await t.telegramPress(5002, press(t.lastTo(5002), 'Участвую'));
        await t.telegramPress(5002, press(t.lastTo(5002), 'Да, так'));
        await t.telegram(5002, 'пропустить', 'Аня');
        await t.telegram(5003, code, 'Петя');
        await t.telegramPress(5003, press(t.lastTo(5003), 'Участвую'));
        await t.telegramPress(5003, press(t.lastTo(5003), 'Да, так'));
        await t.telegram(5003, 'пропустить', 'Петя');

        // В списке участников Ани различаются подписью платформы
        const members = await t.alisaPress('boss1', { action: A.members, r: roomId });
        expect(members.text).toContain('Аня (Telegram)');
        expect(members.text).toContain('Аня (Алиса)');

        // Жеребьёвка: Санта видит только имя подопечного
        await t.act('boss1', roomId, 'draw', undefined, true);
        await t.app.notifier.whenIdle();
        const participants = await t.app.service.store.participantsOf(roomId);
        const anyas = participants.filter((p) => p.name === 'Аня');
        expect(anyas).toHaveLength(2);
        const whomTexts: string[] = [];
        for (const anya of anyas) {
            const giver = participants.find((p) => p.recipientId === anya.id);
            let whom: string;
            if (giver?.platform === 'alisa') {
                whom = (await t.act(giver.userId, roomId, 'whom')).text;
            } else {
                await t.telegramPress(Number(giver?.userId), {
                    action: A.act,
                    r: roomId,
                    m: 'whom',
                });
                whom = t.lastTo(Number(giver?.userId)).text;
            }
            // Тёзки различаются подписью платформы: даритель понимает, КОТОРАЯ из двух Ань
            expect(whom).toMatch(/вы — Тайный Санта\. Ваш подопечный: Аня \((Алиса|Telegram)\)\./);
            whomTexts.push(whom);
        }
        expect(whomTexts).toHaveLength(2);

        // Сводка организатора: две строки с Анями, различающимися платформой
        const handover = await t.act('boss1', roomId, 'handover');
        const anyaLines = handover.text.split('\n').filter((line) => line.startsWith('Аня ('));
        expect(anyaLines).toHaveLength(2);
    });
});

describe('H. Алиса-только пользователь во всех режимах', () => {
    let t: TestBot;

    beforeEach(() => {
        t = new TestBot({}, MODES);
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('первый запуск, валентинки кнопками из карточки, старые кнопки после cleanup', async () => {
        // Первый запуск: меню с перечнем режимов и четырьмя кнопками
        const menu = await t.alisa('u1', '');
        expect(menu.text).toContain('Тайный Санта');
        expect(menu.buttons.map((b) => b.title)).toEqual([
            'Создать игру',
            'Войти по коду',
            'Мои игры',
            'Помощь',
        ]);

        // Создаёт валентинки, выбирая режим и всё остальное кнопками
        const chooser = await t.alisaClick('u1', menu, 'Создать игру');
        await t.alisaClick('u1', chooser, 'Анонимные валентинки');
        const title = await t.alisa('u1', 'Праздник');
        const tz = await t.alisaClick('u1', title, 'Москва');
        // Кнопка-пресет даты-времени работает: значение принимается как ответ
        const when = await t.alisaClick('u1', tz, '14 февраля в 10:00');
        expect(when.text).toContain('Вы участвуете в игре сами');
        const role = await t.alisaClick('u1', when, 'Я участвую');
        // Организатор участвует: иначе в комнате «any-to-any» некому писать
        expect(role.text).toContain('Как вас подписать');
        const created = await t.alisa('u1', 'Организатор');
        expect(created.text).toContain('Игра создана');
        // Алисе приглашение приходит в том же ответе: она не умеет писать первой
        expect(created.text).toContain('vk.me/rooms_test?ref=');
        const code = codeOf(created);
        const roomId = roomIdOf(created);

        // Второй пользователь Алисы входит по коду
        await t.join('v2', code);

        // Организатор отправляет валентинку кнопкой из карточки
        await t.alisaPress('u1', { action: A.write, r: roomId });
        const written = await t.alisa('u1', 'Роза для тебя!');
        expect(written.text).toContain('будет доставлено в назначенное время');

        // Доставка по расписанию, получатель читает в карточке
        t.now = new Date('2027-02-14T12:00:00Z');
        await t.app.scheduler.tick();
        const v2Card = await t.alisaClick('v2', await t.alisa('v2', 'мои игры'), 'Праздник');
        const inbox = await t.alisaClick('v2', v2Card, 'Входящие сообщения');
        expect(inbox.text).toContain('Роза для тебя!');

        // Через 31 день после события игра удалена cleanup-ом
        t.now = new Date('2027-03-20T00:00:00Z');
        expect(await t.app.service.cleanupExpired()).toBe(1);

        // Старые кнопки в карточке Алисы отвечают понятным текстом
        const stale = await t.alisaPress('v2', { action: A.room, r: roomId });
        expect(stale.text).toContain('Игра не найдена');
        const staleWrite = await t.alisaPress('v2', { action: A.write, r: roomId });
        expect(staleWrite.text).toContain('Игра не найдена');
        expect((await t.alisa('v2', 'мои игры')).text).toContain('пока нет игр');
        const freshMenu = await t.alisa('v2', 'меню');
        expect(freshMenu.buttons.map((b) => b.title)).toEqual([
            'Создать игру',
            'Войти по коду',
            'Мои игры',
            'Помощь',
        ]);
    });
});
