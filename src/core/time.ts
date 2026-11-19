/** Часовой пояс комнаты по умолчанию. */
export const DEFAULT_TIMEZONE = 'Europe/Moscow';

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_PREFIXES = [
    'янв',
    'фев',
    'мар',
    'апр',
    'ма',
    'июн',
    'июл',
    'авг',
    'сен',
    'окт',
    'ноя',
    'дек',
];
const MONTH_NAMES = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = /^\d{1,2}$/;
const YEAR = /^(\d{2}|\d{4})$/;
// Минуты необязательны: «завтра в 9» так же правдоподобен, как «завтра в 9:00».
// Два шаблона вместо одного с группой-опцией — так проще и безопаснее для ReDoS.
// Время через дефис («19-30») приводится к двоеточию до них
const TIME = /(?:\sв\s+|\s)(\d{1,2})[:.](\d{2})$/i;
const TIME_HOURS = /(?:\sв\s+|\s)(\d{1,2})$/i;

/**
 * Проверяет имя часового пояса IANA.
 *
 * @param timezone Например, Europe/Moscow
 * @returns true, если пояс известен среде выполнения
 */
export function isValidTimezone(timezone: string): boolean {
    try {
        new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

/** Города, чьи названия голосом приходят кириллицей вместо IANA-имени. */
const CITY_ZONES: Readonly<Record<string, string>> = {
    москва: 'Europe/Moscow',
    мск: 'Europe/Moscow',
    новосибирск: 'Asia/Novosibirsk',
    нск: 'Asia/Novosibirsk',
    калининград: 'Europe/Kaliningrad',
    екатеринбург: 'Asia/Yekaterinburg',
};

/**
 * Приводит пояс к IANA, если человек ответил кириллицей: «Европа/Москва» или
 * просто «Москва». Латинские имена проходит насквозь.
 *
 * @param text Ответ пользователя на вопрос о поясе
 * @returns IANA-имя, если удалось распознать, иначе ответ как есть
 */
export function normalizeTimezone(text: string): string {
    const value = text.trim().toLowerCase();
    for (const [city, zone] of Object.entries(CITY_ZONES)) {
        if (value.includes(city)) {
            return zone;
        }
    }
    return text.trim();
}

/** Местные дата и время момента date в поясе timezone как поля UTC. */
function wallClock(date: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(date);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
    );
}

/**
 * Местная дата в поясе комнаты.
 *
 * @param now Момент времени
 * @param timezone Часовой пояс
 * @returns Дата YYYY-MM-DD
 */
export function localDate(now: Date, timezone: string): string {
    return new Date(wallClock(now, timezone)).toISOString().slice(0, 10);
}

/**
 * Местные дата и время в поясе комнаты, с точностью до минуты.
 *
 * @param now Момент времени
 * @param timezone Часовой пояс
 * @returns «YYYY-MM-DDTHH:MM»
 */
export function localDateTime(now: Date, timezone: string): string {
    return new Date(wallClock(now, timezone)).toISOString().slice(0, 16);
}

/**
 * Момент, когда в поясе timezone наступят дата date и время time.
 * Смещение пояса уточняется вторым проходом: на переходе на летнее время оно меняется.
 *
 * @param date Дата YYYY-MM-DD
 * @param time Время HH:MM
 * @param timezone Часовой пояс
 * @returns Момент времени в ISO
 */
export function zonedTime(date: string, time: string, timezone: string): string {
    const wall = Date.parse(`${date}T${time}:00Z`);
    let guess = wall;
    for (let i = 0; i < 2; i++) {
        guess = wall - (wallClock(new Date(guess), timezone) - guess);
    }
    return new Date(guess).toISOString();
}

/**
 * Сдвигает дату на n дней.
 *
 * @param date Дата YYYY-MM-DD
 * @param days Сколько дней прибавить (можно отрицательное)
 * @returns Дата YYYY-MM-DD
 */
export function addDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function toIso(year: number, month: number, day: number): string | null {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }
    return date.toISOString().slice(0, 10);
}

function monthOf(part: string): number | null {
    if (DAY.test(part)) {
        const month = Number(part);
        return month >= 1 && month <= 12 ? month : null;
    }
    // «ма» — май/мая: март отбирается раньше по «мар»
    const index = MONTH_PREFIXES.findIndex((prefix) => part.startsWith(prefix));
    return index === -1 ? null : index + 1;
}

/** День, месяц и необязательный год: «27 декабря», «27.12», «27.12.2026». */
function dayMonthYear(text: string): { day: number; month: number; year?: string } | null {
    // «11марта» — человек написал день и месяц слитно; отделяем цифры от букв
    const value = text
        .trim()
        .toLowerCase()
        .replace(/(\d)(?=[а-яё])/g, '$1 ');
    const [day, monthPart, yearPart, ...rest] = value.includes('.')
        ? value.split('.')
        : value.includes('/')
          ? value.split('/')
          : value.split(/\s+/);
    if (!day || !monthPart || rest.length || !DAY.test(day)) {
        return null;
    }
    const month = monthOf(monthPart);
    if (month === null) {
        return null;
    }
    return yearPart === undefined
        ? { day: Number(day), month }
        : { day: Number(day), month, year: yearPart };
}

/** «сегодня» или «завтра» в начале ответа: сдвиг относительно today. */
function relativeDay(text: string, today: string): { date: string; rest: string } | null {
    // \b в JS не считает кириллицу словом: граница только через lookahead
    const match = /^(сегодня|завтра)(?=\s|$)\s*/i.exec(text.trim());
    if (!match) {
        return null;
    }
    return {
        date: match[1]!.toLowerCase() === 'завтра' ? addDays(today, 1) : today,
        rest: text.trim().slice(match[0].length).trim().replace(/^в\s+/i, ''),
    };
}

/**
 * Разбирает дату, записанную человеком: «27 декабря», «27.12», «27.12.2026», «2026-12-27»,
 * а также «сегодня» и «завтра». Без года берётся ближайшая такая дата не раньше today.
 *
 * @param text Ответ пользователя
 * @param today Сегодняшняя дата YYYY-MM-DD в поясе комнаты
 * @returns Дата YYYY-MM-DD или null, если разобрать не удалось
 *
 * @example
 * ```ts
 * parseDate('27 декабря', '2026-11-01'); // '2026-12-27'
 * ```
 */
export function parseDate(text: string, today: string): string | null {
    const relative = relativeDay(text, today);
    if (relative) {
        return relative.rest ? null : relative.date;
    }
    const iso = ISO_DATE.exec(text.trim());
    if (iso) {
        return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    }
    const parsed = dayMonthYear(text);
    if (!parsed) {
        return null;
    }
    if (parsed.year !== undefined) {
        if (!YEAR.test(parsed.year)) {
            return null;
        }
        const year = Number(parsed.year.length === 2 ? `20${parsed.year}` : parsed.year);
        return toIso(year, parsed.month, parsed.day);
    }
    const thisYear = Number(today.slice(0, 4));
    const candidate = toIso(thisYear, parsed.month, parsed.day);
    if (candidate && candidate >= today) {
        return candidate;
    }
    return toIso(thisYear + 1, parsed.month, parsed.day);
}

/**
 * Разбирает день и месяц без года: «14 марта», «14.03». 29 февраля допустимо.
 *
 * @param text Ответ пользователя
 * @returns MM-DD или null
 */
export function parseDayMonth(text: string): string | null {
    const parsed = dayMonthYear(text);
    // Високосный год проверки: 29 февраля — корректная дата рождения
    if (!parsed || parsed.year !== undefined || !toIso(2024, parsed.month, parsed.day)) {
        return null;
    }
    return `${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
}

/**
 * Разбирает дату со временем: «14 марта 19:00», «14.03 19:00», «14.03.2027 19.30»,
 * «11/03 19-30», а также «сегодня в 22:00», «завтра 9:00» и «в 19:00» — без даты
 * подразумевается сегодня (прошедшее сегодня время отсеет notPast).
 *
 * @param text Ответ пользователя
 * @param today Сегодняшняя дата YYYY-MM-DD в поясе комнаты
 * @returns Местные дата и время YYYY-MM-DDTHH:MM или null
 */
export function parseDateTime(text: string, today: string): string | null {
    // Время через дефис («19-30») — то же, что через двоеточие
    let value = text.trim().replace(/(\d{1,2})-(\d{2})$/, '$1:$2');
    // Голое «19:00» — сегодня в это время: подставляем дату прямо в общий шаблон
    if (/^\d{1,2}[:.]\d{2}$/.test(value)) {
        value = `${today} ${value}`;
    }
    const relative = relativeDay(value, today);
    if (relative) {
        if (!relative.rest) {
            return null;
        }
        value = `${relative.date} ${relative.rest}`;
    }

    const time = TIME.exec(value) ?? TIME_HOURS.exec(value);
    if (!time) {
        return null;
    }
    const hours = Number(time[1]);
    const minutes = Number(time[2] ?? 0);
    // «в» перед временем отбрасываем: «14 марта в 19:00» и голое «в 19:00»
    const datePart = value.slice(0, time.index).replace(/\s*в\s*$/i, '');
    const date = datePart ? parseDate(datePart, today) : today;
    if (!date || hours > 23 || minutes > 59) {
        return null;
    }
    return `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Дата для людей: «27 декабря».
 *
 * @param date Дата YYYY-MM-DD или MM-DD
 * @returns День и месяц словами
 */
export function formatDate(date: string): string {
    const [month, day] = date.slice(-5).split('-').map(Number);
    return `${day} ${MONTH_NAMES[month - 1]}`;
}

/**
 * Дата и время для людей: «14 марта в 19:00».
 *
 * @param dateTime Местные дата и время YYYY-MM-DDTHH:MM
 * @returns Текст
 */
export function formatDateTime(dateTime: string): string {
    return `${formatDate(dateTime.slice(0, 10))} в ${dateTime.slice(11, 16)}`;
}
