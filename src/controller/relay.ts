import { Bot } from 'umbot';
import { Text } from 'umbot/utils';
import { RoomError } from '../core/RoomError';
import { formatDateTime, localDateTime } from '../core/time';
import { T } from '../texts';
import { A, btn, IButton, packRows, readPayload } from '../ui';
import {
    backToRoom,
    command,
    dispatch,
    IDeps,
    MENU_BUTTON,
    reply,
    requireRoomId,
    TCtx,
    userOf,
} from './context';
import { startWizard } from './wizard';

/** Пагинация нужна и получателям, и очереди, и входящим: клавиатуры платформ ограничены. */
function pageItems<T>(
    items: T[],
    size: number,
    bc: TCtx,
    action: string,
    roomId: string,
    newest = false,
): { items: T[]; buttons: IButton[] } {
    const pages = Math.max(1, Math.ceil(items.length / size));
    const page = Math.max(0, Math.min(readPayload(bc)?.pg ?? 0, pages - 1));
    const start = newest ? Math.max(0, items.length - (page + 1) * size) : page * size;
    const end = newest ? items.length - page * size : start + size;
    const buttons: IButton[] = [];
    if (page > 0) {
        buttons.push(btn(newest ? 'Более поздние' : 'Назад', action, { r: roomId, pg: page - 1 }));
    }
    if (page < pages - 1) {
        buttons.push(btn(newest ? 'Более ранние' : 'Далее', action, { r: roomId, pg: page + 1 }));
    }
    return { items: items.slice(start, end), buttons };
}

async function showInbox(deps: IDeps, bc: TCtx): Promise<void> {
    const roomId = requireRoomId(bc);
    const incoming = await deps.relay.inbox(userOf(bc), roomId);
    const page = pageItems(incoming, 4, bc, A.inbox, roomId, true);
    const lines = [
        incoming.length
            ? 'Ваши входящие анонимные сообщения: на каждое можно ответить анонимно, пожаловаться или заблокировать автора.'
            : 'Входящих анонимных сообщений нет.',
    ];
    const buttons: IButton[] = [];
    const view = await deps.service.view(userOf(bc), roomId);
    const replies = view.mode.relayReplies?.(view.room) ?? true;
    const me = view.me;
    if (!incoming.length && me) {
        // Сообщения до срока скрыты: подсказываем, что они уже ждут, чтобы кнопка
        // «Входящие сообщения» не выглядела как «вам ничего не прислали»
        const pending = (await deps.service.store.relaysOf(roomId)).filter(
            (r) => r.toId === me.id && r.status === 'pending',
        );
        if (pending.length) {
            const at = pending.map((r) => r.deliverAt).sort()[0]!;
            const word = Text.getEnding(pending.length, ['сообщение', 'сообщения', 'сообщений']);
            const when = formatDateTime(localDateTime(new Date(at), view.room.timezone));
            lines[0] = `Вам уже отправлено ${pending.length} ${word} — откроются ${when}.`;
        }
    }
    for (const [i, message] of page.items.entries()) {
        const suffix = incoming.length > 1 ? ` ${i + 1}` : '';
        lines.push(`\n${suffix.trim()} «${message.text}»`);
        buttons.push(
            ...(replies ? [btn(`Ответить анонимно${suffix}`, A.reply, { x: message.id })] : []),
            btn(`Пожаловаться${suffix}`, A.report, { x: message.id }),
            btn(`Заблокировать${suffix}`, A.block, { x: message.id }),
        );
    }
    // Ряды навигации и «К игре» занимают своё место: кнопки сообщений паруем под остаток лимита
    const nav = packRows(buttons, 10 - page.buttons.length - 1);
    reply(bc, lines.join('\n'), [...nav, ...page.buttons, backToRoom(roomId)]);
}

function relayIdOf(bc: TCtx): string {
    const relayId = readPayload(bc)?.x;
    if (!relayId) {
        throw new RoomError('Сообщение не найдено.');
    }
    return relayId;
}

/** Исключение автора по жалобе: вопрос-подтверждение, затем результат. */
async function expelByComplaint(deps: IDeps, bc: TCtx, relayId: string): Promise<void> {
    const room = await deps.relay.reportedRoom(userOf(bc), relayId);
    // Исключение необратимо: подтверждение, как у выхода и удаления игры
    reply(
        bc,
        `Исключить автора из игры «${room.title}»? Он узнает, что больше не участвует, но не причину.`,
        [btn('Да, исключить', A.expelOk, { x: relayId }), backToRoom(room.id)],
    );
}

/** Кому написать: цель из кнопки, выбор из списка или объяснение, почему некому. */
async function chooseRelayTarget(deps: IDeps, bc: TCtx): Promise<void> {
    const { service, relay } = deps;
    const roomId = requireRoomId(bc);
    const view = await service.view(userOf(bc), roomId);
    const targets = relay.targets(view);
    const chosen = readPayload(bc)?.x;
    // Текст, набранный до выбора адресата, возвращается подсказкой мастера:
    // печатать его второй раз человеку не нужно
    const draft = bc.userData.relayDraft;
    delete bc.userData.relayDraft;
    const target = targets.length === 1 ? targets[0] : targets.find((p) => p.id === chosen);
    // Приём закрыт (срок валентинок и т.п.) — объясняем сроком, а не «участник недоступен»
    const deadline = view.mode.relayDeadline?.(view.room);
    const closed = deadline !== undefined && deadline <= view.now.toISOString();
    if (target) {
        await startWizard(deps, bc, {
            kind: 'relay',
            roomId,
            toId: target.id,
            ...(draft ? { draft } : {}),
        });
    } else if (closed) {
        reply(bc, 'Сейчас написать некому.', [backToRoom(roomId)]);
    } else if (chosen) {
        // Старая кнопка или попытка написать себе
        reply(bc, chosen === view.me?.id ? T.selfRelay : T.goneRelay, [backToRoom(roomId)]);
    } else if (targets.length) {
        const page = pageItems(targets, 6, bc, A.write, roomId);
        const buttons = page.items.map((p) => btn(p.name, A.write, { r: roomId, x: p.id }));
        const names = page.items.map((p) => p.name).join(', ');
        // Имена адресатов — в самом тексте: пользователь без экрана не видит кнопки
        reply(
            bc,
            `${T.chooseRelayTarget} Получатель не узнает, от кого оно. Скажите имя адресата: ${names}.`,
            [...buttons, ...page.buttons, backToRoom(roomId)],
        );
    } else {
        reply(bc, 'Сейчас написать некому.', [backToRoom(roomId)]);
    }
}

/** Недоставленные сообщения автора: каждое можно отменить до доставки. */
async function showOutbox(deps: IDeps, bc: TCtx): Promise<void> {
    const roomId = requireRoomId(bc);
    const pending = await deps.relay.outbox(userOf(bc), roomId);
    const page = pageItems(pending, 6, bc, A.outbox, roomId);
    const buttons = page.items.map((r) => btn(`Отменить: ${r.text}`, A.unsend, { x: r.id }));
    reply(bc, pending.length ? T.outbox : 'Недоставленных сообщений нет.', [
        ...buttons,
        ...page.buttons,
        backToRoom(roomId),
    ]);
}

/**
 * Регистрирует анонимную пересылку: написать, ответить, пожаловаться, заблокировать,
 * исключить автора по жалобе, отменить сообщение до доставки.
 *
 * @param bot Бот
 * @param deps Зависимости
 */
export function registerRelay(bot: Bot, deps: IDeps): void {
    const { relay } = deps;

    bot.addAction(
        A.write,
        command(async (bc) => {
            await chooseRelayTarget(deps, bc);
        }),
    );

    bot.addAction(
        A.reply,
        command(async (bc) => {
            // Проверка до мастера: иначе человек пишет ответ и теряет его
            // с обманчивой ошибкой на финише
            await relay.validateReply(userOf(bc), relayIdOf(bc));
            await startWizard(deps, bc, { kind: 'reply', relayId: relayIdOf(bc) });
        }),
    );

    bot.addAction(
        A.report,
        command(async (bc) => {
            dispatch(deps, await relay.report(userOf(bc), relayIdOf(bc)));
            reply(bc, T.reported, [MENU_BUTTON]);
        }),
    );

    bot.addAction(
        A.block,
        command(async (bc) => {
            await relay.block(userOf(bc), relayIdOf(bc));
            reply(bc, T.blocked, [MENU_BUTTON]);
        }),
    );

    bot.addAction(
        A.expel,
        command(async (bc) => {
            await expelByComplaint(deps, bc, relayIdOf(bc));
        }),
    );

    bot.addAction(
        A.expelOk,
        command(async (bc) => {
            dispatch(deps, await relay.expel(userOf(bc), relayIdOf(bc)));
            reply(bc, T.expelled, [MENU_BUTTON]);
        }),
    );

    bot.addAction(
        A.outbox,
        command(async (bc) => {
            await showOutbox(deps, bc);
        }),
    );

    // Входящие анонимные сообщения — в карточке: Алиса не умеет писать первой,
    // поэтому пуш ей не приходит вовсе
    bot.addAction(
        A.inbox,
        command((bc) => showInbox(deps, bc)),
    );

    bot.addAction(
        A.unsend,
        command(async (bc) => {
            await relay.cancel(userOf(bc), relayIdOf(bc));
            reply(bc, T.unsent, [MENU_BUTTON]);
        }),
    );
}
