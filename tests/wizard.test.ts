import {
    addDays,
    formatDate,
    formatDateTime,
    localDate,
    parseDate,
    parseDateTime,
    parseDayMonth,
    zonedTime,
} from '../src/core/time';
import { answerQuestion, IQuestion } from '../src/core/Wizard';

const TODAY = '2026-11-01';

describe('даты', () => {
    it.each([
        ['27 декабря', '2026-12-27'],
        ['27 Декабря 2027', '2027-12-27'],
        ['5 мая', '2027-05-05'],
        ['8 марта', '2027-03-08'],
        ['27.12', '2026-12-27'],
        ['27.12.26', '2026-12-27'],
        ['2026-12-31', '2026-12-31'],
        ['1 ноября', '2026-11-01'],
    ])('parseDate(%s) → %s', (text, iso) => {
        expect(parseDate(text, TODAY)).toBe(iso);
    });

    it.each(['после праздников', '31.02', '32 декабря', '27 смартобря', '27.13'])(
        'parseDate(%s) → null',
        (text) => {
            expect(parseDate(text, TODAY)).toBeNull();
        },
    );

    it('день и месяц без года, 29 февраля допустимо', () => {
        expect(parseDayMonth('14 марта')).toBe('03-14');
        expect(parseDayMonth('29.02')).toBe('02-29');
        expect(parseDayMonth('30.02')).toBeNull();
        expect(parseDayMonth('14.03.1990')).toBeNull();
    });

    it('дата со временем', () => {
        expect(parseDateTime('14 марта 19:00', TODAY)).toBe('2027-03-14T19:00');
        expect(parseDateTime('14.03.2027 9.30', TODAY)).toBe('2027-03-14T09:30');
        expect(parseDateTime('14 марта', TODAY)).toBeNull();
        expect(parseDateTime('14 марта 25:00', TODAY)).toBeNull();
    });

    it('часовой пояс: местное время в момент UTC и обратно, в том числе на переходе на летнее время', () => {
        expect(zonedTime('2026-12-25', '10:00', 'Europe/Moscow')).toBe('2026-12-25T07:00:00.000Z');
        expect(zonedTime('2026-03-29', '10:00', 'Europe/Berlin')).toBe('2026-03-29T08:00:00.000Z');
        expect(zonedTime('2026-03-28', '10:00', 'Europe/Berlin')).toBe('2026-03-28T09:00:00.000Z');
        expect(localDate(new Date('2026-12-31T22:30:00Z'), 'Europe/Moscow')).toBe('2027-01-01');
        expect(addDays('2027-01-01', -2)).toBe('2026-12-30');
    });

    it('форматирование для людей', () => {
        expect(formatDate('2026-12-27')).toBe('27 декабря');
        expect(formatDate('03-14')).toBe('14 марта');
        expect(formatDateTime('2027-03-14T19:00')).toBe('14 марта в 19:00');
    });
});

describe('answerQuestion', () => {
    const text: IQuestion = { key: 'k', prompt: '', type: 'text', maxLength: 5 };

    it('текст: длина и пропуск необязательного', () => {
        expect(answerQuestion(text, { text: 'abc' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: 'abc',
        });
        expect(answerQuestion(text, { text: 'abcdef' }, [], TODAY).kind).toBe('retry');
        expect(answerQuestion(text, { skip: true }, [], TODAY).kind).toBe('retry');
        expect(answerQuestion({ ...text, optional: true }, { skip: true }, [], TODAY)).toEqual({
            kind: 'answer',
            value: '',
        });
    });

    it('подсказка принимается кнопкой «Да, так»', () => {
        const q: IQuestion = { ...text, suggestion: 'Аня' };
        expect(answerQuestion(q, { accept: true }, [], TODAY)).toEqual({
            kind: 'answer',
            value: 'Аня',
        });
    });

    it('число в диапазоне', () => {
        const q: IQuestion = { key: 'n', prompt: '', type: 'number', min: 1, max: 30 };
        expect(answerQuestion(q, { text: '3' }, [], TODAY)).toEqual({ kind: 'answer', value: '3' });
        expect(answerQuestion(q, { text: '31' }, [], TODAY).kind).toBe('retry');
        expect(answerQuestion(q, { text: '2.5' }, [], TODAY).kind).toBe('retry');
    });

    it('выбор: кнопкой, названием или синонимом', () => {
        const q: IQuestion = {
            key: 'c',
            prompt: '',
            type: 'choice',
            options: [{ value: 'a', title: 'Команда А', aliases: ['первая'] }],
        };
        expect(answerQuestion(q, { option: 'a' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: 'a',
        });
        expect(answerQuestion(q, { text: 'команда а' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: 'a',
        });
        expect(answerQuestion(q, { text: 'Первая!' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: 'a',
        });
        expect(answerQuestion(q, { text: 'вторая' }, [], TODAY).kind).toBe('retry');
    });

    it('даты разных типов', () => {
        const date: IQuestion = { key: 'd', prompt: '', type: 'date' };
        expect(answerQuestion(date, { text: '27.12' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: '2026-12-27',
        });
        expect(
            answerQuestion({ ...date, type: 'daymonth' }, { text: '14 марта' }, [], TODAY),
        ).toEqual({
            kind: 'answer',
            value: '03-14',
        });
        expect(
            answerQuestion({ ...date, type: 'datetime' }, { text: 'завтра' }, [], TODAY).kind,
        ).toBe('retry');
    });

    it('notPast отклоняет прошлое с объяснением', () => {
        const date: IQuestion = { key: 'd', prompt: '', type: 'date', notPast: true };
        const pastDate = answerQuestion(date, { text: '27.10.2026' }, [], TODAY);
        expect(pastDate).toEqual({ kind: 'retry', error: 'Эта дата уже прошла. Укажите будущую.' });
        const dateTime: IQuestion = { key: 'at', prompt: '', type: 'datetime', notPast: true };
        expect(answerQuestion(dateTime, { text: '31.10.2026 10:00' }, [], TODAY)).toEqual({
            kind: 'retry',
            error: 'Это время уже прошло. Укажите будущие дату и время.',
        });
    });

    it('регрессия: пресет-кнопка отвечает на вопрос любого типа, не только choice', () => {
        // Взнос встречи: тип number, кнопка «500 рублей» подставляет значение
        const number: IQuestion = {
            key: 'contribution',
            prompt: '',
            type: 'number',
            min: 1,
            max: 1_000_000,
            options: [{ title: '500 рублей', value: '500' }],
        };
        expect(answerQuestion(number, { option: '500' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: '500',
        });
        expect(answerQuestion(number, { text: 'минус сто' }, [], TODAY)).toEqual({
            kind: 'retry',
            error: 'Нужно целое число от 1 до 1000000.',
        });
        // Валентинки: кнопка «13 февраля в 18:00» подставляет дату-время
        const dateTime: IQuestion = {
            key: 'eventAt',
            prompt: '',
            type: 'datetime',
            notPast: true,
            options: [{ title: '13 февраля в 18:00', value: '13 февраля 18:00' }],
        };
        expect(answerQuestion(dateTime, { option: '13 февраля 18:00' }, [], TODAY)).toEqual({
            kind: 'answer',
            value: '2027-02-13T18:00',
        });
    });

    it('список: элементы по одному, «Готово» не раньше минимума, на максимуме — сам', () => {
        const q: IQuestion = {
            key: 'l',
            prompt: '',
            type: 'list',
            item: { key: 'i', prompt: '', type: 'datetime' },
            minItems: 2,
            maxItems: 3,
        };
        expect(answerQuestion(q, { text: '14.03 19:00' }, [], TODAY)).toEqual({
            kind: 'more',
            items: ['2027-03-14T19:00'],
        });
        expect(answerQuestion(q, { done: true }, ['2027-03-14T19:00'], TODAY).kind).toBe('retry');
        expect(answerQuestion(q, { text: 'не дата' }, ['x'], TODAY).kind).toBe('retry');
        expect(answerQuestion(q, { text: '15.03 19:00' }, ['a', 'b'], TODAY)).toEqual({
            kind: 'answer',
            value: 'a\nb\n2027-03-15T19:00',
        });
        expect(answerQuestion(q, { done: true }, ['a', 'b'], TODAY)).toEqual({
            kind: 'answer',
            value: 'a\nb',
        });
    });
});
