import { Bot, FALLBACK_COMMAND } from 'umbot';
import { isCodeLike, parseCode } from '../core/codes';
import { formatDateTime, localDateTime, DEFAULT_TIMEZONE } from '../core/time';
import { IRoom } from '../core/types';
import { IMode } from '../modes/IMode';
import { T } from '../texts';
import { A, btn, buttonTitle, IButton, readPayload } from '../ui';
import {
    backToRoom,
    command,
    dispatch,
    IDeps,
    inputText,
    MENU_BUTTON,
    MENU_BUTTONS,
    reply,
    TCtx,
    userOf,
    voiceButton,
} from './context';
import { handleCode, joinRoom, replyCodeHint } from './join';
import { runModeAction } from './room';
import { renderRoom } from './view';
import { startWizard } from './wizard';

/** Игр в списке «Мои игры»: столько кнопок плюс «Меню» помещаются в лимиты всех платформ. */
const MY_ROOMS_LIMIT = 8;

/** Слова согласия и отказа на превью «Участвуете?» — у человека без экрана кнопок нет. */
const JOIN_YES = ['да', 'давай', 'участвую', 'ок', 'хочу'];
const JOIN_NO = ['нет', 'не участвую', 'не хочу'];

/** Нормализует фразу для сравнения с названием кнопки или игры. */
function normalizePhrase(text: string): string {
    return text
        .toLowerCase()
        .replace(/[?!.,]/g, '')
        .trim();
}

/**
 * Кнопки карточки игры, доступные голосом как текст: «входящие сообщения» должны
 * читаться и без открытой карточки, а не превращаться в черновик анонимки.
 * Названия синхронизированы с roomButtons() (view.ts); права проверяют обработчики.
 */
const CARD_TITLES: readonly { title: string; action: string }[] = [
    { title: 'Входящие сообщения', action: A.inbox },
    { title: 'Мои сообщения', action: A.outbox },
    { title: 'Участники', action: A.members },
    { title: 'Приглашение', action: A.invite },
    { title: 'Сыграть ещё раз', action: A.again },
];

/** Алиса перезапускает навык в старой сессии той же фразой: это запрос меню, а не болтовня. */
const SKILL_LAUNCH = /^(?:запусти|запустить|открой)\s+навык(?=\s|$)/i;

/**
 * Короткий статус для кнопки списка: подпись ограничена 40 символами, длинные
 * статусы режимов («жеребьёвка уже проведена») в неё не помещаются вместе с
 * названием. Полный статус виден в тексте списка и в карточке игры.
 */
function shortStatus(room: IRoom): string {
    return { open: 'набор', closed: 'закрыта', finished: 'завершена' }[room.status];
}

/** Полный статус для текстового списка «Мои игры». */
function statusLabel(room: IRoom, mode: IMode): string {
    if (room.status === 'finished') {
        return 'завершена';
    }
    return room.status === 'closed' ? mode.texts.closed.toLowerCase() : 'идёт набор';
}

function withPrivacy(deps: IDeps, text: string): string {
    const url = deps.settings.privacyUrl;
    return url ? `${text}\n\n${T.privacy(url)}` : text;
}

async function showMenu(deps: IDeps, bc: TCtx): Promise<void> {
    delete bc.userData.draft;
    delete bc.userData.voiceHistory;
    delete bc.userData.myRoomsHint;
    delete bc.userData.relayDraft;
    const buttons: IButton[] = [...MENU_BUTTONS];
    const currentId = bc.userData.currentRoomId;
    const current = currentId ? await deps.service.store.findRoom(currentId) : null;
    if (current) {
        buttons.unshift(btn(`Текущая игра: ${current.title}`, A.room, { r: current.id }));
    } else {
        delete bc.userData.currentRoomId;
    }
    // Названия режимов — одной строкой: полные описания игрок услышит на экране
    // выбора («Во что играем?»), чтобы читать одно и то же дважды не пришлось
    const titles = deps.service.modes
        .menu(deps.service.now(), DEFAULT_TIMEZONE)
        .map((m) => m.title)
        .join(', ');
    reply(
        bc,
        withPrivacy(
            deps,
            `Играем вместе: ${titles}. Создайте игру или войдите по коду из приглашения.`,
        ),
        buttons,
    );
}

/** Создание игры: меню режимов, если их больше одного, иначе сразу мастер. */
async function create(deps: IDeps, bc: TCtx): Promise<void> {
    await deps.service.assertCanCreate(userOf(bc));
    const modes = deps.service.modes.menu(deps.service.now(), DEFAULT_TIMEZONE);
    const chosen =
        modes.find((m) => m.id === readPayload(bc)?.m) ??
        (modes.length === 1 ? modes[0] : undefined);
    if (!chosen) {
        reply(bc, [T.chooseMode, ...modes.map((m) => `${m.title}: ${m.pitch}`)].join('\n'), [
            ...modes.map((m) => btn(m.title, A.create, { m: m.id })),
            MENU_BUTTON,
        ]);
        return;
    }
    await startWizard(deps, bc, { kind: 'create', mode: chosen.id });
}

/**
 * Текст, совпавший с названием кнопки действия режима в текущей игре, выполняет
 * это действие: так «кому я дарю» работает и голосом в Алисе. Карточечные кнопки
 * ядра («входящие сообщения») работают по тем же правилам.
 *
 * @returns true, если действие найдено и выполнено
 */
async function actionByTitle(deps: IDeps, bc: TCtx): Promise<boolean> {
    const roomId = bc.userData.currentRoomId;
    const room = roomId ? await deps.service.store.findRoom(roomId) : null;
    if (!room) {
        return false;
    }
    const said = normalizePhrase(bc.userCommand ?? '');
    const view = await deps.service.view(userOf(bc), room.id);
    const action = view.mode.actions(view).find((a) => normalizePhrase(a.title) === said);
    if (action) {
        await runModeAction(deps, bc, false, { roomId: room.id, actionId: action.id });
        return true;
    }
    const card = CARD_TITLES.find((b) => normalizePhrase(b.title) === said);
    if (!card) {
        return false;
    }
    // Тот же обработчик и те же проверки прав, что при нажатии кнопки
    const handler = bc.appContext.command.commands.get(card.action);
    if (!handler) {
        return false;
    }
    bc.payload = { action: card.action, r: room.id };
    await handler.cb(bc.userCommand ?? '', bc);
    return true;
}

/** «удалить мои данные» после подтверждения: стирает пользователя из всех игр. */
async function forgetAll(deps: IDeps, bc: TCtx): Promise<void> {
    const { deletedRooms, leftRooms, outgoing } = await deps.service.forgetUser(userOf(bc));
    dispatch(deps, outgoing);
    delete bc.userData.draft;
    delete bc.userData.currentRoomId;
    delete bc.userData.voiceHistory;
    delete bc.userData.myRoomsHint;
    reply(bc, T.forgotten(deletedRooms, leftRooms), [MENU_BUTTON]);
}

/**
 * Выбор игры из показанного списка: номером («2») или названием (целиком или
 * уникальное начало). true — игра открыта, запрос обработан. Открывается до
 * конца: иначе ответ соберётся раньше карточки и GameController.action()
 * подставит «не понял».
 */
async function selectFromMyRooms(deps: IDeps, bc: TCtx): Promise<boolean> {
    const hint = bc.userData.myRoomsHint;
    if (!hint?.length) {
        return false;
    }
    const text = inputText(bc);
    const number = /^\d{1,2}$/.exec(text);
    if (number) {
        const room = hint[Number(text) - 1];
        if (room) {
            await openMyRoom(deps, bc, room);
            return true;
        }
        return false;
    }
    const said = normalizePhrase(text);
    const exact = hint.filter((r) => normalizePhrase(r.title) === said);
    const found =
        exact.length === 1
            ? exact
            : exact.length === 0
              ? hint.filter((r) => normalizePhrase(r.title).startsWith(said) && said.length >= 3)
              : exact;
    if (found.length === 1) {
        await openMyRoom(deps, bc, found[0]!);
        return true;
    }
    return false;
}

/** Открывает выбранную из списка игру: подсказка больше не нужна. */
async function openMyRoom(
    deps: IDeps,
    bc: TCtx,
    room: { id: string; title: string },
): Promise<void> {
    delete bc.userData.myRoomsHint;
    await renderRoom(deps, bc, await deps.service.view(userOf(bc), room.id));
}

/**
 * «/start <код>», «меню», «привет» и перезапуск навыка. Код ищем во всей фразе:
 * «Привет. Код: K7M2QX» — это вход в игру, а не болтовня. Неразобранный код
 * объясняется, а не молча показывается меню — иначе человек решает, что
 * приглашение потерялось.
 */
function menuCommand(deps: IDeps, bc: TCtx): Promise<void> {
    const text = inputText(bc);
    const code = parseCode(text);
    if (code) {
        return handleCode(deps, bc, code);
    }
    if (isCodeLike(text)) {
        replyCodeHint(deps, bc, [MENU_BUTTON]);
        return Promise.resolve();
    }
    return showMenu(deps, bc);
}

async function showMyRooms(deps: IDeps, bc: TCtx): Promise<void> {
    const rooms = await deps.service.myRooms(userOf(bc));
    if (!rooms.length) {
        reply(bc, T.noRooms, MENU_BUTTONS);
        return;
    }
    const shown = rooms.slice(0, MY_ROOMS_LIMIT);
    const lines = [T.myRooms];
    const buttons = shown.map(({ room, isOwner }, index) => {
        const mode = deps.service.modes.get(room.mode);
        // Названия игр — в самом тексте: пользователь без экрана (Алиса на колонке,
        // скрытая клавиатура) видит список, а не только кнопки
        lines.push(
            `${index + 1}. ${room.title} — ${statusLabel(room, mode)}${isOwner ? ', вы организатор' : ''}`,
        );
        return btn(
            buttonTitle(`${room.title} · ${shortStatus(room)}${isOwner ? ' · организатор' : ''}`),
            A.room,
            { r: room.id },
        );
    });
    // Игры за лимитом клавиатур не пропадают молча: человек видит, сколько их
    if (rooms.length > MY_ROOMS_LIMIT) {
        lines[0] = `${T.myRooms} (последние ${MY_ROOMS_LIMIT} из ${rooms.length})`;
    }
    lines.push('', 'Скажите номер или название игры, чтобы открыть её.');
    reply(bc, lines.join('\n'), [...buttons, MENU_BUTTON]);
    rememberMyRooms(bc, shown);
}

/**
 * Номер или название игры текстом работает, пока не показан новый список или меню.
 * Отдельная функция: только синхронная запись в userData без await вокруг.
 */
function rememberMyRooms(bc: TCtx, shown: { room: IRoom }[]): void {
    bc.userData.myRoomsHint = shown.map(({ room }) => ({ id: room.id, title: room.title }));
}

/** Ответ на «как получить код» и другие фразы про код. */
const CODE_HELP_SLOTS = [
    'где взять код',
    'как получить код',
    'где получить код',
    'как узнать код',
    'где код',
    'как попасть',
    'как присоединиться',
    'как войти',
];
const CODE_HELP_TEXT = [
    'Код игры есть у организатора: когда он создаёт игру, бот присылает код и приглашение для участников.',
    'Если вас позвали в игру, попросите организатора переслать приглашение или просто назвать код — сам бот чужие коды не подсказывает. Пришлите эти 6 символов (например, K7M2QX) боту сообщением, ответьте на пару вопросов — и вы в игре.',
    'Если игру создавали вы, напишите «мои игры» и откройте нужную игру: код будет в карточке игры. Скопируйте его и передайте тем, кого хотите позвать.',
    'А если игры пока нет — создайте её, пройдите все шаги, и бот пришлёт вам код с приглашением.',
].join('\n');

export function registerMenu(bot: Bot, deps: IDeps): void {
    const showHelp = command((bc) => {
        reply(bc, withPrivacy(deps, T.help), MENU_BUTTONS);
    });
    bot.addAction(A.help, showHelp);
    bot.addCommand('help', ['помощь', '/help', 'что ты умеешь'], showHelp);

    bot.addCommand('get_code', CODE_HELP_SLOTS, (_, bc) => {
        bc.text = CODE_HELP_TEXT;
    });

    bot.addCommand(
        'forget',
        ['удалить мои данные'],
        command((bc) => {
            reply(bc, T.confirmForget, [btn('Да, удалить всё', A.forget), btn('Отмена', A.menu)]);
        }),
    );

    bot.addAction(
        A.forget,
        command((bc) => forgetAll(deps, bc)),
    );

    const createGame = command((bc) => create(deps, bc));
    bot.addAction(A.create, createGame);
    bot.addCommand('create', ['создать'], createGame);

    const myRooms = command((bc) => showMyRooms(deps, bc));
    bot.addAction(A.my, myRooms);
    bot.addCommand('my', ['мои игры'], myRooms);

    // «/start K7M2QX» — вход по ссылке t.me/<бот>?start=<код>
    const menu = command(async (bc) => menuCommand(deps, bc));
    bot.addAction(A.menu, menu);
    bot.addCommand('menu', ['/start', 'меню', 'начать', 'старт', 'привет', 'отмена'], menu);

    // MAX: «Начать» по ссылке max.ru/<бот>?start=<код> приходит событием с кодом в payload
    const onStart = command(async (bc) => {
        const start = typeof bc.payload === 'string' ? bc.payload : '';
        const code = start ? parseCode(start) : null;
        if (code) {
            await handleCode(deps, bc, code);
            return;
        }
        if (start && isCodeLike(start)) {
            reply(bc, T.codeHint, [MENU_BUTTON]);
            return;
        }
        await showMenu(deps, bc);
    });
    bot.addEvent('start', (bc: TCtx) => onStart('', bc));

    bot.addCommand(
        FALLBACK_COMMAND,
        [],
        command((bc) => handleUnknownInput(deps, bc)),
    );
}

/**
 * Любой текст, не совпавший ни с одной командой. Порядок попыток: голосовое
 * название кнопки → «да»/«нет» на превью → выбор игры из списка → название
 * режима → код игры → подсказка про код → перезапуск навыка → действие карточки
 * → объяснение, что текст не понял и что будет с анонимным сообщением.
 */
async function handleUnknownInput(deps: IDeps, bc: TCtx): Promise<void> {
    const text = inputText(bc);
    if (await voiceButton(bc)) {
        return;
    }
    // Превью «Участвуете?» ждёт кнопку, но человек без экрана отвечает «да»/«нет»
    const hint = bc.userData.joinHint;
    const said = normalizePhrase(bc.userCommand ?? '');
    if (hint && (JOIN_YES.includes(said) || JOIN_NO.includes(said))) {
        delete bc.userData.joinHint;
        if (JOIN_YES.includes(said)) {
            await joinRoom(deps, bc, hint.roomId);
        } else {
            await showMenu(deps, bc);
        }
        return;
    }
    const selected = await selectFromMyRooms(deps, bc);
    if (selected) {
        return;
    }
    const mode = deps.service.modes
        .menu(deps.service.now(), DEFAULT_TIMEZONE)
        .find((m) => m.title.toLowerCase() === text.toLowerCase());
    if (mode) {
        await deps.service.assertCanCreate(userOf(bc));
        await startWizard(deps, bc, { kind: 'create', mode: mode.id });
        return;
    }
    const code = parseCode(text);
    if (code) {
        await handleCode(deps, bc, code);
    } else if (isCodeLike(text)) {
        // Похоже на код, но в алфавите кода таких символов нет: подсказываем
        replyCodeHint(deps, bc, MENU_BUTTONS);
    } else if (SKILL_LAUNCH.test(text) || bc.messageId === 0 || !bc.userCommand) {
        await showMenu(deps, bc);
    } else if (!(await actionByTitle(deps, bc))) {
        await replyNotUnderstood(deps, bc);
    }
}

/**
 * Ответ на непонятную фразу. Если человек пишет в игру с анонимными сообщениями
 * («поздравь Катю», валентинка обычным сообщением), объясняем, почему сообщение
 * не ушло, а не молча показываем меню.
 */
async function replyNotUnderstood(deps: IDeps, bc: TCtx): Promise<void> {
    const current = bc.userData.currentRoomId;
    const text = inputText(bc);
    // Набранный текст сохраняется до решения по нему: выбор адресата вернёт его
    // подсказкой, а карточка игры или меню сотрут как «человек передумал».
    // Пишем до await'ов — выбор между ветками ещё не сделан, а текст уже есть
    bc.userData.relayDraft = text;
    if (current) {
        const relay = await relayState(deps, bc, current);
        if (relay === 'targets') {
            // Человек пишет анонимное сообщение обычным текстом. Один адресат —
            // предлагаем отправить текст как есть, несколько — просим выбрать адресата
            const view = await deps.service.view(userOf(bc), current);
            const targets = deps.relay.targets(view);
            if (targets.length === 1) {
                delete bc.userData.relayDraft;
                await startWizard(deps, bc, {
                    kind: 'relay',
                    roomId: current,
                    toId: targets[0]!.id,
                    draft: text,
                });
                return;
            }
            const buttons = targets.map((p) => btn(p.name, A.write, { r: current, x: p.id }));
            const names = targets.map((p) => p.name).join(', ');
            reply(
                bc,
                `Кому адресовать ваше сообщение? Получатель не узнает, от кого оно. Скажите имя адресата: ${names}.`,
                [...buttons, backToRoom(current)],
            );
            return;
        }
        if (relay) {
            // Черновик не использован: объяснение срока/состава — не форма отправки
            delete bc.userData.relayDraft;
            reply(bc, relay, [btn('Текущая игра', A.room, { r: current }), ...MENU_BUTTONS]);
            return;
        }
    }
    delete bc.userData.relayDraft;
    reply(
        bc,
        current ? T.notUnderstoodInGame : T.notUnderstood,
        current ? [btn('Текущая игра', A.room, { r: current }), ...MENU_BUTTONS] : MENU_BUTTONS,
    );
}

/**
 * Что произошло с анонимным сообщением, написанным обычным текстом: 'targets' —
 * сообщение можно отправить, строка — объяснение почему нельзя, null — причина
 * не в анонимных сообщениях, показываем обычное «не понял».
 */
async function relayState(
    deps: IDeps,
    bc: TCtx,
    roomId: string,
): Promise<'targets' | string | null> {
    const view = await deps.service.view(userOf(bc), roomId).catch(() => null);
    const me = view?.me;
    if (!view || !me || view.mode.relay === 'none') {
        return null;
    }
    const deadline = view.mode.relayDeadline?.(view.room);
    if (deadline !== undefined && deadline <= view.now.toISOString()) {
        const when = formatDateTime(localDateTime(new Date(deadline), view.room.timezone));
        return `Приём анонимных сообщений закрыт: срок доставки наступил ${when}. Читать доставленные — в карточке игры, кнопка «Входящие сообщения».`;
    }
    if (deps.relay.targets(view).length) {
        return 'targets';
    }
    const others = view.participants.filter((p) => p.userId && p.id !== me.id).length;
    if (others === 0) {
        return `В игре пока нет других участников, поэтому написать некому. Пришлите участникам код ${view.room.code} из приглашения.`;
    }
    if (view.room.status === 'open') {
        return 'Анонимные сообщения станут доступны после жеребьёвки. Сейчас откройте карточку игры кнопкой ниже — там жеребьёвка и другие действия.';
    }
    return 'Сейчас написать анонимно некому. Откройте карточку игры кнопкой ниже и посмотрите доступные действия.';
}
