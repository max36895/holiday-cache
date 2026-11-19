import {
    isValidTimezone,
    normalizeTimezone,
    parseDate,
    parseDateTime,
    parseDayMonth,
} from './time';

/**
 * Тип ответа на вопрос мастера. Все ответы хранятся строками:
 * date — YYYY-MM-DD, daymonth — MM-DD, datetime — YYYY-MM-DDTHH:MM (местное время комнаты),
 * choice — value варианта, list — элементы через перевод строки.
 */
export type TQuestionType =
    'text' | 'number' | 'date' | 'daymonth' | 'datetime' | 'choice' | 'list' | 'timezone';

/** Вариант ответа на вопрос выбора. */
export interface IQuestionOption {
    value: string;
    title: string;
    /** Другие слова, которыми вариант можно написать или сказать */
    aliases?: readonly string[];
}

/** Вопрос мастера: при создании комнаты, при входе или для действия режима. */
export interface IQuestion {
    /** Ключ ответа в rooms.settings или participants.profile */
    key: string;
    prompt: string;
    type: TQuestionType;
    /** Подпись ответа в карточке комнаты: «Пожелание: книгу». Без подписи ответ не показывается */
    label?: string;
    /** Можно пропустить кнопкой [Пропустить]; ответ тогда — пустая строка */
    optional?: boolean;
    /** Подпись кнопки пропуска: «Без бюджета». По умолчанию — «Пропустить» */
    skipLabel?: string;
    /** text: максимальная длина */
    maxLength?: number;
    /** date и datetime: дата в прошлом отклоняется */
    notPast?: boolean;
    /** number: допустимый диапазон */
    min?: number;
    max?: number;
    /** choice: варианты */
    options?: readonly IQuestionOption[];
    /** list: вопрос для каждого элемента и сколько элементов нужно */
    item?: IQuestion;
    minItems?: number;
    maxItems?: number;
    /** Готовый ответ, который принимается кнопкой «Да, так» (имя из профиля) */
    suggestion?: string;
}

/** Ответ пользователя на текущий вопрос. */
export interface IWizardInput {
    text?: string;
    /** Нажатый вариант choice */
    option?: string;
    skip?: boolean;
    /** Принять suggestion */
    accept?: boolean;
    /** Закончить список */
    done?: boolean;
}

/** Результат разбора ответа. */
export type TWizardStep =
    | { kind: 'answer'; value: string }
    | { kind: 'more'; items: string[] }
    | { kind: 'retry'; error: string };

const TEXT_MAX = 300;

function retry(error: string): TWizardStep {
    return { kind: 'retry', error };
}

function parseText(question: IQuestion, text: string): TWizardStep {
    const max = question.maxLength ?? TEXT_MAX;
    const value = text.trim();
    if (value.length > max) {
        return retry(`Слишком длинно: не больше ${max} символов. Попробуйте ещё раз.`);
    }
    if (value) {
        return { kind: 'answer', value };
    }
    // Пустой текст: необязательный вопрос считается пропущенным,
    // обязательный — просим ответить словами, а не пугаем «слишком длинно»
    return question.optional
        ? { kind: 'answer', value: '' }
        : retry(`Нужно от 1 до ${max} символов. Попробуйте ещё раз.`);
}

function parseNumber(question: IQuestion, text: string): TWizardStep {
    const value = Number(text.replace(',', '.'));
    const min = question.min ?? -Infinity;
    const max = question.max ?? Infinity;
    if (text && Number.isInteger(value) && value >= min && value <= max) {
        return { kind: 'answer', value: String(value) };
    }
    return retry(`Нужно целое число от ${question.min ?? '…'} до ${question.max ?? '…'}.`);
}

function parseChoice(question: IQuestion, input: IWizardInput): TWizardStep {
    const text = input.text?.toLowerCase().replace(/[.,!]/g, '') ?? '';
    const option = question.options?.find(
        (o) =>
            o.value === input.option ||
            o.title.toLowerCase() === text ||
            (text && o.aliases?.includes(text)),
    );
    return option
        ? { kind: 'answer', value: option.value }
        : retry('Выберите один из вариантов: нажмите кнопку или скажите её название.');
}

/** Нажатый вариант — готовый ответ на вопрос любого типа: значение варианта разбирается как обычный ответ. */
function presetOf(question: IQuestion, input: IWizardInput): string {
    const preset = input.option
        ? question.options?.find((o) => o.value === input.option)?.value
        : undefined;
    return preset ?? input.text ?? '';
}

function parseDateQuestion(question: IQuestion, text: string, today: string): TWizardStep {
    const value = parseDate(text, today);
    if (value && question.notPast && value < today) {
        return retry('Эта дата уже прошла. Укажите будущую.');
    }
    return value
        ? { kind: 'answer', value }
        : // Время здесь не нужно: вопрос про день события, а не про час
          retry(
              'Не понял дату. Напишите день и месяц, например, «27 декабря» или «27.12» — без времени.',
          );
}

function parseDateTimeQuestion(
    question: IQuestion,
    text: string,
    today: string,
    now: string,
): TWizardStep {
    const value = parseDateTime(text, today);
    // Событие с точным временем должно быть в будущем целиком:
    // «сегодня 08:00» в полдень — уже прошедшее
    if (value && question.notPast && value <= now) {
        return retry('Это время уже прошло. Укажите будущие дату и время.');
    }
    return value
        ? { kind: 'answer', value }
        : retry(
              'Не понял дату и время. Напишите, например, «14 марта 19:00», «завтра в 9» или «в 19:00».',
          );
}

function parseSingle(
    question: IQuestion,
    input: IWizardInput,
    today: string,
    now: string,
): TWizardStep {
    const text = presetOf(question, input);
    switch (question.type) {
        case 'timezone': {
            const value = normalizeTimezone(
                question.options?.find(
                    (o) => o.value === input.option || o.title.toLowerCase() === text.toLowerCase(),
                )?.value ?? text,
            );
            return isValidTimezone(value)
                ? { kind: 'answer', value }
                : retry('Укажите часовой пояс IANA, например Europe/Moscow.');
        }
        case 'text':
            return parseText(question, text);
        case 'number':
            return parseNumber(question, text);
        case 'choice':
            return parseChoice(question, input);
        case 'date':
            return parseDateQuestion(question, text, today);
        case 'daymonth': {
            const value = parseDayMonth(text);
            return value
                ? { kind: 'answer', value }
                : retry('Не понял дату. Напишите день и месяц, например, «14 марта» или «14.03».');
        }
        case 'datetime':
            return parseDateTimeQuestion(question, text, today, now);
        case 'list':
            throw new Error('Список разбирается через answerList');
    }
}

function answerList(
    question: IQuestion,
    input: IWizardInput,
    items: string[],
    today: string,
    now: string,
): TWizardStep {
    const minItems = question.minItems ?? 1;
    if (input.done) {
        return items.length >= minItems
            ? { kind: 'answer', value: items.join('\n') }
            : retry(`Нужно хотя бы ${minItems}.`);
    }
    const item = parseSingle(
        question.item ?? { key: 'item', prompt: '', type: 'text' },
        input,
        today,
        now,
    );
    if (item.kind !== 'answer') {
        return item;
    }
    const next = [...items, item.value];
    return next.length >= (question.maxItems ?? Infinity)
        ? { kind: 'answer', value: next.join('\n') }
        : { kind: 'more', items: next };
}

/**
 * Разбирает ответ на вопрос мастера.
 *
 * @param question Вопрос
 * @param input Текст или нажатая кнопка
 * @param items Уже собранные элементы списка (для type: 'list')
 * @param today Сегодняшняя дата YYYY-MM-DD в поясе комнаты — для дат без года
 * @param now Местные дата и время YYYY-MM-DDTHH:MM — для datetime с notPast
 * @returns Принятый ответ, следующий элемент списка или ошибка с просьбой ответить ещё раз
 *
 * @example
 * ```ts
 * answerQuestion({ key: 'date', prompt: '', type: 'date' }, { text: '27.12' }, [], '2026-11-01', '2026-11-01T12:00');
 * // { kind: 'answer', value: '2026-12-27' }
 * ```
 */
export function answerQuestion(
    question: IQuestion,
    input: IWizardInput,
    items: readonly string[],
    today: string,
    now: string = `${today}T23:59`,
): TWizardStep {
    if (input.skip && question.optional) {
        return { kind: 'answer', value: '' };
    }
    if (input.accept && question.suggestion) {
        return { kind: 'answer', value: question.suggestion };
    }
    if (question.type !== 'list') {
        // «Да, так» и другие кнопки на вопросе, где им не место: не теряем вопрос,
        // а просим ответить как следует
        if (input.accept || input.done || (input.skip && !question.optional)) {
            return retry('Ответьте на вопрос текстом или кнопкой.');
        }
        return parseSingle(question, input, today, now);
    }
    return answerList(question, input, [...items], today, now);
}
