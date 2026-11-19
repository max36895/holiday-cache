import { IMode, IModeContext, IModeResult } from '../IMode';
import { IQuestion } from '../../core/Wizard';
import { SantaMode } from '../santa/SantaMode';

/** Меняем только служебный текст. Значения пользователя скрыты на время форматирования. */
function adapt(ctx: IModeContext): {
    ctx: IModeContext;
    text: (value: string) => string;
    result: (value: IModeResult) => IModeResult;
    hide: (value: string) => string;
} {
    const values: string[] = [];
    const hide = (value: string): string => {
        values.push(value);
        return `\uE000${values.length - 1}\uE000`;
    };
    const profile = (data: Record<string, string>): Record<string, string> =>
        Object.fromEntries(
            Object.entries(data).map(([key, value]) => [key, value ? hide(value) : value]),
        );
    const participants = ctx.participants.map((p) => ({
        ...p,
        name: hide(p.name),
        profile: profile(p.profile),
    }));
    const room = {
        ...ctx.room,
        title: hide(ctx.room.title),
        settings: {
            ...ctx.room.settings,
            ...(ctx.room.settings.budget ? { budget: hide(ctx.room.settings.budget) } : {}),
            ...(ctx.room.settings.ownerName
                ? { ownerName: hide(ctx.room.settings.ownerName) }
                : {}),
        },
    };
    const text = (value: string): string =>
        value
            // Сначала фразы с «Ваш»: общая замена съела бы заглавную букву
            .replaceAll('Ваш Тайный Санта', 'Ваш тайный даритель')
            .replaceAll('ваш Тайный Санта', 'ваш тайный даритель')
            .replaceAll('Тайный Санта', 'тайный даритель')
            .replaceAll('Тайного Санту', 'тайного дарителя')
            .replaceAll('без Санты', 'без дарителя')
            .replaceAll('🎅', '🎁')
            .replaceAll('🎄', '🎁')
            .replace(/\uE000(\d+)\uE000/g, (_, index: string) => values[Number(index)] ?? '');
    const result = (res: IModeResult): IModeResult => ({
        ...res,
        ...(res.reply ? { reply: text(res.reply) } : {}),
        ...(res.participants
            ? {
                  participants: res.participants.map((p) => ({
                      ...p,
                      ...(p.profile
                          ? {
                                profile: Object.fromEntries(
                                    Object.entries(p.profile).map(([key, value]) => [
                                        key,
                                        text(value),
                                    ]),
                                ),
                            }
                          : {}),
                  })),
              }
            : {}),
        ...(res.messages
            ? { messages: res.messages.map((m) => ({ ...m, text: text(m.text) })) }
            : {}),
        ...(res.ownerMessage
            ? { ownerMessage: { ...res.ownerMessage, text: text(res.ownerMessage.text) } }
            : {}),
    });
    return {
        ctx: {
            ...ctx,
            room,
            participants,
            me: participants.find((p) => p.id === ctx.me?.id) ?? null,
        },
        text,
        result,
        hide,
    };
}

/** Повод дарения: то, чем «Тайный даритель» отличается от новогоднего Санты. */
const OCCASION: IQuestion = {
    key: 'occasion',
    prompt: 'Какой повод? Например: «8 марта» или «день рождения».',
    type: 'text',
    optional: true,
    skipLabel: 'Без повода',
    maxLength: 60,
};

export const GiftMode: IMode = {
    ...SantaMode,
    id: 'gift',
    title: 'Тайный даритель',
    pitch: 'Тайный даритель — случайные подопечные и подарки к любому празднику: не только к Новому году. Для жеребьёвки нужно минимум три участника.',
    season: undefined,
    createQuestions: [
        SantaMode.createQuestions[0]!,
        OCCASION,
        {
            ...SantaMode.createQuestions[1]!,
            prompt: 'Когда вручать подарки? Например: 14 марта.',
            options: undefined,
        },
    ],
    describe(room) {
        const adapter = adapt({
            room,
            participants: [],
            marks: [],
            me: null,
            isOwner: false,
            now: new Date(),
        });
        const [head, ...rest] = adapter
            .text(SantaMode.describe(adapter.ctx.room))
            .replace('тайный даритель «', 'Тайный даритель «')
            .split('\n');
        return [
            head,
            ...(room.settings.occasion ? [`Повод: ${room.settings.occasion}`] : []),
            ...rest,
        ].join('\n');
    },
    actions(ctx) {
        return SantaMode.actions(ctx).map((a) =>
            a.id === 'date'
                ? {
                      ...a,
                      input: a.input
                          ? { ...a.input, prompt: 'Когда вручать подарки? Например: 14 марта.' }
                          : undefined,
                  }
                : a.id === 'handover' && ctx.room.status !== 'finished'
                  ? { ...a, title: 'Состояние подарков' }
                  : a,
        );
    },
    async handle(action, ctx, input) {
        // До завершения даже организатор видит только отметки, без раскрытия пар.
        if (action === 'handover' && ctx.room.status !== 'finished') {
            return {
                reply: ctx.participants
                    .filter((p) => p.userId)
                    .map((p) => {
                        const marked = (key: string): string =>
                            ctx.marks.some((m) => m.participantId === p.id && m.key === key)
                                ? 'да'
                                : 'нет';
                        return `${p.name}: подарил — ${marked('gift-given')}, получил — ${marked('gift-received')}`;
                    })
                    .join('\n'),
            };
        }
        const adapter = adapt(ctx);
        const res = await SantaMode.handle(
            action,
            adapter.ctx,
            action === 'wish' && input.answer
                ? { ...input, answer: adapter.hide(input.answer) }
                : input,
        );
        return adapter.result(res);
    },
    async onSchedule(ctx) {
        const adapter = adapt(ctx);
        return adapter.result(await SantaMode.onSchedule!(adapter.ctx));
    },
    onLeave(ctx, gone, reason) {
        const adapter = adapt(ctx);
        return adapter.result(
            SantaMode.onLeave!(adapter.ctx, { ...gone, name: adapter.hide(gone.name) }, reason),
        );
    },
};
