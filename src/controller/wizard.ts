import { Bot } from 'umbot';
import { RELAY_MAX } from '../core/Relay';
import { DEFAULT_TIMEZONE, isValidTimezone, localDate, localDateTime } from '../core/time';
import { answerQuestion, IQuestion, IWizardInput } from '../core/Wizard';
import { participantLabel, T } from '../texts';
import { A, btn, IButton, readPayload } from '../ui';
import {
    backToRoom,
    dispatch,
    IDeps,
    inputText,
    IWizardDraft,
    MENU_BUTTON,
    profileName,
    reply,
    step,
    TCtx,
    TWizardTask,
    userOf,
} from './context';
import { renderCreated, renderOutcome, renderRoom } from './view';

const STEP = 'wizard';

const TITLE: IQuestion = { key: 'title', prompt: T.askTitle, type: 'text', maxLength: 60 };
const ROLE: IQuestion = {
    key: 'role',
    prompt: T.askRole,
    type: 'choice',
    options: [
        { value: 'play', title: 'Я участвую', aliases: ['участвую', 'играю', 'да'] },
        { value: 'org', title: 'Только организую', aliases: ['организую', 'организатор', 'нет'] },
    ],
};
const RELAY_TEXT: IQuestion = {
    key: 'text',
    prompt: T.askRelay,
    type: 'text',
    maxLength: RELAY_MAX,
};

/** Слова, которыми пользователь выходит из мастера: запрос уходит обычным командам. */
const ESCAPE_WORDS = ['меню', '/start', 'отмена', 'создать', 'мои игры'];
/** «Помощь» мастер не прерывает: справка показывается, вопрос повторяется. */
const HELP_WORDS = ['помощь', '/help', 'что ты умеешь'];
const SKIP_WORDS = ['пропустить', 'пропуск', 'нет'];
const YES_WORDS = ['да', 'да так', 'оставить'];
const DONE_WORDS = ['готово', 'всё', 'все'];
/** Кнопки самого мастера; любая другая кнопка прерывает его. */
const WIZARD_ACTIONS: readonly string[] = [A.option, A.skip, A.yes, A.done];
/**
 * Кнопки действий, которые во время мастера выполняются только случайно:
 * остался старый ответ, промах по чужой клавиатуре. Такие кнопки мастер
 * перехватывает и повторяет вопрос — введённое не пропадает. Сюда же кнопки
 * главного меню: «Создать игру» по промаху не должен молча стереть весь ввод.
 */
const DANGEROUS_ACTIONS: readonly string[] = [
    A.act,
    A.actOk,
    A.create,
    A.joinAsk,
    A.my,
    A.join,
    A.write,
    A.reply,
    A.leave,
    A.leaveOk,
    A.erase,
    A.eraseOk,
    A.kick,
    A.expel,
    A.again,
    A.unsend,
];

function nameQuestion(profileName: string | undefined): IQuestion {
    return {
        key: 'name',
        prompt: profileName ? T.askNameWithProfile(profileName) : T.askName,
        type: 'text',
        maxLength: 40,
        ...(profileName ? { suggestion: profileName } : {}),
    };
}

/**
 * Вопрос даты события, который клон обязан получить заново: у событийных режимов
 * (валентинки, встреча) дата обязательна, а дата прошлого события не переносится.
 */
async function againQuestion(deps: IDeps, roomId: string): Promise<IQuestion | null> {
    const room = await deps.service.store.findRoom(roomId);
    if (!room) {
        return null;
    }
    const question = deps.service.modes
        .get(room.mode)
        .createQuestions.find((q) => (q.key === 'eventAt' || q.key === 'eventDate') && !q.optional);
    return question ?? null;
}

/** Вопросы задачи. Для действия режима вопрос берётся заново — с проверкой прав. */
async function questionsOf(deps: IDeps, bc: TCtx, task: TWizardTask): Promise<IQuestion[]> {
    switch (task.kind) {
        case 'create':
            return [TITLE, ...deps.service.modes.get(task.mode).createQuestions, ROLE];
        case 'join': {
            const room = await deps.service.store.findRoom(task.roomId);
            const joinQuestions = room ? deps.service.modes.get(room.mode).joinQuestions : [];
            return [nameQuestion(task.profileName), ...joinQuestions];
        }
        case 'action': {
            const action = await deps.service.action(userOf(bc), task.roomId, task.action);
            return action.input ? [action.input] : [];
        }
        case 'again': {
            const question = await againQuestion(deps, task.roomId);
            return question ? [question] : [];
        }
        case 'relay':
            // Черновик из свободного текста предлагается как есть: «Да, так» отправит его
            return [
                task.draft && task.draft.length <= RELAY_MAX
                    ? { ...RELAY_TEXT, suggestion: task.draft }
                    : RELAY_TEXT,
            ];
        case 'reply':
            return [RELAY_TEXT];
    }
}

/** Куда вернуться по кнопке «Отмена». */
function cancelButton(task: TWizardTask): IButton {
    return task.kind === 'action' || task.kind === 'relay' || task.kind === 'again'
        ? btn('Отмена', A.room, { r: task.roomId })
        : btn('Отмена', A.menu);
}

function ask(bc: TCtx, draft: IWizardDraft, question: IQuestion, error?: string): void {
    const buttons: IButton[] = [
        ...(question.options ?? []).map((o) => btn(o.title, A.option, { x: o.value })),
        ...(question.suggestion ? [btn('Да, так', A.yes)] : []),
        ...(question.optional ? [btn(question.skipLabel ?? 'Пропустить', A.skip)] : []),
        ...(question.type === 'list' && draft.items.length >= (question.minItems ?? 1)
            ? [btn('Готово', A.done)]
            : []),
        cancelButton(draft.task),
    ];
    const progress = draft.items.length ? `Уже есть: ${draft.items.length}. ` : '';
    bc.userData.draft = draft;
    bc.thisIntentName = STEP;
    reply(bc, `${error ? `${error}\n` : ''}${progress}${question.prompt}`, buttons);
}

/**
 * Начинает мастер: задаёт первый вопрос или сразу завершает задачу без вопросов.
 *
 * @param deps Зависимости
 * @param bc Контроллер запроса
 * @param task Чем закончится мастер
 */
export async function startWizard(deps: IDeps, bc: TCtx, task: TWizardTask): Promise<void> {
    const draft: IWizardDraft = { task, index: 0, answers: {}, items: [] };
    const [first] = await questionsOf(deps, bc, task);
    if (first) {
        ask(bc, draft, first);
    } else {
        await finish(deps, bc, draft);
    }
}

/** Ответ пользователя: нажатая кнопка мастера или текст (с синонимами кнопок). */
function readInput(bc: TCtx, question: IQuestion): IWizardInput {
    const payload = readPayload(bc);
    if (payload) {
        return {
            ...(payload.action === A.option && payload.x ? { option: payload.x } : {}),
            skip: payload.action === A.skip,
            accept: payload.action === A.yes,
            done: payload.action === A.done,
        };
    }
    const text = inputText(bc);
    const command = (bc.userCommand ?? '').replace(/[.,!]/g, '').trim();
    return {
        text,
        skip: !!question.optional && SKIP_WORDS.includes(command),
        accept: !!question.suggestion && YES_WORDS.includes(command),
        done: question.type === 'list' && DONE_WORDS.includes(command),
    };
}

/** Кнопка или слово другого действия прерывают мастер. */
function isEscape(bc: TCtx): boolean {
    const payload = readPayload(bc);
    if (payload) {
        return !WIZARD_ACTIONS.includes(payload.action);
    }
    const command = bc.userCommand ?? '';
    return ESCAPE_WORDS.some((word) => command === word || command.startsWith(`${word} `));
}

async function timezoneFor(
    deps: IDeps,
    task: TWizardTask,
    answers: Record<string, string>,
): Promise<string> {
    const roomId = 'roomId' in task ? task.roomId : null;
    const room = roomId ? await deps.service.store.findRoom(roomId) : null;
    return (
        room?.timezone ??
        (answers.timezone && isValidTimezone(answers.timezone)
            ? answers.timezone
            : DEFAULT_TIMEZONE)
    );
}

async function todayFor(
    deps: IDeps,
    task: TWizardTask,
    answers: Record<string, string>,
): Promise<string> {
    return localDate(deps.service.now(), await timezoneFor(deps, task, answers));
}

/** Текущие местные дата и время комнаты — проверка notPast у datetime. */
async function nowFor(
    deps: IDeps,
    task: TWizardTask,
    answers: Record<string, string>,
): Promise<string> {
    return localDateTime(deps.service.now(), await timezoneFor(deps, task, answers));
}

async function finishCreate(
    deps: IDeps,
    bc: TCtx,
    task: Extract<TWizardTask, { kind: 'create' }>,
    answers: Record<string, string>,
): Promise<void> {
    const { title = '', role, ...settings } = answers;
    const mode = deps.service.modes.get(task.mode);
    const room = await deps.service.createRoom(userOf(bc), mode, title, {
        ...settings,
        ...(task.profileName ? { ownerName: task.profileName } : {}),
    });
    if (role === 'play') {
        await startWizard(deps, bc, {
            kind: 'join',
            roomId: room.id,
            ownerJoin: true,
            ...(task.profileName ? { profileName: task.profileName } : {}),
        });
        return;
    }
    await renderCreated(deps, bc, await deps.service.view(userOf(bc), room.id));
}

async function finishJoin(
    deps: IDeps,
    bc: TCtx,
    task: Extract<TWizardTask, { kind: 'join' }>,
    answers: Record<string, string>,
): Promise<void> {
    const user = userOf(bc);
    const { name = '', ...profile } = answers;
    const { room, participant, count } = await deps.service.join(user, task.roomId, name, profile);
    // Организатор-участник задал игровое имя позже создания комнаты:
    // в карточках «Организатор: …» должно быть то же имя
    if (task.ownerJoin) {
        await deps.service.renameOwner(task.roomId, participant.name);
    }
    const view = await deps.service.view(user, room.id);
    if (task.ownerJoin) {
        await renderCreated(deps, bc, view);
        return;
    }
    if (!view.isOwner) {
        const owner = { platform: room.ownerPlatform, userId: room.ownerUserId };
        const text = T.newMember(room.title, participantLabel(participant), count);
        deps.notifier.background(async () => {
            await deps.notifier.send(owner, text, [btn('Участники', A.members, { r: room.id })]);
        });
    }
    await renderRoom(deps, bc, view, view.mode.texts.joined);
}

/** Задача мастера выполнена: создаёт, добавляет, запускает действие или отправляет сообщение. */
async function finish(deps: IDeps, bc: TCtx, draft: IWizardDraft): Promise<void> {
    const { task, answers } = draft;
    delete bc.userData.draft;
    bc.thisIntentName = null;
    switch (task.kind) {
        case 'create':
            return finishCreate(deps, bc, task, answers);
        case 'join':
            return finishJoin(deps, bc, task, answers);
        case 'again': {
            const question = await againQuestion(deps, task.roomId);
            const extra: Record<string, string> = {};
            if (question) {
                const answer = answers[question.key];
                if (!answer) {
                    // Клон событийного режима без даты невозможен: переспрашиваем
                    return startWizard(deps, bc, task);
                }
                extra[question.key] = answer;
            }
            const room = await deps.service.cloneRoom(userOf(bc), task.roomId, extra);
            return renderCreated(
                deps,
                bc,
                await deps.service.view(userOf(bc), room.id),
                'Новая игра готова! Прежних участников позовите приглашением ниже.',
            );
        }
        case 'action': {
            // У действия режима не больше одного вопроса
            const [answer] = Object.values(answers);
            const input = {
                ...(task.option ? { option: task.option } : {}),
                ...(answer !== undefined ? { answer } : {}),
            };
            const outcome = await deps.service.runAction(
                userOf(bc),
                task.roomId,
                task.action,
                input,
            );
            return renderOutcome(deps, bc, outcome);
        }
        case 'relay': {
            const text = answers.text ?? '';
            const { outgoing, scheduled } = await deps.relay.send(
                userOf(bc),
                task.roomId,
                task.toId,
                text,
            );
            dispatch(deps, outgoing);
            return reply(bc, scheduled ? T.relayScheduled : T.relaySent, [backToRoom(task.roomId)]);
        }
        case 'reply': {
            dispatch(deps, await deps.relay.reply(userOf(bc), task.relayId, answers.text ?? ''));
            return reply(bc, T.relaySent, [MENU_BUTTON]);
        }
    }
}

/**
 * Регистрирует шаг мастера: все вопросы всех задач идут через один шаг umbot.
 *
 * @param bot Бот
 * @param deps Зависимости
 */
export function registerWizard(bot: Bot, deps: IDeps): void {
    bot.addStep(
        STEP,
        step(async (bc) => {
            const saved = bc.userData.draft;
            if (!saved) {
                return false;
            }
            // Имя организатора — из первого текстового ответа: у нажатия кнопки имени нет
            const name = profileName(bc);
            const draft =
                saved.task.kind === 'create' && !saved.task.profileName && name
                    ? { ...saved, task: { ...saved.task, profileName: name } }
                    : saved;
            const questions = await questionsOf(deps, bc, draft.task);
            const question = questions[draft.index];
            if (!question) {
                return false;
            }
            const payload = readPayload(bc);
            // Справка не прерывает мастер: показываем её вместе с текущим вопросом
            if (!payload && HELP_WORDS.includes((bc.userCommand ?? '').trim())) {
                ask(bc, draft, question, T.help);
                return;
            }
            // Кнопка «Помощь» из старого меню — то же, что текстовая помощь:
            // вопрос не теряется
            if (payload?.action === A.help) {
                ask(bc, draft, question, T.help);
                return;
            }
            // Кнопка действия поверх незаконченного мастера: почти наверняка случайная.
            // Повторяем вопрос — ход не теряется; уйти можно кнопкой «Отмена»
            if (payload?.action && DANGEROUS_ACTIONS.includes(payload.action)) {
                ask(
                    bc,
                    draft,
                    question,
                    'Сначала закончите заполнение: ответьте на вопрос или нажмите «Отмена».',
                );
                return;
            }
            if (isEscape(bc)) {
                return false;
            }
            const today = await todayFor(deps, draft.task, draft.answers);
            const now = await nowFor(deps, draft.task, draft.answers);
            const result = answerQuestion(
                question,
                readInput(bc, question),
                draft.items,
                today,
                now,
            );
            if (result.kind === 'retry') {
                ask(bc, draft, question, result.error);
            } else if (result.kind === 'more') {
                ask(bc, { ...draft, items: result.items }, question);
            } else {
                const next: IWizardDraft = {
                    ...draft,
                    index: draft.index + 1,
                    answers: { ...draft.answers, [question.key]: result.value },
                    items: [],
                };
                const nextQuestion = questions[next.index];
                if (nextQuestion) {
                    ask(bc, next, nextQuestion);
                } else {
                    await finish(deps, bc, next);
                }
            }
        }),
    );
}
