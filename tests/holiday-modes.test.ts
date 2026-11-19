import { RoomLock } from '../src/core/RoomLock';
import { RoomService } from '../src/core/RoomService';
import { ModeRegistry } from '../src/core/ModeRegistry';
import { IRoom } from '../src/core/types';
import { IMode } from '../src/modes/IMode';
import { BirthdayMode } from '../src/modes/birthdays/BirthdayMode';
import { GiftMode } from '../src/modes/gift/GiftMode';
import { MeetingMode } from '../src/modes/meeting/MeetingMode';
import { ValentineMode } from '../src/modes/valentines/ValentineMode';
import { MODES } from '../src/modes/registry';
import { A, IPayload } from '../src/ui';
import { codeOf, IReply, roomIdOf, TestBot } from './helpers';

const owner = { platform: 'alisa', userId: 'owner' };
const users = [
    { platform: 'telegram', userId: '101' },
    { platform: 'vk', userId: '102' },
    { platform: 'max_app', userId: '103' },
    { platform: 'alisa', userId: '104' },
];
const settings = {
    timezone: 'Europe/Moscow',
    eventAt: '2027-03-14T10:00',
    place: 'Парк',
    contribution: '500 ₽',
    eventDate: '2027-03-14',
};

describe.each([false, true])('новые режимы: файловая БД = %s', (file) => {
    let t: TestBot;
    beforeEach(async () => {
        t = new TestBot(file ? { sqliteFile: undefined } : {}, MODES);
        t.now = new Date('2027-03-01T06:00:00Z');
        await t.alisa('owner', 'меню');
    });
    afterEach(async () => {
        await t.close();
        expect(t.errors).toEqual([]);
    });

    async function room(mode: IMode, extra = {}): Promise<IRoom> {
        const created = await t.app.service.createRoom(owner, mode, 'Команда', {
            ...settings,
            ...extra,
        });
        for (const [i, user] of users.entries()) {
            await t.app.service.join(user, created.id, `Имя ${i}`, {
                birthday: '03-14',
                wish: `Подарок ${i}`,
                rsvp: 'maybe',
            });
        }
        return created;
    }

    it('дни рождения: оба напоминания, несколько именинников, часовой пояс, поздний вход и повторный запуск', async () => {
        const r = await room(BirthdayMode);
        expect(r.expiresAt).toBeNull();
        t.now = new Date('2027-03-07T06:59:59Z');
        expect(await t.app.service.runSchedule(r.id)).toBeNull();
        t.now = new Date('2027-03-07T07:00:00Z');
        const before = await t.app.service.runSchedule(r.id);
        expect(before?.outgoing).toHaveLength(12);
        expect(before?.outgoing.every((m) => m.text.includes('через 7 дней'))).toBe(true);
        expect(await t.app.service.runSchedule(r.id)).toBeNull();
        const late = { platform: 'telegram', userId: 'late' };
        t.now = new Date('2027-03-07T08:00:00Z');
        await t.app.service.join(late, r.id, 'Поздний', { birthday: '03-14' });
        expect(await t.app.service.runSchedule(r.id)).toBeNull();
        t.now = new Date('2027-03-14T07:00:00Z');
        const today = await t.app.service.runSchedule(r.id);
        expect(today?.outgoing).toHaveLength(20);
        expect(today?.outgoing.every((m) => m.text.includes('сегодня'))).toBe(true);
        const participants = await t.app.service.store.participantsOf(r.id);
        for (const message of today?.outgoing ?? []) {
            const self = participants.find((p) => p.id === message.participantId)!;
            expect(message.text).not.toContain(`у ${self.name},`);
        }
    });

    it('29 февраля → 28 февраля; изменение даты и удаление данных убирают будущие события', async () => {
        const r = await room(BirthdayMode);
        await t.app.service.runAction(users[0]!, r.id, 'bday', { answer: '02-29' });
        const view = await t.app.service.view(users[0]!, r.id);
        expect((await BirthdayMode.handle('dates', view, {})).reply).toContain('29 февраля');
        await t.app.service.forgetUser(users[0]!);
        const list = await t.app.service.runAction(owner, r.id, 'dates', {});
        expect(list.result.reply).not.toContain('Имя 0');
        const leapRoom = { ...view.room, createdAt: '2027-01-01T00:00:00.000Z', settings: {} };
        const leapCtx = {
            ...view,
            room: leapRoom,
            participants: [
                { ...view.me!, joinedAt: leapRoom.createdAt, profile: { birthday: '02-29' } },
            ],
            now: new Date('2027-02-01T00:00:00Z'),
        };
        expect(BirthdayMode.schedule!(leapCtx)).toBe('2027-02-21T07:00:00.000Z');
        await t.app.service.leave(users[1]!, r.id);
        expect(await t.app.service.myRooms(users[1]!)).toHaveLength(0);
        await t.app.service.deleteRoom(owner, r.id);
        expect(await t.app.service.store.findRoom(r.id)).toBeNull();
    });

    it('валентинки: скрытая доставка, лимит, запрет себе и срок отправки, жалоба без имени автора', async () => {
        const r = await room(ValentineMode);
        const participants = await t.app.service.store.participantsOf(r.id);
        const [sender, recipient] = participants;
        await expect(t.app.relay.send(users[0]!, r.id, sender!.id, 'Себе')).rejects.toThrow();
        for (let i = 0; i < 20; i++) {
            expect(
                (await t.app.relay.send(users[0]!, r.id, recipient!.id, `Привет ${i}`)).scheduled,
            ).toBe(true);
        }
        await expect(t.app.relay.send(users[0]!, r.id, recipient!.id, 'Лишнее')).rejects.toThrow(
            '20',
        );
        expect(await t.app.relay.inbox(users[1]!, r.id)).toHaveLength(0);
        expect((await t.app.scheduler.tick()).messages).toBe(0);
        t.now = new Date('2027-03-14T07:00:00Z');
        await expect(t.app.relay.send(users[2]!, r.id, recipient!.id, 'Поздно')).rejects.toThrow();
        expect((await t.app.scheduler.tick()).messages).toBe(20);
        expect((await t.app.scheduler.tick()).messages).toBe(0);
        const inbox = await t.app.relay.inbox(users[1]!, r.id);
        await t.vk(102, '', { action: A.inbox, r: r.id });
        expect(t.lastTo(102).text).toContain('Привет 19');
        expect(t.lastTo(102).buttons.some((b) => b.title.startsWith('Ответить анонимно'))).toBe(
            false,
        );
        await t.vk(102, '', payload(t.lastTo(102), 'Более ранние'));
        expect(t.lastTo(102).text).toContain('Привет 15');
        const report = await t.app.relay.report(users[1]!, inbox[0]!.id);
        expect(report[0]!.text).not.toContain(sender!.name);
        await t.app.relay.block(users[1]!, inbox[0]!.id);
        await t.app.relay.expel(owner, inbox[0]!.id);
        expect(
            (await t.app.service.view(users[1]!, r.id)).participants.find(
                (p) => p.id === sender!.id,
            )?.userId,
        ).toBe('');
        await t.app.service.runAction(owner, r.id, 'finish', {});
        t.now = new Date('2027-04-15T00:00:00Z');
        expect(await t.app.service.cleanupExpired()).toBe(1);
    });

    it('даритель: пары, скрытая сводка, пожелание, анонимный вопрос, отметки, уход и повторная игра', async () => {
        const r = await room(GiftMode);
        await t.app.service.runAction(owner, r.id, 'draw', {});
        const view = await t.app.service.view(users[0]!, r.id);
        expect(new Set(view.participants.map((p) => p.recipientId)).size).toBe(4);
        expect(view.participants.every((p) => p.id !== p.recipientId)).toBe(true);
        const whom = await t.app.service.runAction(users[0]!, r.id, 'whom', {});
        expect(whom.result.reply).toContain('тайный даритель');
        expect(whom.result.reply).not.toContain('Санта');
        expect(
            (await t.app.service.runAction(owner, r.id, 'handover', {})).result.reply,
        ).not.toContain('→');
        const wish = await t.app.service.runAction(users[0]!, r.id, 'wish', {
            answer: 'Тайный Санта — название книги',
        });
        expect((await t.app.service.view(users[0]!, r.id)).me?.profile.wish).toBe(
            'Тайный Санта — название книги',
        );
        expect(wish.outgoing[0]?.text).toContain('Тайный Санта — название книги');
        expect(
            (await t.app.relay.send(users[0]!, r.id, view.me!.recipientId!, 'Какой цвет?'))
                .outgoing,
        ).toHaveLength(1);
        await t.app.service.runAction(users[0]!, r.id, 'given', {});
        await t.app.service.runAction(users[0]!, r.id, 'received', {});
        expect((await t.app.service.forgetUser(users[0]!)).outgoing).toHaveLength(2);
        await t.app.service.runAction(owner, r.id, 'finish', {});
        const clone = await t.app.service.cloneRoom(owner, r.id);
        expect(clone.mode).toBe('gift');
        expect(clone.status).toBe('open');
        expect(await t.app.service.store.participantsOf(clone.id)).toEqual([]);
    });

    it('встреча: ответы, взносы, права, перенос, напоминание и сохранение при пересоздании сервиса', async () => {
        const r = await room(MeetingMode);
        await t.app.service.runAction(users[0]!, r.id, 'rsvp', { answer: 'no' });
        await t.app.service.runAction(users[1]!, r.id, 'paid', {});
        expect((await t.app.service.runAction(owner, r.id, 'tally', {})).result.reply).toContain(
            'Не приду: 1',
        );
        await t.app.service.runAction(users[1]!, r.id, 'paid', {});
        expect((await t.app.service.view(users[1]!, r.id)).marks).toHaveLength(0);
        await expect(
            t.app.service.runAction(users[0]!, r.id, 'date', { answer: '2027-03-15T10:00' }),
        ).rejects.toThrow('организатор');
        expect(
            (await t.app.service.runAction(owner, r.id, 'place', { answer: 'Кафе' })).outgoing,
        ).toHaveLength(4);
        await t.app.service.runAction(owner, r.id, 'date', { answer: '2027-03-15T10:00' });
        t.now = new Date('2027-03-14T07:00:00Z');
        const restarted = new RoomService(
            t.app.service.store,
            new RoomLock(t.bot.getAppContext()),
            new ModeRegistry(MODES),
            () => t.now,
        );
        expect((await restarted.runSchedule(r.id))?.outgoing).toHaveLength(3);
        expect(await restarted.runSchedule(r.id)).toBeNull();
        await restarted.runAction(owner, r.id, 'finish', {});
        await expect(restarted.runAction(users[1]!, r.id, 'paid', {})).rejects.toThrow(
            'недоступно',
        );
        const free = await room(MeetingMode, { contribution: '' });
        await expect(t.app.service.runAction(users[0]!, free.id, 'paid', {})).rejects.toThrow(
            'недоступно',
        );
    });

    it('регрессия: «Сыграть ещё раз» не переносит старую дату обмена', async () => {
        // Только режимы, которые умеют жить без даты: у валентинок и встречи
        // cloneRoom без eventAt падает (см. отчёт), их «Сыграть ещё раз» сломан.
        // Клонировать можно только завершённую игру (см. D5 отчёта второго круга)
        const old = await room(GiftMode);
        await t.app.service.store.saveRoom({ ...old, status: 'finished' });
        const fresh = await t.app.service.cloneRoom(owner, old.id);
        expect(fresh.settings.eventDate).toBeUndefined();
        // Незавершённую игру клонировать нельзя (D5: payload без кнопки не расширяет сценарий)
        const running = await room(GiftMode);
        await expect(t.app.service.cloneRoom(owner, running.id)).rejects.toThrow(
            'Сыграть ещё раз можно, когда игра завершена.',
        );
    });
});

function payload(reply: IReply, title: string): IPayload {
    return reply.buttons.find((b) => b.title.startsWith(title))!.payload!;
}

describe.each([BirthdayMode, ValentineMode, GiftMode, MeetingMode])(
    '$title: диалоги четырёх платформ',
    (mode) => {
        it('создание голосом, вход из Telegram/VK/MAX/Алисы и карточка', async () => {
            const t = new TestBot({}, MODES);
            t.now = new Date('2027-03-01T00:00:00Z');
            try {
                const menu = await t.alisa('owner', 'создать');
                expect(menu.buttons).toHaveLength(6);
                await t.alisa('owner', mode.title);
                await t.alisa('owner', 'Команда');
                for (const q of mode.createQuestions) {
                    const answers: Record<string, string> = {
                        timezone: 'Москва',
                        eventAt: '14 марта 10:00',
                        eventDate: '14 марта',
                        place: 'Парк',
                        contribution: '500',
                        instructions: 'Лично',
                        budget: '1000',
                        occasion: 'День рождения',
                    };
                    await t.alisa('owner', answers[q.key]!);
                }
                const created = await t.alisa('owner', 'Только организую');
                const code = codeOf(created);
                const id = roomIdOf(created);
                for (const user of users) {
                    const number = Number(user.userId);
                    const send = async (text: string): Promise<IReply> => {
                        switch (user.platform) {
                            case 'telegram':
                                await t.telegram(number, text);
                                return t.lastTo(number);
                            case 'vk':
                                await t.vk(number, text);
                                return t.lastTo(number);
                            case 'max_app':
                                await t.max(number, text);
                                return t.lastTo(number);
                            default:
                                return t.alisa(user.userId, text);
                        }
                    };
                    const preview = await send(code);
                    const join = payload(preview, 'Участвую');
                    if (user.platform === 'telegram') {
                        await t.telegramPress(number, join);
                    } else if (user.platform === 'vk') {
                        await t.vk(number, 'Участвую', join);
                    } else if (user.platform === 'max_app') {
                        await t.maxPress(number, join);
                    } else {
                        await t.alisaPress(user.userId, join);
                    }
                    await send('Участник');
                    for (const q of mode.joinQuestions) {
                        await send(
                            q.key === 'birthday'
                                ? '14 марта'
                                : q.key === 'rsvp'
                                  ? 'Приду'
                                  : 'Книга',
                        );
                    }
                    expect((await t.app.service.view(user, id)).me).not.toBeNull();
                }
                const card = await t.alisaPress('104', { action: A.room, r: id });
                expect(card.text).toContain(mode.title);
                if (mode === BirthdayMode) {
                    expect((await t.alisa('104', 'Изменить день рождения')).text).toContain(
                        'Когда ваш день рождения',
                    );
                }
                if (mode === MeetingMode) {
                    expect((await t.alisa('104', 'Изменить ответ')).text).toContain('Придёте');
                }
                if (mode === ValentineMode) {
                    await t.alisa('104', 'Написать анонимно');
                    await t.alisa('104', 'Участник'); // одинаковые имена неоднозначны: остаются кнопки выбора
                    const target = (await t.app.service.view(users[3]!, id)).participants[0]!;
                    await t.app.relay.send(
                        users[0]!,
                        id,
                        (await t.app.service.view(users[3]!, id)).me!.id,
                        'Для Алисы',
                    );
                    t.now = new Date('2027-03-14T07:00:00Z');
                    await t.app.scheduler.tick();
                    const inboxCard = await t.alisaPress('104', { action: A.room, r: id });
                    expect(payload(inboxCard, 'Входящие').action).toBe(A.inbox);
                    expect((await t.alisa('104', 'Входящие сообщения')).text).toContain(
                        'Для Алисы',
                    );
                    expect(target).toBeDefined();
                }
            } finally {
                await t.close();
            }
            expect(t.errors).toEqual([]);
        });
    },
);
