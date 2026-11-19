import { IMark, IParticipant, IRoom } from '../src/core/types';
import { IModeContext } from '../src/modes/IMode';
import { SantaMode } from '../src/modes/santa/SantaMode';

/** Режим тестируется без БД и сети: на вход — состояние комнаты, на выход — IModeResult. */
const room: IRoom = {
    id: 'room',
    code: 'K7M2QX',
    mode: 'santa',
    title: 'Офис',
    settings: { eventDate: '2026-12-27', budget: 'до 1500 ₽' },
    ownerPlatform: 'telegram',
    ownerUserId: '1',
    status: 'open',
    timezone: 'Europe/Moscow',
    createdAt: '2026-11-01T00:00:00.000Z',
    closedAt: null,
    expiresAt: null,
    nextRunAt: null,
};

function participant(id: string, wish = ''): IParticipant {
    return {
        id,
        roomId: 'room',
        platform: 'telegram',
        userId: id,
        name: id,
        profile: { wish },
        recipientId: null,
        delivery: null,
        joinedAt: '2026-11-01T00:00:00.000Z',
    };
}

function ctx(patch: Partial<IModeContext> = {}): IModeContext {
    return {
        room,
        participants: ['1', '2', '3'].map((id) => participant(id, `хочу ${id}`)),
        marks: [],
        me: null,
        isOwner: true,
        now: new Date('2026-12-01T00:00:00Z'),
        ...patch,
    };
}

describe('SantaMode без БД', () => {
    it('жеребьёвка: пары, статус closed и отслеживаемые сообщения каждому', async () => {
        const result = await SantaMode.handle('draw', ctx(), {});
        expect(result.room).toEqual({ status: 'closed' });
        expect(result.participants).toHaveLength(3);
        expect(new Set(result.participants?.map((p) => p.recipientId)).size).toBe(3);
        expect(result.messages?.every((m) => m.track && m.text.includes('Пожелание: хочу'))).toBe(
            true,
        );
    });

    it('меньше трёх участников — отказ без изменений', async () => {
        const result = await SantaMode.handle(
            'draw',
            ctx({ participants: [participant('1'), participant('2')] }),
            {},
        );
        expect(result).toEqual({ reply: 'Для жеребьёвки нужно не меньше 3 участников, сейчас 2.' });
    });

    it('действия зависят от роли и статуса', () => {
        const me = participant('2');
        expect(SantaMode.actions(ctx({ me, isOwner: false })).map((a) => a.id)).toEqual(['wish']);
        expect(SantaMode.actions(ctx({ me: null })).map((a) => a.id)).toEqual(['draw', 'date']);
        const closed = { ...room, status: 'closed' as const };
        const drawn = { ...me, recipientId: '3' };
        expect(
            SantaMode.actions(ctx({ room: closed, me: drawn, isOwner: false })).map((a) => a.id),
        ).toEqual(['wish', 'whom', 'given', 'received']);
        expect(SantaMode.actions(ctx({ room: closed, me: null })).map((a) => a.id)).toEqual([
            'date',
            'handover',
            'finish',
        ]);
        const finished = { ...room, status: 'finished' as const };
        expect(SantaMode.actions(ctx({ room: finished, me: null })).map((a) => a.id)).toEqual([
            'handover',
        ]);
    });

    it('организатор переносит дату обмена, пока идёт набор', async () => {
        const result = await SantaMode.handle('date', ctx(), { answer: '2026-12-30' });
        expect(result.room).toEqual({ settings: { eventDate: '2026-12-30' } });
        expect(result.reply).toContain('30 декабря');
    });

    it('набор без даты обмена: через неделю подгон организатору — один раз', async () => {
        const noDate = { ...room, settings: { budget: 'до 1500 ₽' } };
        expect(SantaMode.schedule?.(ctx({ room: noDate }))).toBe('2026-11-08T00:00:00.000Z');
        const result = await SantaMode.onSchedule?.(ctx({ room: noDate }));
        expect(result?.ownerMessage?.text).toContain('в наборе уже больше недели');
        expect(result?.ownerMessage?.key).toBe('santa-nudge:room');
        expect(result?.room).toEqual({ settings: { nudged: '1' } });
        // С датой обмена не подгоняем, после подгона — тишина
        expect(SantaMode.schedule?.(ctx())).toBeNull();
        expect(
            SantaMode.schedule?.(ctx({ room: { ...noDate, settings: { nudged: '1' } } })),
        ).toBeNull();
    });

    it('клон игры: без фазовых флагов и без даты прошлого обмена — организатор задаст новую', () => {
        expect(
            SantaMode.cloneSettings?.({
                budget: 'до 1500 ₽',
                eventDate: '2026-12-27',
                reminded: '1',
                nudged: '1',
            }),
        ).toEqual({ budget: 'до 1500 ₽' });
    });

    it('напоминание: за 2 дня до обмена в 10:00 по времени комнаты, после обмена — нет', () => {
        const closed = { ...room, status: 'closed' as const };
        expect(SantaMode.schedule?.(ctx({ room: closed }))).toBe('2026-12-25T07:00:00.000Z');
        expect(
            SantaMode.schedule?.(
                ctx({ room: { ...closed, settings: { ...closed.settings, reminded: '1' } } }),
            ),
        ).toBeNull();
        expect(
            SantaMode.schedule?.(ctx({ room: closed, now: new Date('2026-12-28T00:00:00Z') })),
        ).toBeNull();
        expect(SantaMode.schedule?.(ctx())).toBeNull();
    });

    it('срок жизни: 30 дней после обмена или 90 дней после создания', () => {
        expect(SantaMode.expiresAt?.(room)).toBe('2027-01-26T23:59:59.000Z');
        expect(SantaMode.expiresAt?.({ ...room, settings: {} })).toBe('2027-01-30T00:00:00.000Z');
    });

    it('вручение подарков: отметки дарителя и получателя, сводка организатора', async () => {
        const closed = { ...room, status: 'closed' as const };
        const chain = [
            { ...participant('1'), recipientId: '2' },
            { ...participant('2'), recipientId: '3' },
            { ...participant('3'), recipientId: '1' },
        ];
        const base = ctx({ room: closed, participants: chain, me: chain[1] });
        // Даритель отмечает вручение, повторное нажатие снимает отметку
        const given = await SantaMode.handle('given', base, {});
        expect(given.marks).toEqual([{ participantId: '2', key: 'gift-given', value: '1' }]);
        const marks: IMark[] = [
            {
                id: '2:gift-given',
                roomId: 'room',
                participantId: '2',
                key: 'gift-given',
                value: '1',
                createdAt: '',
            },
            {
                id: '3:gift-received',
                roomId: 'room',
                participantId: '3',
                key: 'gift-received',
                value: '1',
                createdAt: '',
            },
        ];
        const marked = ctx({ room: closed, participants: chain, marks, me: chain[1] });
        expect(SantaMode.actions(marked).find((a) => a.id === 'given')?.title).toBe(
            'Отменить: я подарил',
        );
        expect((await SantaMode.handle('given', marked, {})).marks).toEqual([
            { participantId: '2', key: 'gift-given', value: null },
        ]);
        // Сводка организатора: статусы по каждому
        const summary = await SantaMode.handle(
            'handover',
            ctx({ room: closed, participants: chain, marks }),
            {},
        );
        expect(summary.reply).toContain('2 → 3 · подарок ✓ · получено ✓');
        expect(summary.reply).toContain('1 → 2 · подарок — · получено —');
    });

    it('уход подопечного: дарителю — уведомление с причиной', () => {
        const gone = participant('3');
        const giver = { ...participant('2'), recipientId: '3' };
        const result = SantaMode.onLeave?.(ctx({ participants: [giver, gone] }), gone, 'expel');
        expect(result?.messages).toEqual([
            {
                to: '2',
                text: '«Офис»: ваш подопечный 3 больше не участвует в игре. Напишите организатору.',
            },
        ]);
    });
});
