import { A } from '../src/ui';
import { codeOf, IReply, TestBot } from './helpers';
import { BirthdayMode } from '../src/modes/birthdays/BirthdayMode';
import { MeetingMode } from '../src/modes/meeting/MeetingMode';
import { MODES } from '../src/modes/registry';

/**
 * UX-обзор режимов «Дни рождения команды» и «Сбор на встречу» глазами
 * организатора-педанта и новичков. Каждый сценарий — воспроизведённый тест:
 * утверждения отражают фактическое поведение бота, а не пожелания.
 */

const alisaUser = (id: string): { platform: 'alisa'; userId: string } => ({
    platform: 'alisa',
    userId: id,
});
const tgUser = (id: number): { platform: 'telegram'; userId: string } => ({
    platform: 'telegram',
    userId: String(id),
});

/** Новый бот: время зафиксировано, первый запрос создаёт таблицы umbot. */
async function freshBot(now = '2027-03-01T06:00:00Z'): Promise<TestBot> {
    const t = new TestBot({}, MODES);
    t.now = new Date(now);
    await t.alisa('boot', 'меню');
    return t;
}

/** Нажимает кнопку из последнего сообщения Telegram. */
async function tgClick(t: TestBot, id: number, title: string): Promise<void> {
    const button = t.lastTo(id).buttons.find((b) => b.title.startsWith(title));
    if (!button?.payload) {
        throw new Error(`Нет кнопки «${title}»`);
    }
    await t.telegramPress(id, button.payload);
}

describe('Дни рождения: A. создание организатором-педантом', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('пояс: подсказки, кривые значения, честный IANA; роль «только организую»', async () => {
        await t.alisa('pedant', 'создать');
        const ask = await t.alisa('pedant', 'Дни рождения команды');
        expect(ask.text).toContain('Как назовём игру');
        const tz = await t.alisa('pedant', 'Команда педантов');
        expect(tz.text).toContain('Часовой пояс IANA');
        expect(tz.buttons.map((b) => b.title)).toEqual(['Москва', 'Новосибирск', 'UTC', 'Отмена']);

        // Кривые пояса: бот не падает и объясняет, что хочет IANA;
        // кириллица и аббревиатуры городов распознаются
        expect((await t.alisa('pedant', 'moscow')).text).toContain('Укажите часовой пояс IANA');
        expect((await t.alisa('pedant', 'BAD/Zone')).text).toContain('Укажите часовой пояс IANA');
        const msk = await t.alisa('pedant', 'МСК');
        expect(msk.text).toContain('Вы участвуете в игре сами или только организуете?');
        const created = await t.alisaClick('pedant', msk, 'Только организую');
        expect(created.text).toContain('Игра создана');
        expect(created.text).toContain('Europe/Moscow');
        expect(created.text).toContain('Вы только организуете эту игру.');
        expect(codeOf(created)).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    });

    it('пояс кнопкой; роль текстом; организатор-участник проходит анкету', async () => {
        await t.telegram(501, '/start', 'Ольга');
        await tgClick(t, 501, 'Создать игру');
        await t.telegram(501, 'Дни рождения команды', 'Ольга');
        await t.telegram(501, 'Команда', 'Ольга');
        await tgClick(t, 501, 'Москва');
        // Роль текстом: алиас работает без кнопки
        await t.telegram(501, 'я участвую', 'Ольга');
        // Организатор Telegram: имя берётся из профиля, есть подсказка «Да, так»
        const nameAsk = t.lastTo(501);
        expect(nameAsk.text).toContain('Участники увидят вас как «Ольга»');
        await tgClick(t, 501, 'Да, так');
        await t.telegram(501, '01.06', 'Ольга');
        // Карточка уходит первым сообщением, приглашение — вторым (последним)
        const invite = t.lastTo(501);
        const card = t.sent[t.sent.length - 2]!;
        expect(card.text).toContain('Игра создана');
        expect(invite.text).toContain('Пришлите боту код');
        expect(card.text).toContain('Europe/Moscow');
        expect(card.text).toContain('Вы: Ольга. День рождения: 1 июня');
        expect(card.text).toContain('В игре 1 участник');
    });

    it('роль текстом-алиасом; невалидная роль не застревает', async () => {
        await t.alisa('pedant', 'создать');
        await t.alisa('pedant', 'Дни рождения команды');
        await t.alisa('pedant', 'Педанты 2');
        await t.alisa('pedant', 'Europe/Moscow');
        expect((await t.alisa('pedant', 'не знаю')).text).toContain('Вы участвуете');
        expect((await t.alisa('pedant', '1')).text).toContain('Вы участвуете');
        const created = await t.alisa('pedant', 'организую');
        expect(created.text).toContain('Игра создана');
        expect(created.text).toContain('Вы только организуете эту игру.');
    });
});

describe('Дни рождения: B. анкеты участников и правка даты', () => {
    let t: TestBot;
    let code: string;
    let roomId: string;

    beforeEach(async () => {
        t = await freshBot();
        const created = await t.app.service.createRoom(
            alisaUser('pedant'),
            BirthdayMode,
            'Команда',
            { timezone: 'Europe/Moscow' },
        );
        code = created.code;
        roomId = created.id;
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    /** Алиса-участник входит и отвечает на вопрос о дне рождения. */
    async function join(user: string, name: string, birthday: string): Promise<IReply> {
        const preview = await t.alisa(user, code.toLowerCase());
        const nameAsk = await t.alisaClick(user, preview, 'Участвую');
        expect(nameAsk.text).toContain('Как вас подписать');
        await t.alisa(user, name);
        return t.alisa(user, birthday);
    }

    it('29.02 принимается; 31.02 и пустой ответ — повтор вопроса; 1 января и 01.01 равны', async () => {
        const anya = await join('anya', 'Аня', '29.02');
        expect(anya.text).toContain('Дата сохранена');
        const retry = await join('boris', 'Борис', '31.02');
        expect(retry.text).toContain('Не понял дату. Напишите день и месяц');
        // Пустой ответ: повтор вопроса, без сохранения
        expect((await t.alisa('boris', '')).text).toContain('Не понял дату');
        expect((await t.alisa('boris', '01.01')).text).toContain('Дата сохранена');
        expect((await join('vera', 'Вера', '1 января')).text).toContain('Дата сохранена');

        const dates = await t.act('anya', roomId, 'dates');
        expect(dates.text).toContain('Аня: 29 февраля');
        expect(dates.text).toContain('Борис: 1 января');
        expect(dates.text).toContain('Вера: 1 января');
    });

    it('правка своей даты: календарь обновляется, напоминания по старой дате исчезают', async () => {
        await t.app.service.join(alisaUser('anya'), roomId, 'Аня', { birthday: '03-14' });
        await t.app.service.join(alisaUser('boris'), roomId, 'Борис', { birthday: '05-10' });

        // Напоминание за 7 дней до ДР Ани успело уйти
        t.now = new Date('2027-03-07T07:00:00Z');
        const before = await t.app.service.runSchedule(roomId);
        expect(before?.outgoing.map((m) => m.text)).toEqual([
            expect.stringContaining('день рождения отмечает Аня'),
        ]);

        // Аня меняет дату с 14 марта на 10 октября
        await t.act('anya', roomId, 'bday');
        const bdayAsk = await t.alisa('anya', '10.10');
        expect(bdayAsk.text).toContain('Дата обновлена.');
        expect((await t.act('anya', roomId, 'dates')).text).toContain('Аня: 10 октября');

        // В сам день 14 марта напоминания об Ане больше нет
        t.now = new Date('2027-03-14T07:00:00Z');
        const day = await t.app.service.runSchedule(roomId);
        expect(day === null || day.outgoing.every((m) => !m.text.includes('Аня'))).toBe(true);
    });
});

describe('Дни рождения: C. календарь, Алиса, поздний участник', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('порядок по ближайшей дате; календарь виден участнику из Алисы', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Europe/Moscow',
        });
        await t.app.service.join(alisaUser('boris'), room.id, 'Борис', { birthday: '12-31' });
        await t.app.service.join(alisaUser('anya'), room.id, 'Аня', { birthday: '03-14' });
        await t.app.service.join(alisaUser('vera'), room.id, 'Вера', { birthday: '01-05' });

        const dates = await t.act('anya', room.id, 'dates');
        const lines = dates.text.split('\n');
        expect(lines[0]).toContain('Аня');
        expect(lines[1]).toContain('Борис');
        expect(lines[2]).toContain('Вера');
        expect(dates.text).toContain('5 января');
    });

    it('поздний участник со свежей датой не получает прошлых напоминаний', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Europe/Moscow',
        });
        // Дима входит 10 марта, его ДР был 8 марта — в этом году уже прошло
        t.now = new Date('2027-03-10T12:00:00Z');
        await t.app.service.join(alisaUser('dima'), room.id, 'Дима', { birthday: '03-08' });

        // Никакой ретроспективной рассылки: ни 10, ни 15 марта
        for (const day of ['2027-03-10T13:00:00Z', '2027-03-15T07:00:00Z']) {
            t.now = new Date(day);
            expect(await t.app.service.runSchedule(room.id)).toBeNull();
        }
        // Дима в календаре — со следующего года
        expect((await t.act('dima', room.id, 'dates')).text).toContain('Дима: 8 марта');
    });
});

describe('Дни рождения: D. напоминания и часовой пояс', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('Камчатка vs Москва: напоминание в 10:00 по поясу комнаты, не имениннику', async () => {
        const kam = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Камчатка', {
            timezone: 'Asia/Kamchatka',
        });
        const anya = await t.app.service.join(alisaUser('anya'), kam.id, 'Аня', {
            birthday: '03-14',
        });
        const boris = await t.app.service.join(alisaUser('boris'), kam.id, 'Борис', {
            birthday: '03-25',
        });

        // 10:00 на Камчатке 7 марта = 22:00 UTC 6 марта: напоминание за 7 дней об Ане — Борису
        t.now = new Date('2027-03-06T21:59:59Z');
        expect(await t.app.service.runSchedule(kam.id)).toBeNull();
        t.now = new Date('2027-03-06T22:00:00Z');
        const week = await t.app.service.runSchedule(kam.id);
        expect(week?.outgoing).toHaveLength(1);
        // Не имениннику: Аня напоминание о себе не получает
        expect(week?.outgoing[0]?.participantId).not.toBe(anya.participant.id);
        expect(week?.outgoing[0]?.participantId).toBe(boris.participant.id);
        expect(week?.outgoing[0]?.text).toContain(
            'через 7 дней день рождения отмечает Аня — 14 марта',
        );

        // 10:00 на Камчатке 14 марта = 22:00 UTC 13 марта: «сегодня» — снова не имениннице
        t.now = new Date('2027-03-13T21:59:59Z');
        expect(await t.app.service.runSchedule(kam.id)).toBeNull();
        t.now = new Date('2027-03-13T22:00:00Z');
        const kamDay = await t.app.service.runSchedule(kam.id);
        expect(kamDay?.outgoing).toHaveLength(1);
        expect(kamDay?.outgoing[0]?.participantId).toBe(boris.participant.id);
        expect(kamDay?.outgoing[0]?.text).toContain(
            'сегодня день рождения отмечает Аня — 14 марта',
        );

        // Та же дата в московской комнате: 10:00 МСК = 07:00 UTC
        const msk = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Москва', {
            timezone: 'Europe/Moscow',
        });
        const mskAnya = await t.app.service.join(alisaUser('vera'), msk.id, 'Вера', {
            birthday: '03-14',
        });
        const glasha = await t.app.service.join(alisaUser('glasha'), msk.id, 'Глаша', {
            birthday: '03-25',
        });
        t.now = new Date('2027-03-14T06:59:59Z');
        expect(await t.app.service.runSchedule(msk.id)).toBeNull();
        t.now = new Date('2027-03-14T07:00:00Z');
        const mskDay = await t.app.service.runSchedule(msk.id);
        expect(mskDay?.outgoing).toHaveLength(1);
        expect(mskDay?.outgoing[0]?.participantId).toBe(glasha.participant.id);
        expect(mskDay?.outgoing[0]?.text).toContain(
            'сегодня день рождения отмечает Вера — 14 марта',
        );
        void mskAnya;
    });

    it('семь дней и сам день: каждому, кроме именинника; повторный запуск не дублирует', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Europe/Moscow',
        });
        const anya = await t.app.service.join(alisaUser('anya'), room.id, 'Аня', {
            birthday: '03-14',
        });
        const boris = await t.app.service.join(alisaUser('boris'), room.id, 'Борис', {
            birthday: '03-14',
        });

        t.now = new Date('2027-03-07T07:00:00Z');
        const week = await t.app.service.runSchedule(room.id);
        // Двое именинников: каждый получает напоминание о другом, себе — нет
        expect(week?.outgoing).toHaveLength(2);
        const toAnya = week?.outgoing.find((m) => m.participantId === anya.participant.id);
        const toBoris = week?.outgoing.find((m) => m.participantId === boris.participant.id);
        expect(toAnya?.text).toContain('отмечает Борис');
        expect(toBoris?.text).toContain('отмечает Аня');
        expect(await t.app.service.runSchedule(room.id)).toBeNull();
    });

    it('после выхода участника напоминания о нём прекращаются', async () => {
        // Комната создана 14 марта: ДР Ани (14 марта) в этом году уже прошёл
        t.now = new Date('2027-03-14T00:00:00Z');
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Asia/Kamchatka',
        });
        await t.app.service.join(alisaUser('anya'), room.id, 'Аня', { birthday: '03-14' });
        const vera = await t.app.service.join(alisaUser('vera'), room.id, 'Вера', {
            birthday: '03-20',
        });
        await t.app.service.leave(vera.participant, room.id);

        // День рождения Веры наступил — но она вышла: ни напоминания о ней, ни ей
        t.now = new Date('2027-03-19T21:59:59Z');
        expect(await t.app.service.runSchedule(room.id)).toBeNull();
        t.now = new Date('2027-03-19T22:00:00Z');
        expect(await t.app.service.runSchedule(room.id)).toBeNull();
    });
});

describe('Дни рождения: E. исключение участника организатором', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('исключённый исчез из календаря и из напоминаний', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Europe/Moscow',
        });
        const anya = await t.app.service.join(alisaUser('anya'), room.id, 'Аня', {
            birthday: '03-14',
        });
        await t.app.service.join(alisaUser('boris'), room.id, 'Борис', { birthday: '05-10' });
        expect((await t.act('pedant', room.id, 'dates')).text).toContain('Аня: 14 марта');

        // Организатор открывает список участников и исключает Аню кнопкой
        await t.alisaPress('pedant', { action: A.members, r: room.id });
        const members = await t.alisaPress('pedant', {
            action: A.kick,
            r: room.id,
            x: anya.participant.id,
        });
        expect(members.text).toContain('Аня (Алиса) больше не участвует');

        expect((await t.act('pedant', room.id, 'dates')).text).not.toContain('Аня');

        // В сам день Ани напоминаний нет
        t.now = new Date('2027-03-14T07:00:00Z');
        const day = await t.app.service.runSchedule(room.id);
        expect(day === null || day.outgoing.every((m) => !m.text.includes('Аня'))).toBe(true);
    });
});

describe('Встреча: F. создание новичком с чушью на каждом шагу', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('кривые даты отбраковываются, свободный текст принимает любую чушь', async () => {
        const n = 'novice';
        const hello = await t.alisa(n, 'привет');
        expect(hello.buttons.some((b) => b.title.startsWith('Создать игру'))).toBe(true);
        await t.alisa(n, 'создать');
        expect((await t.alisa(n, 'Сбор на встречу')).text).toContain('Как назовём игру');

        // Название: любая чушь молча становится названием
        expect((await t.alisa(n, 'не знаю')).text).toContain('Часовой пояс IANA');

        // Пояс: чушь отбраковывается, кнопки спасают
        expect((await t.alisa(n, 'да')).text).toContain('Укажите часовой пояс IANA');
        expect((await t.alisa(n, '1')).text).toContain('Укажите часовой пояс IANA');
        const tzAsk = await t.alisa(n, 'хочу домой');
        expect(tzAsk.text).toContain('Укажите часовой пояс IANA');
        await t.alisaClick(n, tzAsk, 'Москва');

        // Дата и время: кривые форматы честно отбраковываются с примером,
        // часы без минут («завтра в 5») теперь принимаются
        expect((await t.alisa(n, '31.02.2027 19:00')).text).toContain('Не понял дату и время');
        expect((await t.alisa(n, '01.03.2027 25:00')).text).toContain('Не понял дату и время');
        expect((await t.alisa(n, '14.03.2027 19:00')).text).toContain('Где встречаемся');

        // Место: чушь молча становится местом
        expect((await t.alisa(n, 'хочу домой')).text).toContain('Сумма взноса');

        // Взнос: теперь число — чушь честно отбраковывается, кнопка-пресет работает
        const moneyRetry = await t.alisa(n, 'минус сто');
        expect(moneyRetry.text).toContain('Нужно целое число');
        expect(moneyRetry.text).toContain('Сумма взноса');
        const money = await t.alisaClick(n, moneyRetry, '500 рублей');
        expect(money.text).toContain('Как передать деньги');

        // Инструкция: снова чушь
        const roleAsk = await t.alisa(n, 'не знаю');
        expect(roleAsk.text).toContain('Вы участвуете');
        const card = await t.alisaClick(n, roleAsk, 'Только организую');
        expect(card.text).toContain('Игра создана');
        expect(card.text).toContain('«не знаю»');
        expect(card.text).toContain('14 марта в 19:00');
        expect(card.text).toContain('Место: хочу домой');
        expect(card.text).toContain('Взнос: 500 ₽');
    });

    it('кнопка готовой суммы «500 рублей» принимает ответ', async () => {
        const n = 'novice2';
        await t.alisa(n, 'создать');
        await t.alisa(n, 'Сбор на встречу');
        await t.alisa(n, 'Встреча отдела');
        await t.alisa(n, 'Europe/Moscow');
        await t.alisa(n, '14.03.2027 19:00');
        const moneyAsk = await t.alisa(n, 'Парк');
        expect(moneyAsk.text).toContain('Сумма взноса');
        expect(moneyAsk.buttons.map((b) => b.title)).toEqual([
            '300 рублей',
            '500 рублей',
            '1000 рублей',
            '1500 рублей',
            '2000 рублей',
            'Пропустить',
            'Отмена',
        ]);
        const after = await t.alisaClick(n, moneyAsk, '500 рублей');
        expect(after.text).toContain('Как передать деньги');
        const afterSkip = await t.alisa(n, 'пропустить');
        expect(afterSkip.text).toContain('Вы участвуете');
        const card = await t.alisaClick(n, afterSkip, 'Я участвую');
        expect(card.text).toContain('Как вас подписать');
    });
});

describe('Встреча: G. ответы, взносы, счётчики', () => {
    let t: TestBot;
    let roomId: string;

    beforeEach(async () => {
        t = await freshBot();
        const room = await t.app.service.createRoom(alisaUser('pedant'), MeetingMode, 'Планирка', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-03-14T19:00',
            place: 'Парк',
            contribution: '500',
            instructions: 'Переводом на карту',
        });
        roomId = room.id;
        await t.app.service.join(alisaUser('anya'), roomId, 'Аня', { rsvp: 'maybe' });
        await t.app.service.join(alisaUser('boris'), roomId, 'Борис', { rsvp: 'maybe' });
        await t.app.service.join(alisaUser('vera'), roomId, 'Вера', { rsvp: 'maybe' });
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('выбор только кнопкой; чушь — повтор вопроса; ответы меняются в обе стороны', async () => {
        await t.act('anya', roomId, 'rsvp');
        const ask = await t.alisa('anya', '');
        expect(ask.text).toContain('Придёте на встречу?');
        expect((await t.alisa('anya', 'да')).text).toContain('Выберите один из вариантов');
        expect((await t.alisa('anya', 'не знаю')).text).toContain('Выберите один из вариантов');
        expect((await t.alisa('anya', '1')).text).toContain('Выберите один из вариантов');
        const chosen = await t.alisaClick('anya', await t.alisa('anya', ''), 'Приду');
        expect(chosen.text).toContain('Вы: Аня. Участие: Приду');

        await t.act('boris', roomId, 'rsvp');
        await t.alisaClick('boris', await t.alisa('boris', ''), 'Не приду');
        await t.act('vera', roomId, 'rsvp');
        await t.alisaClick('vera', await t.alisa('vera', ''), 'Пока не знаю');

        // Смена в обе стороны
        await t.act('boris', roomId, 'rsvp');
        const flipped = await t.alisaClick('boris', await t.alisa('boris', ''), 'Приду');
        expect(flipped.text).toContain('Участие: Приду');
        await t.act('anya', roomId, 'rsvp');
        await t.alisaClick('anya', await t.alisa('anya', ''), 'Не приду');
        await t.act('anya', roomId, 'rsvp');
        await t.alisaClick('anya', await t.alisa('anya', ''), 'Приду');

        // Взнос: «Я сдал» — заявление участника, не подтверждение
        const paid = await t.act('anya', roomId, 'paid');
        expect(paid.text).toContain('Отмечено с ваших слов.');
        // Смена ответа после отметки: отметка остаётся
        await t.act('anya', roomId, 'rsvp');
        await t.alisaClick('anya', await t.alisa('anya', ''), 'Пока не знаю');
        const tally1 = await t.act('pedant', roomId, 'tally');
        expect(tally1.text).toContain('Аня: Пока не знаю; взнос отмечен');

        // Снять отметку
        const unpaid = await t.act('anya', roomId, 'paid');
        expect(unpaid.text).toContain('Отметка снята.');
    });

    it('отчёт организатора: счётчики и отметки читаемы', async () => {
        await t.app.service.runAction(alisaUser('anya'), roomId, 'rsvp', { answer: 'yes' });
        await t.app.service.runAction(alisaUser('boris'), roomId, 'rsvp', { answer: 'no' });
        await t.app.service.runAction(alisaUser('vera'), roomId, 'rsvp', { answer: 'maybe' });
        await t.app.service.runAction(alisaUser('vera'), roomId, 'paid', {});
        const tally = await t.act('pedant', roomId, 'tally');
        expect(tally.text).toContain('Приду: 1');
        expect(tally.text).toContain('Не приду: 1');
        expect(tally.text).toContain('Пока не знаю: 1');
        expect(tally.text).toContain('Аня: Приду; взнос не отмечен');
        expect(tally.text).toContain('Борис: Не приду; взнос не отмечен');
        expect(tally.text).toContain('Вера: Пока не знаю; взнос отмечен');
    });

    it('без взноса кнопки «Я сдал» нет вовсе', async () => {
        const free = await t.app.service.createRoom(alisaUser('pedant'), MeetingMode, 'Кофе', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-03-14T19:00',
            place: 'Кафе',
        });
        await t.app.service.join(alisaUser('anya'), free.id, 'Аня', { rsvp: 'maybe' });
        await t.act('anya', free.id, 'rsvp');
        // После ответа приходит карточка: кнопки «Я сдал» в ней нет
        const card = await t.alisaClick('anya', await t.alisa('anya', ''), 'Приду');
        expect(card.buttons.some((b) => b.title.startsWith('Я сдал'))).toBe(false);
        expect(card.buttons.some((b) => b.title.startsWith('Изменить ответ'))).toBe(true);
    });
});

describe('Встреча: H. правки организатора и рассылка', () => {
    let t: TestBot;
    let roomId: string;

    beforeEach(async () => {
        t = await freshBot();
        const room = await t.app.service.createRoom(alisaUser('pedant'), MeetingMode, 'Планирка', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-03-14T19:00',
            place: 'Парк',
            contribution: '500',
        });
        roomId = room.id;
        await t.app.service.join(tgUser(601), roomId, 'Борис', { rsvp: 'yes' });
        await t.app.service.join(alisaUser('anya'), roomId, 'Аня', { rsvp: 'maybe' });
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('смена места: рассылка участникам и обновлённая карточка', async () => {
        await t.act('pedant', roomId, 'place');
        const placeAsk = await t.alisa('pedant', 'Офис 404');
        expect(placeAsk.text).toContain('Место: Офис 404');

        // Telegram-участнику пришла рассылка с конкретикой, а не общее «параметры изменились»
        const toBoris = t.lastTo(601);
        expect(toBoris.text).toContain('Встреча теперь в другом месте: Офис 404.');
        expect(toBoris.text).toContain('Место: Офис 404');
    });

    it('смена даты: рассылка; прошедшее время честно отбраковывается', async () => {
        await t.act('pedant', roomId, 'date');
        const dateAsk = await t.alisa('pedant', '20.03.2027 10:00');
        expect(dateAsk.text).toContain('20 марта в 10:00');
        const toBoris = t.lastTo(601);
        expect(toBoris.text).toContain('20 марта в 10:00');

        // Прошлое время: бот объясняет и переспрашивает
        await t.act('pedant', roomId, 'date');
        const past = await t.alisa('pedant', '01.03.2025 10:00');
        expect(past.text).toContain('Это время уже прошло');

        // Напоминание по прошедшей встрече не уходит
        const run = await t.app.service.runSchedule(roomId);
        expect(run?.outgoing ?? []).toEqual([]);
    });
});

describe('Встреча: I. напоминание за 24 часа', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('получают только «Приду» и «Пока не знаю»; после встречи напоминание не уходит', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), MeetingMode, 'Планирка', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-03-14T19:00',
            place: 'Парк',
        });
        const anya = await t.app.service.join(alisaUser('anya'), room.id, 'Аня', { rsvp: 'yes' });
        const boris = await t.app.service.join(alisaUser('boris'), room.id, 'Борис', {
            rsvp: 'no',
        });
        const vera = await t.app.service.join(alisaUser('vera'), room.id, 'Вера', {
            rsvp: 'maybe',
        });

        // За 24 часа: 19:00 МСК 13 марта = 16:00 UTC
        t.now = new Date('2027-03-13T15:59:59Z');
        expect(await t.app.service.runSchedule(room.id)).toBeNull();
        t.now = new Date('2027-03-13T16:00:00Z');
        const run = await t.app.service.runSchedule(room.id);
        const recipients = run?.outgoing.map((m) => m.participantId);
        expect(recipients).toContain(anya.participant.id);
        expect(recipients).toContain(vera.participant.id);
        expect(recipients).not.toContain(boris.participant.id);
        expect(run?.outgoing[0]?.text).toContain('Скоро встреча!');
        // Повторный запуск не дублирует
        expect(await t.app.service.runSchedule(room.id)).toBeNull();

        // Если тика не было до встречи — после встречи напоминание уже не уходит
        const late = await t.app.service.createRoom(
            alisaUser('pedant'),
            MeetingMode,
            'Опоздавшие',
            { timezone: 'Europe/Moscow', eventAt: '2027-03-14T19:00', place: 'Парк' },
        );
        await t.app.service.join(alisaUser('dima'), late.id, 'Дима', { rsvp: 'yes' });
        t.now = new Date('2027-03-14T20:00:00Z');
        const skipped = await t.app.service.runSchedule(late.id);
        expect(skipped?.outgoing ?? []).toEqual([]);
    });
});

describe('Встреча: J. завершение комнаты', () => {
    let t: TestBot;
    let roomId: string;
    let code: string;

    beforeEach(async () => {
        t = await freshBot();
        const room = await t.app.service.createRoom(alisaUser('pedant'), MeetingMode, 'Планирка', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-03-14T19:00',
            place: 'Парк',
            contribution: '500',
        });
        roomId = room.id;
        code = room.code;
        await t.app.service.join(alisaUser('anya'), roomId, 'Аня', { rsvp: 'yes' });
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('после завершения ответы и взносы недоступны, текст честный', async () => {
        const finished = await t.act('pedant', roomId, 'finish');
        expect(finished.text).toContain('Игра завершена.');

        // Старые кнопки участника: действие недоступно, причина объяснена
        expect((await t.act('anya', roomId, 'rsvp')).text).toContain('сейчас недоступно');
        expect((await t.act('anya', roomId, 'paid')).text).toContain('сейчас недоступно');

        // Вход по коду завершённой игры: код верный, но игра закончилась — и это объяснено
        const again = await t.alisa('newbie', code.toLowerCase());
        expect(again.text).toContain('уже завершена');
    });
});

describe('K. новичок: побеги из мастера и мусорные комнаты', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('«создать» посреди чужой анкеты уводит в создание, а не становится именем', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Europe/Moscow',
        });
        const preview = await t.alisa('novice', room.code.toLowerCase());
        await t.alisaClick('novice', preview, 'Участвую');
        expect((await t.alisa('novice', '')).text).toContain('Как вас подписать');

        // Новичок пишет «создать» — намерение уважается: анкета брошена, открыт мастер создания
        const next = await t.alisa('novice', 'создать');
        expect(next.text).toContain('Во что играем');

        // Анкета входа брошена: участника нет
        const participants = await t.app.service.store.participantsOf(room.id);
        expect(participants).toHaveLength(0);
        // Мусорных комнат не осталось
        expect(await t.app.service.myRooms(alisaUser('pedant'))).toHaveLength(1);
    });

    it('«Помощь» не прерывает анкету, «меню» бросает создание без мусорной комнаты', async () => {
        await t.alisa('novice', 'создать');
        expect((await t.alisa('novice', 'Дни рождения команды')).text).toContain(
            'Как назовём игру',
        );

        // Помощь: справка + повтор вопроса, черновик жив
        const help = await t.alisa('novice', 'помощь');
        expect(help.text).toContain('Как играть');
        expect(help.text).toContain('Как назовём игру');
        expect((await t.alisa('novice', 'Черновик')).text).toContain('Часовой пояс IANA');

        // Побег из мастера: комнаты нет
        await t.alisa('novice', 'меню');
        expect(await t.app.service.myRooms(alisaUser('novice'))).toHaveLength(0);
    });

    it('бессмыслица без мастера: «как дела» — вежливое «не понял»', async () => {
        await t.alisa('novice', 'привет');
        expect((await t.alisa('novice', 'как дела')).text).toContain('Не понял');
        expect((await t.alisa('novice', '1')).text).toContain('Не понял');
    });
});

describe('Одинаковые подписи кнопок', () => {
    let t: TestBot;

    beforeEach(async () => {
        t = await freshBot();
    });

    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    it('две комнаты с одним названием: кнопки неотличимы, голосом выбрать нельзя', async () => {
        await t.app.service.createRoom(alisaUser('boss'), BirthdayMode, 'Стройка', {
            timezone: 'Europe/Moscow',
        });
        await t.app.service.createRoom(alisaUser('boss'), MeetingMode, 'Стройка', {
            timezone: 'Europe/Moscow',
            eventAt: '2027-03-14T19:00',
            place: 'Парк',
        });
        const mine = await t.alisa('boss', 'мои игры');
        const dup = mine.buttons.map((b) => b.title).filter((title) => title.startsWith('Стройка'));
        expect(dup).toHaveLength(2);
        expect(dup[0]).toBe(dup[1]);

        // Голосом «Стройка» выбрать конкретную нельзя: бот отвечает «не понял»
        expect((await t.alisa('boss', 'Стройка')).text).toContain('Не понял');
    });

    it('две Ани в списке участников: две одинаковые кнопки «Исключить: Аня»', async () => {
        const room = await t.app.service.createRoom(alisaUser('pedant'), BirthdayMode, 'Команда', {
            timezone: 'Europe/Moscow',
        });
        await t.app.service.join(alisaUser('anya1'), room.id, 'Аня', { birthday: '03-14' });
        await t.app.service.join(tgUser(701), room.id, 'Аня', { birthday: '05-10' });

        await t.alisaPress('pedant', { action: A.members, r: room.id });
        const members = await t.alisaPress('pedant', { action: A.members, r: room.id });
        const kicks = members.buttons
            .map((b) => b.title)
            .filter((title) => title.startsWith('Исключить: Аня'));
        expect(kicks).toHaveLength(2);
        expect(kicks[0]).toBe(kicks[1]);
        // Платформы видны в тексте списка, но не в подписях кнопок
        expect(members.text).toContain('Аня (Алиса)');
        expect(members.text).toContain('Аня (Telegram)');
    });
});
